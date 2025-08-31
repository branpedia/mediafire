import axios from 'axios';
import cheerio from 'cheerio';

// Set untuk mencegah eksekusi dobel
const activeRequests = new Set();

const resolvePinterestUrl = async (url) => {
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    }).catch(e => e.response || e);

    let finalUrl = response.headers?.location || url;

    if (/api\.pinterest\.com\/url_shortener/.test(finalUrl)) {
      const response2 = await axios.get(finalUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
        timeout: 10000
      }).catch(e => e.response || e);
      finalUrl = response2.headers?.location || finalUrl;
    }

    return finalUrl;
  } catch (error) {
    console.error('Resolve URL Error:', error);
    return url;
  }
};

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

    // Step 1: resolve shortlink
    pinterestUrl = await resolvePinterestUrl(pinterestUrl);

    if (!/pinterest\.com\/pin/.test(pinterestUrl)) {
      return res.status(400).json({ success: false, error: 'Failed to get actual pin URL' });
    }

    // Step 2: scrape dari savepin.app
    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(pinterestUrl)}&lang=en&type=redirect`;
    const { data: html } = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(html);
    
    // Ekstrak URL media
    const extractMediaUrl = (el) => {
      const href = $(el).attr('href');
      if (!href) return null;
      const match = href.match(/url=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    };

    // Cari video dan gambar
    const videoElements = $('a[href*="force-save.php?url="][href*=".mp4"]');
    const imageElements = $('a[href*="force-save.php?url="][href*=".jpg"], a[href*="force-save.php?url="][href*=".png"], a[href*="force-save.php?url="][href*=".jpeg"]');

    const videoUrls = [];
    const imageUrls = [];

    // Ekstrak semua video
    videoElements.each((i, el) => {
      const url = extractMediaUrl(el);
      if (url) videoUrls.push(url);
    });

    // Ekstrak semua gambar
    imageElements.each((i, el) => {
      const url = extractMediaUrl(el);
      if (url) imageUrls.push(url);
    });

    // Tentukan primary URL dan type
    let primaryUrl = videoUrls[0] || imageUrls[0];
    let type = videoUrls.length > 0 ? 'video' : (imageUrls.length > 0 ? 'image' : 'unknown');

    if (!primaryUrl) {
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

    const result = {
      mediaUrls: {
        videos: videoUrls,
        images: imageUrls
      },
      primaryUrl,
      type,
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
