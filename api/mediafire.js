import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import UserAgent from 'user-agents';

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

  // Check cache first
  const cacheKey = url;
  const cachedResult = successCache.get(cacheKey);
  if (cachedResult && (Date.now() - cachedResult.timestamp < CACHE_DURATION)) {
    return response.status(200).json({
      success: true,
      data: cachedResult.data,
      cached: true
    });
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

    try {
      // First try with cloudscraper
      console.log('Trying with CloudScraper...');
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
    } catch (error) {
      console.log('Cloudscraper failed, trying with Puppeteer Stealth...');
      
      try {
        // Use Puppeteer with stealth plugin
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

        // Navigate to URL with longer timeout
        await page.goto(url, { 
          waitUntil: 'networkidle2',
          timeout: 30000
        });

        // Check for CloudFlare challenge
        const isCloudFlare = await page.evaluate(() => {
          return document.querySelector('#challenge-form') !== null || 
                 document.title.includes('Cloudflare') ||
                 document.body.textContent.includes('Checking your browser');
        });

        if (isCloudFlare) {
          console.log('CloudFlare detected, waiting for challenge to complete...');
          // Wait for CloudFlare challenge to complete
          await page.waitForFunction(() => {
            return !document.title.includes('Cloudflare') && 
                   !document.body.textContent.includes('Checking your browser');
          }, { timeout: 15000 });
        }

        // Wait for download button to appear
        await page.waitForSelector('#downloadButton, .dl-btn-label, .details', { 
          timeout: 10000 
        }).catch(() => {
          console.log('Download elements not found, continuing...');
        });

        html = await page.content();

      } catch (puppeteerError) {
        console.error('Puppeteer also failed:', puppeteerError);
        throw new Error('Both CloudScraper and Puppeteer failed to bypass protection');
      } finally {
        if (browser) {
          await browser.close();
        }
      }
    }

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Check if we're being blocked
    const isBlocked = document.title.includes('Cloudflare') || 
                     document.body.textContent.includes('Checking your browser') ||
                     document.querySelector('#challenge-form');

    if (isBlocked) {
      throw new Error('CloudFlare protection detected and could not be bypassed');
    }

    // Extract file information
    const fileNameElem = document.querySelector('.dl-btn-label');
    const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'Unknown';

    const fileSizeElem = document.querySelector('.details li:first-child span');
    const fileSize = fileSizeElem ? fileSizeElem.textContent.trim() : 'Unknown';

    const uploadedElem = document.querySelector('.details li:nth-child(2) span');
    const uploaded = uploadedElem ? uploadedElem.textContent.trim() : 'Unknown';

    // Extract download URL using multiple methods
    let downloadUrl = '';

    // Method 1: data-scrambled-url attribute
    const downloadButton = document.querySelector('#downloadButton');
    if (downloadButton) {
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      if (scrambledUrl) {
        try {
          downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
        } catch (e) {
          console.log('Base64 decoding failed for scrambled URL');
        }
      }
    }

    // Method 2: onclick attribute parsing
    if (!downloadUrl && downloadButton) {
      const onClickAttr = downloadButton.getAttribute('onclick');
      if (onClickAttr) {
        const urlMatch = onClickAttr.match(/(https?:\/\/[^\s'"]+)/);
        if (urlMatch) downloadUrl = urlMatch[0];
      }
    }

    // Method 3: Direct link extraction from script tags
    if (!downloadUrl) {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const scriptContent = script.textContent;
        if (scriptContent.includes('downloadUrl') || scriptContent.includes('direct_link')) {
          const urlMatch = scriptContent.match(/(https?:\/\/[^"']*mediafire\.com[^"']*)/);
          if (urlMatch) {
            downloadUrl = urlMatch[0];
            break;
          }
        }
      }
    }

    // Get file extension from filename
    const fileExtension = fileName.split('.').pop() || 'Unknown';

    const result = {
      name: fileName,
      size: fileSize,
      extension: fileExtension,
      uploaded: uploaded,
      downloadUrl: downloadUrl
    };

    // Cache the successful result
    successCache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    return response.status(200).json({
      success: true,
      data: result,
      cached: false
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
