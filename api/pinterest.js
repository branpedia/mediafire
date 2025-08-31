// api/pinterest.js
import axios from 'axios';
import cheerio from 'cheerio';
import cloudscraper from 'cloudscraper';

// Set untuk mencegah eksekusi dobel
const activeRequests = new Set();

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { url, retry = 0 } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL parameter is required' });
  }

  // Cek apakah request ini sedang diproses
  const requestId = `${url}-${Date.now()}`;
  if (activeRequests.has(requestId)) {
    return res.status(429).json({ success: false, error: 'Request is being processed' });
  }

  activeRequests.add(requestId);

  try {
    // Validate Pinterest URL
    if (!url.includes('pinterest.com') && !url.includes('pin.it')) {
      return res.status(400).json({ success: false, error: 'Invalid Pinterest URL' });
    }

    let pinterestUrl = url;

    // Step 1: Resolve shortlink jika menggunakan pin.it
    if (pinterestUrl.includes('pin.it')) {
      try {
        const response = await axios.get(pinterestUrl, {
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400,
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        }).catch(e => e.response || e);

        if (response.headers && response.headers.location) {
          pinterestUrl = response.headers.location;
        }
      } catch (error) {
        console.error('Error resolving shortlink:', error);
        // Lanjutkan dengan URL asli meskipun gagal resolve
      }
    }

    // Step 2: Scrape dari savepin.app
    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(pinterestUrl)}&lang=en&type=redirect`;
    
    let html;
    try {
      // Coba dengan cloudscraper dulu untuk menghindari anti-bot
      html = await cloudscraper.get(apiUrl);
    } catch (error) {
      console.log('Cloudscraper failed, trying with axios...');
      // Fallback ke axios jika cloudscraper gagal
      const response = await axios.get(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 15000
      });
      html = response.data;
    }

    const $ = cheerio.load(html);
    
    // Ekstrak URL media dari tabel
    const extractMediaUrl = (el) => {
      const href = $(el).attr('href');
      if (!href) return null;
      
      // Handle kedua format URL yang mungkin
      if (href.includes('force-save.php?url=')) {
        const match = href.match(/url=([^&]+)/);
        return match ? decodeURIComponent(match[1]) : null;
      }
      
      return href;
    };

    // Cari semua baris tabel yang berisi media
    const mediaItems = [];
    
    // Cari video
    $('a[href*=".mp4"]').each((i, el) => {
      const mediaUrl = extractMediaUrl(el);
      if (mediaUrl) {
        // Cari informasi kualitas
        const row = $(el).closest('tr');
        const quality = row.find('.video-quality').text() || 'Unknown';
        const format = row.find('td').eq(1).text() || 'MP4';
        const size = row.find('td').eq(2).text() || 'Unknown';
        
        mediaItems.push({
          quality,
          format,
          size,
          url: mediaUrl,
          type: 'video'
        });
      }
    });

    // Cari gambar
    $('a[href*=".jpg"], a[href*=".jpeg"], a[href*=".png"]').each((i, el) => {
      const mediaUrl = extractMediaUrl(el);
      if (mediaUrl) {
        // Cari informasi kualitas
        const row = $(el).closest('tr');
        const quality = row.find('td').eq(0).text() || 'Unknown';
        const format = row.find('td').eq(1).text() || 'JPG';
        const size = row.find('td').eq(2).text() || 'Unknown';
        
        // Skip jika ini adalah thumbnail dari video
        if (!quality.includes('Thumbnail')) {
          mediaItems.push({
            quality,
            format,
            size,
            url: mediaUrl,
            type: 'image'
          });
        }
      }
    });

    // Jika tidak ada media yang ditemukan, coba metode alternatif
    if (mediaItems.length === 0) {
      // Cari semua link download
      $('a[href*="force-save.php"]').each((i, el) => {
        const mediaUrl = extractMediaUrl(el);
        if (mediaUrl) {
          const isVideo = mediaUrl.includes('.mp4');
          const isImage = mediaUrl.includes('.jpg') || mediaUrl.includes('.jpeg') || mediaUrl.includes('.png');
          
          if (isVideo || isImage) {
            // Cari informasi kualitas dari teks di sekitar link
            const row = $(el).closest('tr');
            let quality = 'Unknown';
            let format = isVideo ? 'MP4' : 'JPG';
            let size = 'Unknown';
            
            if (row.length) {
              quality = row.find('td').eq(0).text() || 'Unknown';
              format = row.find('td').eq(1).text() || format;
              size = row.find('td').eq(2).text() || 'Unknown';
            }
            
            mediaItems.push({
              quality,
              format,
              size,
              url: mediaUrl,
              type: isVideo ? 'video' : 'image'
            });
          }
        }
      });
    }

    if (mediaItems.length === 0) {
      // Retry logic
      if (retry < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return handler({ ...req, query: { ...req.query, retry: parseInt(retry) + 1 } }, res);
      }
      
      return res.status(404).json({ 
        success: false, 
        error: 'Tidak dapat menemukan media dari pin ini.' 
      });
    }

    // Kelompokkan media berdasarkan type
    const videos = mediaItems.filter(item => item.type === 'video');
    const images = mediaItems.filter(item => item.type === 'image');
    
    // Tentukan primary media (prioritaskan video)
    const primaryMedia = videos.length > 0 ? videos[0] : images[0];

    const result = {
      mediaUrls: {
        videos: videos.map(v => v.url),
        images: images.map(i => i.url)
      },
      mediaItems: mediaItems,
      primaryUrl: primaryMedia.url,
      type: primaryMedia.type,
      sourceUrl: pinterestUrl
    };

    return res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Pinterest API Error:', error);
    
    // Retry logic
    if (retry < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return handler({ ...req, query: { ...req.query, retry: parseInt(retry) + 1 } }, res);
    }
    
    return res.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data dari Pinterest. Pastikan URL valid dan coba lagi.' 
    });
  } finally {
    activeRequests.delete(requestId);
  }
}
