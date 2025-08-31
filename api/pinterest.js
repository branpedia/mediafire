import axios from 'axios';
import cheerio from 'cheerio';

// Set untuk mencegah request ganda secara bersamaan
let activeRequests = new Set();

/**
 * Fungsi untuk resolve URL Pinterest (shortlink seperti pin.it)
 */
const resolvePinterestUrl = async (url) => {
  try {
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
    }).catch(e => e.response || e);

    let finalUrl = res.headers?.location || url;

    if (/api\.pinterest\.com\/url_shortener/.test(finalUrl)) {
      let res2 = await axios.get(finalUrl, {
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }).catch(e => e.response || e);
      finalUrl = res2.headers?.location || finalUrl;
    }

    return finalUrl;
  } catch (e) {
    console.error('Resolve URL Error:', e);
    return url;
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

    let pinterestUrl = url;

    // Step 1: resolve shortlink
    pinterestUrl = await resolvePinterestUrl(pinterestUrl);

    if (!pinterestUrl.includes('pinterest.com/pin/')) {
      return response.status(400).json({ 
        success: false, 
        error: 'Gagal mendapatkan URL pin asli!' 
      });
    }

    // Step 2: scrape dari savepin.app
    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(pinterestUrl)}&lang=en&type=redirect`;
    
    const { data: html } = await axios.get(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0 Safari/537.36',
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
      timeout: 20000,
    });

    const $ = cheerio.load(html);
    
    const extractMediaUrl = (el) => {
      const href = $(el).attr('href');
      if (!href) return null;
      const match = href.match(/url=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : null;
    };

    // Cari link download yang sebenarnya
    const videoEl = $('a[href*="force-save.php?url="][href*=".mp4"]');
    const imgEl = $('a[href*="force-save.php?url="][href*=".jpg"], a[href*="force-save.php?url="][href*=".png"], a[href*="force-save.php?url="][href*=".jpeg"]');

    // Jika tidak ditemukan dengan selektor di atas, coba cara lain
    let videoUrl = videoEl.length ? extractMediaUrl(videoEl[0]) : null;
    let imageUrl = imgEl.length ? extractMediaUrl(imgEl[0]) : null;

    // Jika masih tidak ditemukan, coba selektor alternatif
    if (!videoUrl && !imageUrl) {
      const downloadButtons = $('a[href*="download.php"]');
      for (let i = 0; i < downloadButtons.length; i++) {
        const button = downloadButtons[i];
        const href = $(button).attr('href');
        if (href && href.includes('url=')) {
          const match = href.match(/url=([^&]+)/);
          if (match) {
            const mediaUrl = decodeURIComponent(match[1]);
            if (mediaUrl.includes('.mp4')) {
              videoUrl = mediaUrl;
            } else if (mediaUrl.includes('.jpg') || mediaUrl.includes('.png') || mediaUrl.includes('.jpeg')) {
              imageUrl = mediaUrl;
            }
          }
        }
      }
    }

    // Jika masih tidak ditemukan, coba cari di semua link
    if (!videoUrl && !imageUrl) {
      const allLinks = $('a[href*="url="]');
      for (let i = 0; i < allLinks.length; i++) {
        const link = allLinks[i];
        const href = $(link).attr('href');
        if (href) {
          const match = href.match(/url=([^&]+)/);
          if (match) {
            const mediaUrl = decodeURIComponent(match[1]);
            if (mediaUrl.includes('.mp4')) {
              videoUrl = mediaUrl;
              break;
            } else if (mediaUrl.includes('.jpg') || mediaUrl.includes('.png') || mediaUrl.includes('.jpeg')) {
              imageUrl = mediaUrl;
              break;
            }
          }
        }
      }
    }

    if (!videoUrl && !imageUrl) {
      return response.status(404).json({ 
        success: false, 
        error: 'Tidak dapat menemukan media di pin ini.' 
      });
    }

    // Pastikan URL yang didapat adalah URL yang valid, bukan example.com
    if (videoUrl && videoUrl.includes('example.com')) {
      // Coba metode alternatif untuk mendapatkan URL
      const scriptTags = $('script');
      for (let i = 0; i < scriptTags.length; i++) {
        const scriptContent = $(scriptTags[i]).html();
        if (scriptContent) {
          // Cari URL video atau gambar dalam script
          const videoRegex = /(https?:\/\/[^"\s]*\.mp4)/g;
          const imageRegex = /(https?:\/\/[^"\s]*\.(jpg|jpeg|png))/g;
          
          const videoMatch = scriptContent.match(videoRegex);
          const imageMatch = scriptContent.match(imageRegex);
          
          if (videoMatch && videoMatch.length > 0) {
            videoUrl = videoMatch[0];
            break;
          } else if (imageMatch && imageMatch.length > 0) {
            imageUrl = imageMatch[0];
            break;
          }
        }
      }
    }

    // Jika masih example.com, beri error
    if ((videoUrl && videoUrl.includes('example.com')) || (imageUrl && imageUrl.includes('example.com'))) {
      return response.status(500).json({ 
        success: false, 
        error: 'Gagal mendapatkan URL media yang valid. Silakan coba dengan pin yang berbeda.' 
      });
    }

    return response.status(200).json({
      success: true,
      data: {
        videoUrl: videoUrl,
        imageUrl: imageUrl,
        type: videoUrl ? 'video' : 'image',
        sourceUrl: pinterestUrl
      }
    });

  } catch (error) {
    console.error('Pinterest API Error:', error);
    
    return response.status(500).json({ 
      success: false, 
      error: error.message || 'Gagal mengambil media dari Pinterest. Pastikan URL valid dan coba lagi.' 
    });
  } finally {
    // Clean up
    activeRequests.delete(requestId);
  }
}
