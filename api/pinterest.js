import axios from 'axios';
import cheerio from 'cheerio';

// Set untuk mencegah request ganda secara bersamaan
let activeRequests = new Set();

/**
 * Fungsi untuk resolve URL Pinterest (shortlink seperti pin.it)
 * @param {string} url - URL Pinterest (bisa shortlink atau full URL)
 * @returns {Promise<string>} URL yang sudah di-resolve
 */
const resolvePinterestUrl = async (url) => {
  try {
    console.log('Resolving URL:', url);
    
    let res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      }
    }).catch(e => {
      console.log('Axios error:', e.message);
      return e.response || { headers: {}, status: 500 };
    });

    let finalUrl = res.headers?.location || url;
    console.log('First redirect result:', finalUrl);

    // Handle Pinterest URL shortener
    if (/api\.pinterest\.com\/url_shortener/.test(finalUrl)) {
      console.log('Detected Pinterest URL shortener, following...');
      let res2 = await axios.get(finalUrl, {
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }).catch(e => e.response || e);
      
      finalUrl = res2.headers?.location || finalUrl;
      console.log('Second redirect result:', finalUrl);
    }

    return finalUrl;
  } catch (e) {
    console.error('Resolve URL Error:', e.message);
    return url;
  }
};

/**
 * Fungsi untuk extract media URL dari HTML savepin.app
 * @param {string} html - HTML content dari savepin.app
 * @returns {Object} Object berisi videoUrl dan imageUrl
 */
const extractMediaFromHtml = (html) => {
  try {
    const $ = cheerio.load(html);
    
    const extractMediaUrl = (el) => {
      const href = $(el).attr('href');
      if (!href) return null;
      
      const match = href.match(/url=([^&]+)/);
      if (match) {
        try {
          return decodeURIComponent(match[1]);
        } catch (e) {
          console.log('Error decoding URL:', match[1]);
          return match[1];
        }
      }
      return null;
    };

    // Cari link video (MP4)
    const videoEl = $('a[href*="force-save.php?url="][href*=".mp4"]');
    // Cari link gambar (JPG, PNG, JPEG)
    const imgEl = $('a[href*="force-save.php?url="][href*=".jpg"], a[href*="force-save.php?url="][href*=".png"], a[href*="force-save.php?url="][href*=".jpeg"]');

    const videoUrl = videoEl.length ? extractMediaUrl(videoEl[0]) : null;
    const imageUrl = imgEl.length ? extractMediaUrl(imgEl[0]) : null;

    console.log('Found video URL:', videoUrl ? 'Yes' : 'No');
    console.log('Found image URL:', imageUrl ? 'Yes' : 'No');

    return { videoUrl, imageUrl };
  } catch (error) {
    console.error('Error extracting media from HTML:', error);
    return { videoUrl: null, imageUrl: null };
  }
};

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
    return response.status(200).end();
  }

  // Only allow GET requests
  if (request.method !== 'GET') {
    return response.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Only GET requests are accepted.' 
    });
  }

  const { url } = request.query;

  if (!url) {
    return response.status(400).json({ 
      success: false, 
      error: 'Parameter URL diperlukan. Contoh: /api/pinterest?url=https://pin.it/1sFZsJRDZ' 
    });
  }

  // Check if request is already processing (simple rate limiting)
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  if (activeRequests.size > 10) {
    return response.status(429).json({ 
      success: false, 
      error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' 
    });
  }
  
  activeRequests.add(requestId);

  try {
    console.log('Processing Pinterest URL:', url);

    // Validate Pinterest URL
    if (!url.includes('pinterest.com') && !url.includes('pin.it')) {
      return response.status(400).json({ 
        success: false, 
        error: 'URL tidak valid. Pastikan URL berasal dari Pinterest (contoh: https://pin.it/xxx atau https://pinterest.com/pin/xxx).' 
      });
    }

    let pinterestUrl = url;

    // Step 1: resolve shortlink (jika menggunakan pin.it)
    console.log('Step 1: Resolving URL...');
    pinterestUrl = await resolvePinterestUrl(pinterestUrl);

    if (!pinterestUrl.includes('pinterest.com/pin/')) {
      return response.status(400).json({ 
        success: false, 
        error: 'Gagal mendapatkan URL pin asli! Pastikan URL Pinterest valid.' 
      });
    }

    console.log('Resolved URL:', pinterestUrl);

    // Step 2: scrape dari savepin.app
    console.log('Step 2: Scraping from savepin.app...');
    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(pinterestUrl)}&lang=en&type=redirect`;
    console.log('Savepin URL:', apiUrl);
    
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
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
      },
      timeout: 20000, // 20 second timeout
    });

    console.log('Successfully retrieved HTML from savepin.app');

    // Step 3: Extract media URLs from HTML
    console.log('Step 3: Extracting media URLs...');
    const { videoUrl, imageUrl } = extractMediaFromHtml(html);

    if (!videoUrl && !imageUrl) {
      console.log('No media found in HTML');
      // Coba alternatif selektor jika tidak ditemukan
      const $ = cheerio.load(html);
      const downloadLinks = $('a[href*="download.php"]');
      
      let alternativeUrl = null;
      downloadLinks.each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('url=') && !alternativeUrl) {
          const match = href.match(/url=([^&]+)/);
          if (match) {
            try {
              alternativeUrl = decodeURIComponent(match[1]);
            } catch (e) {
              alternativeUrl = match[1];
            }
          }
        }
      });
      
      if (alternativeUrl) {
        console.log('Found alternative URL:', alternativeUrl);
        return response.status(200).json({
          success: true,
          data: {
            videoUrl: alternativeUrl.includes('.mp4') ? alternativeUrl : null,
            imageUrl: alternativeUrl.includes('.mp4') ? null : alternativeUrl,
            type: alternativeUrl.includes('.mp4') ? 'video' : 'image',
            sourceUrl: pinterestUrl,
            directUrl: alternativeUrl
          }
        });
      }
      
      return response.status(404).json({ 
        success: false, 
        error: 'Tidak dapat menemukan media di pin ini. Pin mungkin bersifat privat atau telah dihapus.' 
      });
    }

    console.log('Media extraction successful');
    
    // Berhasil mendapatkan media
    return response.status(200).json({
      success: true,
      data: {
        videoUrl: videoUrl,
        imageUrl: imageUrl,
        type: videoUrl ? 'video' : 'image',
        sourceUrl: pinterestUrl,
        directUrl: videoUrl || imageUrl
      }
    });

  } catch (error) {
    console.error('Pinterest API Error:', error.message);
    
    if (error.code === 'ECONNABORTED') {
      return response.status(408).json({ 
        success: false, 
        error: 'Timeout: Permintaan memakan waktu terlalu lama. Silakan coba lagi.' 
      });
    }
    
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Error response data:', error.response.data);
      console.error('Error response status:', error.response.status);
      console.error('Error response headers:', error.response.headers);
      
      return response.status(error.response.status).json({ 
        success: false, 
        error: `Error dari server: ${error.response.status} - ${error.response.statusText}` 
      });
    } else if (error.request) {
      // The request was made but no response was received
      console.error('Error request:', error.request);
      return response.status(502).json({ 
        success: false, 
        error: 'Tidak ada respons dari server. Silakan coba lagi nanti.' 
      });
    }
    
    // Something happened in setting up the request that triggered an Error
    return response.status(500).json({ 
      success: false, 
      error: error.message || 'Gagal mengambil media dari Pinterest. Pastikan URL valid dan coba lagi.' 
    });
  } finally {
    // Clean up
    activeRequests.delete(requestId);
    console.log('Active requests:', activeRequests.size);
  }
}
