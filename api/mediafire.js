import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import UserAgent from 'user-agents';
import axios from 'axios';

// Apply stealth and recaptcha plugins
puppeteer.use(StealthPlugin());
puppeteer.use(RecaptchaPlugin());

// Cache untuk menyimpan hasil yang berhasil
const successCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of successCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      successCache.delete(key);
    }
  }
}, 60 * 1000);

// Fungsi untuk extract download URL dengan berbagai metode
function extractDownloadUrl(document, html) {
  let downloadUrl = '';

  // Method 1: data-scrambled-url attribute (utama)
  const downloadButton = document.querySelector('#downloadButton');
  if (downloadButton) {
    const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
    if (scrambledUrl) {
      try {
        downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
        console.log('Found URL from data-scrambled-url:', downloadUrl);
        return downloadUrl;
      } catch (e) {
        console.log('Base64 decoding failed for scrambled URL');
      }
    }
  }

  // Method 2: onclick attribute parsing
  if (downloadButton) {
    const onClickAttr = downloadButton.getAttribute('onclick');
    if (onClickAttr) {
      const urlMatch = onClickAttr.match(/(https?:\/\/[^\s'"]+\.mediafire\.com[^\s'"]*)/);
      if (urlMatch) {
        downloadUrl = urlMatch[0];
        console.log('Found URL from onclick:', downloadUrl);
        return downloadUrl;
      }
      
      // Cari URL di dalam fungsi
      const funcMatch = onClickAttr.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
      if (funcMatch) {
        downloadUrl = funcMatch[1];
        console.log('Found URL from window.location:', downloadUrl);
        return downloadUrl;
      }
    }
  }

  // Method 3: Direct link dari script tags (deep scan)
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const scriptContent = script.textContent;
    
    // Pattern matching untuk berbagai format URL
    const patterns = [
      /(https?:\/\/[^"']*mediafire\.com[^"']*\/file\/[^"']*)/,
      /(https?:\/\/[^"']*mediafire\.com[^"']*\/download\/[^"']*)/,
      /(https?:\/\/[^"']*mediafire\.com[^"']*\/\?[^"']*)/,
      /downloadUrl[:\s]*['"]([^"']+)['"]/,
      /direct_link[:\s]*['"]([^"']+)['"]/,
      /href\s*=\s*['"]([^"']*mediafire\.com[^"']*)['"]/
    ];

    for (const pattern of patterns) {
      const matches = scriptContent.match(pattern);
      if (matches && matches[1]) {
        downloadUrl = matches[1].replace(/\\\//g, '/');
        console.log('Found URL from script:', downloadUrl);
        return downloadUrl;
      }
    }
  }

  // Method 4: Cari di seluruh HTML
  const htmlMatches = html.match(/(https?:\/\/[^"']*mediafire\.com[^"']*\/file\/[^"']*)/);
  if (htmlMatches) {
    downloadUrl = htmlMatches[1];
    console.log('Found URL from HTML scan:', downloadUrl);
    return downloadUrl;
  }

  // Method 5: Coba konstruksi manual URL download
  const fileIdMatch = html.match(/\/file\/([a-z0-9]+)\//);
  if (fileIdMatch && fileIdMatch[1]) {
    downloadUrl = `https://download${Math.floor(Math.random() * 10) + 1}.mediafire.com/${fileIdMatch[1]}/file`;
    console.log('Constructed URL from file ID:', downloadUrl);
    return downloadUrl;
  }

  return downloadUrl;
}

// Fungsi untuk verify download URL
async function verifyDownloadUrl(url) {
  if (!url) return false;
  
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      validateStatus: (status) => status < 400
    });
    return response.status === 200 || response.status === 302;
  } catch (error) {
    // Coba dengan GET request jika HEAD gagal
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        maxRedirects: 5,
        validateStatus: (status) => status < 400
      });
      return true;
    } catch (e) {
      return false;
    }
  }
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

  const { url, retry = 0, force = false } = request.query;

  if (!url) {
    return response.status(400).json({ success: false, error: 'Parameter URL diperlukan' });
  }

  // Check cache first (kecuali force=true)
  const cacheKey = url;
  if (!force) {
    const cachedResult = successCache.get(cacheKey);
    if (cachedResult && (Date.now() - cachedResult.timestamp < CACHE_DURATION)) {
      return response.status(200).json({
        success: true,
        data: cachedResult.data,
        cached: true
      });
    }
  }

  try {
    // Validate MediaFire URL
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/'))) {
      return response.status(400).json({ success: false, error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.' });
    }

    let html;
    let browser;
    let page;

    const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();

    console.log(`Processing MediaFire URL: ${url}`);

    try {
      // Langsung gunakan Puppeteer untuk hasil yang lebih reliable
      console.log('Using Puppeteer Stealth for better reliability...');
      
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--window-size=1920,1080'
        ]
      });

      page = await browser.newPage();
      
      // Set realistic viewport and user agent
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(userAgent);
      
      // Set extra headers to mimic real browser
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      });

      // Enable request interception to block unnecessary resources
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      // Navigate to URL dengan timeout lebih lama
      await page.goto(url, { 
        waitUntil: 'networkidle2',
        timeout: 45000
      });

      // Tunggu sampai elemen penting muncul
      await Promise.race([
        page.waitForSelector('#downloadButton', { timeout: 10000 }),
        page.waitForSelector('.dl-btn-label', { timeout: 10000 }),
        page.waitForSelector('.details', { timeout: 10000 }),
        new Promise(resolve => setTimeout(resolve, 5000)) // Minimal tunggu 5 detik
      ]);

      // Scroll ke download button untuk memastikan ter-render
      await page.evaluate(() => {
        const downloadBtn = document.querySelector('#downloadButton');
        if (downloadBtn) {
          downloadBtn.scrollIntoView();
        }
      });

      // Tunggu sebentar untuk memastikan JavaScript selesai dieksekusi
      await new Promise(resolve => setTimeout(resolve, 2000));

      html = await page.content();

    } catch (puppeteerError) {
      console.error('Puppeteer failed:', puppeteerError);
      
      // Fallback ke cloudscraper
      try {
        console.log('Falling back to CloudScraper...');
        html = await cloudscraper.get({
          url: url,
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
          }
        });
      } catch (cloudscraperError) {
        console.error('CloudScraper also failed:', cloudscraperError);
        throw new Error('Both methods failed to fetch the page');
      }
    } finally {
      if (browser) {
        await browser.close();
      }
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

    // Extract download URL dengan berbagai metode
    let downloadUrl = extractDownloadUrl(document, html);

    // Jika masih kosong, coba metode ekstrem
    if (!downloadUrl) {
      console.log('Trying extreme methods to extract download URL...');
      
      // Method ekstrem: cari semua link yang mungkin
      const allLinks = document.querySelectorAll('a[href*="mediafire.com"]');
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        if (href && href.includes('/file/') || href.includes('/download/')) {
          downloadUrl = href;
          console.log('Found potential URL from link:', downloadUrl);
          break;
        }
      }
    }

    // Verify download URL
    let isValidUrl = false;
    if (downloadUrl) {
      isValidUrl = await verifyDownloadUrl(downloadUrl);
      console.log(`Download URL verification: ${isValidUrl}`);
    }

    // Jika URL tidak valid, coba konstruksi manual
    if (!isValidUrl) {
      console.log('Constructing manual download URL...');
      const fileIdMatch = url.match(/\/file\/([a-z0-9]+)/) || html.match(/kNO\s*=\s*['"]([a-z0-9]+)['"]/);
      if (fileIdMatch && fileIdMatch[1]) {
        downloadUrl = `https://download${Math.floor(Math.random() * 4) + 1}.mediafire.com/${fileIdMatch[1]}/file`;
        isValidUrl = await verifyDownloadUrl(downloadUrl);
        console.log(`Manual URL verification: ${isValidUrl}`);
      }
    }

    // Get file extension from filename
    const fileExtension = fileName.includes('.') ? fileName.split('.').pop() : 'Unknown';

    const result = {
      name: fileName,
      size: fileSize,
      extension: fileExtension,
      uploaded: uploaded,
      downloadUrl: isValidUrl ? downloadUrl : ''
    };

    // Cache the successful result hanya jika download URL valid
    if (isValidUrl) {
      successCache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });
    }

    return response.status(200).json({
      success: true,
      data: result,
      cached: false,
      urlValid: isValidUrl
    });

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    
    // Retry logic dengan exponential backoff
    if (retry < 3) {
      const delay = Math.pow(2, retry) * 1000; // Exponential backoff: 2s, 4s, 8s
      console.log(`Retrying in ${delay}ms (attempt ${parseInt(retry) + 1}/3)`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      return handler({ ...request, query: { ...request.query, retry: parseInt(retry) + 1 } }, response);
    }
    
    return response.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.',
      details: error.message 
    });
  }
}
