import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Builder } from 'undetected-chromedriver';
import axios from 'axios-cloudflare';
import randomUseragent from 'random-useragent';
import { setTimeout } from 'timers/promises';

// Setup puppeteer stealth
puppeteer.use(StealthPlugin());

// Cache untuk menyimpan hasil sementara (mengurangi request berulang)
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 menit

// List user agents untuk rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
];

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

  const { url, retry = 0, force = 'false' } = request.query;

  if (!url) {
    return response.status(400).json({ success: false, error: 'Parameter URL diperlukan' });
  }

  // Check cache jika tidak force refresh
  const cacheKey = url.toLowerCase();
  if (force !== 'true' && cache.has(cacheKey)) {
    const cachedData = cache.get(cacheKey);
    if (Date.now() - cachedData.timestamp < CACHE_DURATION) {
      console.log('Returning cached data for:', url);
      return response.status(200).json(cachedData.data);
    }
  }

  try {
    // Validate and normalize MediaFire URL
    let normalizedUrl = url.trim();
    if (!normalizedUrl.startsWith('http')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }
    
    if (!normalizedUrl.includes('mediafire.com') || 
        (!normalizedUrl.includes('/file/') && !normalizedUrl.includes('/download/'))) {
      return response.status(400).json({ 
        success: false, 
        error: 'URL tidak valid. Pastikan URL berasal dari MediaFire dan mengandung /file/ atau /download/.' 
      });
    }

    let html;
    let browser;
    let methodUsed = '';

    try {
      console.log('Attempt 1: Using Cloudscraper...');
      methodUsed = 'Cloudscraper';
      // First try with cloudscraper dengan random delay
      await setTimeout(Math.random() * 1000 + 500); // Random delay 0.5-1.5 detik
      html = await cloudscraper.get(normalizedUrl, {
        headers: {
          'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: 15000
      });
    } catch (error) {
      console.log('Cloudscraper failed, trying with Axios Cloudflare...');
      
      try {
        console.log('Attempt 2: Using Axios Cloudflare...');
        methodUsed = 'Axios Cloudflare';
        // Second try with axios-cloudflare
        await setTimeout(Math.random() * 1000 + 1000); // Random delay 1-2 detik
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        const axiosResponse = await axios.get(normalizedUrl, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
          },
          timeout: 20000,
          maxRedirects: 5
        });
        html = axiosResponse.data;
      } catch (axiosError) {
        console.log('Axios Cloudflare failed, trying with Puppeteer Stealth...');
        
        try {
          console.log('Attempt 3: Using Puppeteer Stealth...');
          methodUsed = 'Puppeteer Stealth';
          // Third try with puppeteer stealth
          await setTimeout(Math.random() * 1000 + 2000); // Random delay 2-3 detik
          browser = await puppeteer.launch({
            headless: 'new',
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-web-security',
              '--disable-features=IsolateOrigins,site-per-process',
              '--disable-site-isolation-trials',
              '--disable-blink-features=AutomationControlled',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--window-size=1920,1080'
            ],
            defaultViewport: {
              width: 1920,
              height: 1080
            }
          });
          
          const page = await browser.newPage();
          
          // Set random user agent dan headers
          const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
          await page.setUserAgent(userAgent);
          
          // Set extra headers yang lebih natural
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
          });
          
          // Enable stealth
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          });
          
          await page.goto(normalizedUrl, { 
            waitUntil: 'networkidle2',
            timeout: 45000 
          });
          
          // Wait for potential Cloudflare challenge dengan timeout
          await Promise.race([
            page.waitForSelector('#downloadButton, .dl-btn-label', { timeout: 10000 }),
            setTimeout(8000)
          ]);
          
          html = await page.content();
          await browser.close();
          
        } catch (puppeteerError) {
          console.log('Puppeteer Stealth failed, trying with Undetected ChromeDriver...');
          
          // Final try with undetected chromedriver
          try {
            console.log('Attempt 4: Using Undetected ChromeDriver...');
            methodUsed = 'Undetected ChromeDriver';
            await setTimeout(Math.random() * 1000 + 3000); // Random delay 3-4 detik
            
            const driver = await Builder()
              .withCapabilities({
                'goog:chromeOptions': {
                  args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-web-security',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                    '--user-agent=' + USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
                  ],
                  excludeSwitches: ['enable-automation']
                }
              })
              .build();
            
            await driver.get(normalizedUrl);
            // Wait longer for Cloudflare dengan polling
            await driver.sleep(3000);
            
            // Check jika halaman sudah loaded
            let pageSource = await driver.getPageSource();
            let attempts = 0;
            while ((!pageSource.includes('downloadButton') && !pageSource.includes('dl-btn-label')) && attempts < 5) {
              await driver.sleep(2000);
              pageSource = await driver.getPageSource();
              attempts++;
            }
            
            html = pageSource;
            await driver.quit();
            
          } catch (finalError) {
            console.error('All methods failed:', finalError);
            throw new Error('Semua metode bypass gagal: ' + finalError.message);
          }
        }
      }
    }

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract file information dengan multiple fallback methods
    let fileName = 'Unknown';
    let fileSize = 'Unknown';
    let uploaded = 'Unknown';
    let downloadUrl = '';

    // Multiple selectors untuk fileName
    const fileNameSelectors = [
      '.dl-btn-label',
      '.filename',
      '[data-filename]',
      'h1',
      'title'
    ];
    
    for (const selector of fileNameSelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        fileName = elem.textContent.trim();
        break;
      }
    }

    // Multiple selectors untuk fileSize
    const fileSizeSelectors = [
      '.details li:first-child span',
      '.file-size',
      '[data-size]',
      'li:contains("Size") span',
      'li:contains("size") span'
    ];
    
    for (const selector of fileSizeSelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        fileSize = elem.textContent.trim();
        break;
      }
    }

    // Multiple selectors untuk uploaded date
    const uploadedSelectors = [
      '.details li:nth-child(2) span',
      '.upload-date',
      '[data-uploaded]',
      'li:contains("Date") span',
      'li:contains("Uploaded") span'
    ];
    
    for (const selector of uploadedSelectors) {
      const elem = document.querySelector(selector);
      if (elem && elem.textContent.trim()) {
        uploaded = elem.textContent.trim();
        break;
      }
    }

    // Advanced download URL extraction
    const downloadButton = document.querySelector('#downloadButton');
    if (downloadButton) {
      // Method 1: data-scrambled-url (base64)
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      if (scrambledUrl) {
        try {
          downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
        } catch (e) {
          console.log('Base64 decoding failed, trying other methods');
        }
      }
      
      // Method 2: onclick attribute
      if (!downloadUrl) {
        const onClickAttr = downloadButton.getAttribute('onclick');
        if (onClickAttr) {
          const urlMatch = onClickAttr.match(/(https?:\/\/[^\s'"]+)/);
          if (urlMatch) downloadUrl = urlMatch[0];
        }
      }
      
      // Method 3: href attribute
      if (!downloadUrl) {
        const href = downloadButton.getAttribute('href');
        if (href && href.includes('http')) {
          downloadUrl = href;
        }
      }
    }

    // Fallback: Cari semua link yang mengandung download
    if (!downloadUrl) {
      const allLinks = document.querySelectorAll('a[href*="download"]');
      for (const link of allLinks) {
        const href = link.getAttribute('href');
        if (href && href.includes('mediafire.com')) {
          downloadUrl = href;
          break;
        }
      }
    }

    // Fallback 2: Cari dalam script tags
    if (!downloadUrl) {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const scriptContent = script.textContent;
        if (scriptContent.includes('download') && scriptContent.includes('http')) {
          const urlMatch = scriptContent.match(/(https?:\/\/[^\s'"]+\.mediafire\.com[^\s'"]*)/);
          if (urlMatch) {
            downloadUrl = urlMatch[0];
            break;
          }
        }
      }
    }

    // Get file extension from filename
    const fileExtension = fileName.includes('.') ? fileName.split('.').pop() : 'Unknown';

    const result = {
      success: true,
      data: {
        name: fileName,
        size: fileSize,
        extension: fileExtension,
        uploaded: uploaded,
        downloadUrl: downloadUrl,
        methodUsed: methodUsed,
        timestamp: new Date().toISOString()
      }
    };

    // Simpan ke cache
    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    // Auto-clean cache setiap 10 menit
    if (Math.random() < 0.1) { // 10% chance untuk cleanup
      const now = Date.now();
      for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_DURATION) {
          cache.delete(key);
        }
      }
    }

    return response.status(200).json(result);

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    
    // Retry logic dengan exponential backoff
    if (retry < 3) {
      const delay = Math.pow(2, retry) * 1000; // Exponential backoff: 2s, 4s, 8s
      console.log(`Retrying in ${delay}ms... Attempt ${parseInt(retry) + 1}/3`);
      
      await setTimeout(delay + Math.random() * 1000); // Tambah random jitter
      
      return handler({ 
        ...request, 
        query: { 
          ...request.query, 
          retry: parseInt(retry) + 1 
        } 
      }, response);
    }
    
    return response.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.',
      details: error.message 
    });
  }
}
