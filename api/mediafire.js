import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Gunakan plugin stealth untuk menghindari deteksi
puppeteer.use(StealthPlugin());

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

  const { url, retry = 0 } = request.query;

  if (!url) {
    return response.status(400).json({ success: false, error: 'Parameter URL diperlukan' });
  }

  try {
    // Validate MediaFire URL
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/'))) {
      return response.status(400).json({ success: false, error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.' });
    }

    let html;
    let browser;

    try {
      // First try with cloudscraper
      const scraper = cloudscraper.defaults({
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      html = await scraper.get(url);
    } catch (error) {
      console.log('Cloudscraper failed, trying with Puppeteer...');
      
      // Jika cloudscraper gagal, gunakan Puppeteer dengan stealth
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      
      const page = await browser.newPage();
      
      // Set user agent dan header yang realistis
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1'
      });
      
      // Abaikan permintaan yang tidak penting untuk mempercepat loading
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'script'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // Tunggu hingga tombol download muncul
      try {
        await page.waitForSelector('#downloadButton', { timeout: 10000 });
      } catch (e) {
        console.log('Download button not found, continuing anyway...');
      }
      
      html = await page.content();
      await browser.close();
    }

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract file information
    const fileNameElem = document.querySelector('.dl-btn-label');
    const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'Unknown';

    const fileSizeElem = document.querySelector('.details li:first-child span');
    const fileSize = fileSizeElem ? fileSizeElem.textContent.trim() : 'Unknown';

    const uploadedElem = document.querySelector('.details li:nth-child(2) span');
    const uploaded = uploadedElem ? uploadedElem.textContent.trim() : 'Unknown';

    // Extract download URL - multiple methods
    let downloadUrl = '';
    
    // Method 1: data-scrambled-url attribute (base64 decoded)
    const downloadButton = document.querySelector('#downloadButton');
    if (downloadButton) {
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      if (scrambledUrl) {
        try {
          downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
        } catch (e) {
          console.log('Failed to decode base64 URL:', e);
        }
      }
    }
    
    // Method 2: Check for direct href if scrambled URL is not available
    if (!downloadUrl && downloadButton) {
      const directHref = downloadButton.getAttribute('href');
      if (directHref && directHref.startsWith('http')) {
        downloadUrl = directHref;
      }
    }
    
    // Method 3: Look for the download link in the page content
    if (!downloadUrl) {
      const downloadLinks = document.querySelectorAll('a[href*="download"]');
      for (let link of downloadLinks) {
        const href = link.getAttribute('href');
        if (href && href.includes('mediafire.com') && href.includes('/download/')) {
          downloadUrl = href;
          break;
        }
      }
    }
    
    // Method 4: Fallback to the API endpoint pattern
    if (!downloadUrl) {
      // Coba ekstrak kunci download dari URL
      const match = url.match(/mediafire\.com\/(?:file|download)\/([a-zA-Z0-9]+)/);
      if (match && match[1]) {
        downloadUrl = `https://download${Math.floor(Math.random() * 3000)}.mediafire.com/${match[1]}/file`;
      }
    }

    // Get file extension from filename
    const fileExtension = fileName.split('.').pop() || 'Unknown';

    return response.status(200).json({
      success: true,
      data: {
        name: fileName,
        size: fileSize,
        extension: fileExtension,
        uploaded: uploaded,
        downloadUrl: downloadUrl
      }
    });

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    
    // Retry logic
    if (retry < 3) {
      // Wait for 1 second before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
      return handler({ ...request, query: { ...request.query, retry: parseInt(retry) + 1 } }, response);
    }
    
    return response.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.' 
    });
  }
}
