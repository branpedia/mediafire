import cloudscraper from 'cloudscraper';

// Fallback untuk environment yang tidak support Puppeteer
let puppeteer;
let StealthPlugin;
let RecaptchaPlugin;

try {
  puppeteer = (await import('puppeteer-extra')).default;
  StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  RecaptchaPlugin = (await import('puppeteer-extra-plugin-recaptcha')).default;
  
  puppeteer.use(StealthPlugin());
  puppeteer.use(RecaptchaPlugin());
} catch (error) {
  console.warn('Puppeteer tidak tersedia, menggunakan fallback methods');
}

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

  const { url, retry = 0, method = 'auto' } = request.query;

  if (!url) {
    return response.status(400).json({ success: false, error: 'Parameter URL diperlukan' });
  }

  try {
    // Validate MediaFire URL
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/') && !url.includes('/view/'))) {
      return response.status(400).json({ success: false, error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.' });
    }

    // Extract file ID from URL
    const fileId = extractFileId(url);
    if (!fileId) {
      return response.status(400).json({ success: false, error: 'Tidak dapat mengekstrak ID file dari URL.' });
    }

    // Choose method based on parameter or auto-detect
    let result;
    if (method === 'puppeteer' && puppeteer) {
      result = await handleWithPuppeteer(url, response, retry);
    } else if (method === 'cloudscraper') {
      result = await handleWithCloudscraper(url, response);
    } else if (method === 'direct') {
      result = await handleDirectDownload(fileId, response);
    } else {
      // Auto mode - try cloudscraper first
      result = await handleWithCloudscraper(url, response);
      
      // If cloudscraper fails and puppeteer is available, try puppeteer
      if (!result.success && puppeteer) {
        result = await handleWithPuppeteer(url, response, retry);
      }
    }

    return result;

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan saat memproses permintaan. Silakan coba lagi.' 
    });
  }
}

// Extract file ID from MediaFire URL
function extractFileId(url) {
  const patterns = [
    /mediafire\.com\/file\/([^\/]+)/,
    /mediafire\.com\/download\/([^\/]+)/,
    /mediafire\.com\/view\/([^\/]+)/,
    /mediafire\.com\/\?([^\/]+)$/,
    /mediafire\.com\/file\/([^\/]+)\/file/,
    /mediafire\.com\/download\/([^\/]+)\/file/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}

// Method 1: Cloudscraper approach
async function handleWithCloudscraper(url, response) {
  try {
    const html = await cloudscraper.get(url);
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Check for download button with scrambled URL
    const downloadButton = document.querySelector('#downloadButton');
    if (downloadButton && downloadButton.getAttribute('data-scrambled-url')) {
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      const decodedUrl = Buffer.from(scrambledUrl, 'base64').toString('utf-8');
      
      // Extract file info
      const fileInfo = extractFileInfo(document);
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileInfo.name,
          size: fileInfo.size,
          extension: fileInfo.extension,
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: decodedUrl,
          method: 'cloudscraper'
        }
      });
    }
    
    // Check for direct download link
    const directLink = document.querySelector('.input.popsok[href*="download"]');
    if (directLink && directLink.href) {
      const fileInfo = extractFileInfo(document);
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileInfo.name,
          size: fileInfo.size,
          extension: fileInfo.extension,
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: directLink.href,
          method: 'cloudscraper-direct'
        }
      });
    }
    
    return {
      success: false,
      error: 'Tidak dapat mengekstrak URL download dengan Cloudscraper.'
    };
    
  } catch (error) {
    console.error('Error with cloudscraper:', error);
    return {
      success: false,
      error: 'Cloudscraper gagal: ' + error.message
    };
  }
}

// Method 2: Puppeteer approach with stealth (only if available)
async function handleWithPuppeteer(url, response, retry = 0) {
  if (!puppeteer) {
    return {
      success: false,
      error: 'Puppeteer tidak tersedia di environment ini.'
    };
  }

  let browser;
  try {
    // Launch puppeteer with stealth plugin
    browser = await puppeteer.launch({ 
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set user agent to mimic a real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to the page
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Try to extract download URL using multiple methods
    const downloadData = await page.evaluate(() => {
      // Method 1: Check for download button with scrambled URL
      const downloadButton = document.querySelector('#downloadButton');
      if (downloadButton && downloadButton.getAttribute('data-scrambled-url')) {
        const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
        return {
          type: 'scrambled',
          url: scrambledUrl
        };
      }
      
      // Method 2: Check for direct download link
      const directLink = document.querySelector('.input.popsok[href*="download"]');
      if (directLink && directLink.href) {
        return {
          type: 'direct',
          url: directLink.href
        };
      }
      
      return null;
    });
    
    // Extract file info
    const fileInfo = await page.evaluate(() => {
      const fileNameElem = document.querySelector('.filename') || document.querySelector('div.filename');
      const fileSizeElem = document.querySelector('.file-size') || document.querySelector('div.file-size');
      
      return {
        name: fileNameElem ? fileNameElem.textContent.trim() : 'file',
        size: fileSizeElem ? fileSizeElem.textContent.trim() : '0MB'
      };
    });
    
    await browser.close();
    
    if (downloadData) {
      let downloadUrl = downloadData.url;
      
      // Decode if it's a scrambled URL
      if (downloadData.type === 'scrambled') {
        downloadUrl = Buffer.from(downloadUrl, 'base64').toString('utf-8');
      }
      
      // Determine file extension
      const extension = fileInfo.name.includes('.') ? 
        fileInfo.name.split('.').pop() : 'unknown';
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileInfo.name,
          size: fileInfo.size,
          extension: extension,
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: downloadUrl,
          method: 'puppeteer'
        }
      });
    } else {
      return response.status(500).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak URL download dengan Puppeteer.'
      });
    }
  } catch (error) {
    if (browser) await browser.close();
    console.error('Error with puppeteer:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Puppeteer gagal: ' + error.message
    });
  }
}

// Extract file information from the document
function extractFileInfo(document) {
  const fileNameElem = document.querySelector('.filename') || document.querySelector('div.filename');
  const fileSizeElem = document.querySelector('.file-size') || document.querySelector('div.file-size');
  const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'file';
  const fileSize = fileSizeElem ? fileSizeElem.textContent.trim() : '0MB';
  const extension = fileName.includes('.') ? fileName.split('.').pop() : 'unknown';
  
  return {
    name: fileName,
    size: fileSize,
    extension: extension
  };
}
