import axios from 'axios';
import cheerio from 'cheerio';

// Set untuk mencegah request ganda secara bersamaan
let activeRequests = new Set();

/**
 * Handler utama untuk API Pinterest
 */
export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Credentials', true);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Handle OPTIONS request for CORS
  if (request.method === 'OPTIONS') {
    response.status(200).end();
    return;
  }

  // Only allow GET requests
  if (request.method !== 'GET') {
    return response.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { url } = request.query;

  if (!url) {
    return response.status(400).json({ success: false, error: 'Parameter URL diperlukan' });
  }

  // Check if request is already processing
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  if (activeRequests.has(requestId)) {
    return response.status(429).json({ 
      success: false, 
      error: 'Permintaan sedang diproses, harap tunggu' 
    });
  }
  
  activeRequests.add(requestId);

  try {
    // Validate Pinterest URL
    if (!url.includes('pinterest.com') && !url.includes('pin.it')) {
      return response.status(400).json({ 
        success: false, 
        error: 'URL tidak valid. Pastikan URL berasal dari Pinterest.' 
      });
    }

    // Langsung gunakan savepin.app
    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(url)}&lang=en&type=redirect`;
    
    console.log('Fetching from:', apiUrl);
    
    const { data: html } = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Referer': 'https://www.savepin.app/',
      },
      timeout: 20000,
    });

    const $ = cheerio.load(html);
    
    // Cari semua link download
    const downloadLinks = [];
    $('a[href*="force-save.php?url="]').each((index, element) => {
      const href = $(element).attr('href');
      if (href) {
        const match = href.match(/url=([^&]+)/);
        if (match) {
          try {
            const mediaUrl = decodeURIComponent(match[1]);
            downloadLinks.push(mediaUrl);
          } catch (e) {
            console.log('Error decoding URL:', match[1]);
          }
        }
      }
    });

    // Jika tidak ditemukan dengan selektor di atas, coba cara lain
    if (downloadLinks.length === 0) {
      $('a[href*="download.php"]').each((index, element) => {
        const href = $(element).attr('href');
        if (href && href.includes('url=')) {
          const match = href.match(/url=([^&]+)/);
          if (match) {
            try {
              const mediaUrl = decodeURIComponent(match[1]);
              downloadLinks.push(mediaUrl);
            } catch (e) {
              console.log('Error decoding URL:', match[1]);
            }
          }
        }
      });
    }

    // Filter hanya URL media yang valid
    const mediaUrls = {
      videos: downloadLinks.filter(link => link.includes('.mp4')),
      images: downloadLinks.filter(link => 
        link.includes('.jpg') || link.includes('.jpeg') || link.includes('.png')
      )
    };

    console.log('Found media URLs:', mediaUrls);

    if (mediaUrls.videos.length === 0 && mediaUrls.images.length === 0) {
      return response.status(404).json({ 
        success: false, 
        error: 'Tidak dapat menemukan media di pin ini.' 
      });
    }

    // Return URL media pertama yang ditemukan
    // Prioritaskan video daripada gambar
    const result = {
      success: true,
      data: {
        mediaUrls: mediaUrls,
        primaryUrl: mediaUrls.videos.length > 0 ? mediaUrls.videos[0] : mediaUrls.images[0],
        type: mediaUrls.videos.length > 0 ? 'video' : 'image',
        sourceUrl: url
      }
    };

    return response.status(200).json(result);

  } catch (error) {
    console.error('Pinterest API Error:', error);
    
    if (error.code === 'ECONNABORTED') {
      return response.status(408).json({ 
        success: false, 
        error: 'Timeout: Permintaan memakan waktu terlalu lama. Silakan coba lagi.' 
      });
    }
    
    if (error.response) {
      return response.status(error.response.status).json({ 
        success: false, 
        error: `Error dari server: ${error.response.status} - ${error.response.statusText}` 
      });
    }
    
    return response.status(500).json({ 
      success: false, 
      error: error.message || 'Gagal mengambil media dari Pinterest. Pastikan URL valid dan coba lagi.' 
    });
  } finally {
    // Clean up
    activeRequests.delete(requestId);
  }
}
