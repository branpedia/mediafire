import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Gunakan plugin stealth untuk bypass detection
puppeteer.use(StealthPlugin());
puppeteer.use(RecaptchaPlugin());

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
    if (method === 'puppeteer' || retry > 0) {
      result = await handleWithPuppeteer(url, response, retry);
    } else if (method === 'cloudscraper') {
      result = await handleWithCloudscraper(url, response);
    } else if (method === 'direct') {
      result = await handleDirectDownload(fileId, response);
    } else {
      // Auto mode - try multiple methods
      result = await handleWithCloudscraper(url, response);
      if (!result.success) {
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
    
    // Check if we need to generate a new key
    const generateKeyMsg = document.querySelector('.DownloadRepair-generateKeyMessage');
    if (generateKeyMsg) {
      return await handleDownloadRepair(url, response);
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

// Method 2: Puppeteer approach with stealth
async function handleWithPuppeteer(url, response, retry = 0) {
  let browser;
  try {
    // Launch puppeteer with stealth plugin
    browser = await puppeteer.launch({ 
      headless: true,
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
    
    // Check if we need to handle download repair
    const needsRepair = await page.$('.DownloadRepair-generateKeyMessage') !== null;
    if (needsRepair) {
      await browser.close();
      return await handleDownloadRepair(url, response);
    }
    
    // Check for Cloudflare challenge
    const isCloudflare = await page.$('#challenge-form') !== null;
    if (isCloudflare) {
      console.log('Cloudflare challenge detected, waiting for resolution...');
      // Wait for Cloudflare challenge to resolve
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    }
    
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
      
      // Method 3: Check for JSON data in pre elements
      const preElements = document.querySelectorAll('pre');
      for (const pre of preElements) {
        try {
          const jsonData = JSON.parse(pre.textContent);
          if (jsonData.success && jsonData.data && jsonData.data.downloadUrl) {
            return {
              type: 'json',
              url: jsonData.data.downloadUrl
            };
          }
        } catch (e) {
          // Not a JSON element, continue
        }
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
        error: 'Tidak dapat mengekstrak URL download dengan Puppeteer.',
        retryUrl: `/api/mediafire?url=${encodeURIComponent(url)}&retry=${parseInt(retry) + 1}&method=puppeteer`
      });
    }
  } catch (error) {
    if (browser) await browser.close();
    console.error('Error with puppeteer:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Puppeteer gagal: ' + error.message,
      retryUrl: `/api/mediafire?url=${encodeURIComponent(url)}&retry=${parseInt(retry) + 1}&method=direct`
    });
  }
}

// Method 3: Direct download approach (bypass HTML)
async function handleDirectDownload(fileId, response) {
  try {
    // Try to construct direct download URL
    const directUrl = `https://download${Math.floor(Math.random() * 10000)}.mediafire.com/${fileId}/file`;
    
    // Test if the URL is accessible
    const testResponse = await axios.head(directUrl, { timeout: 10000 });
    
    if (testResponse.status === 200) {
      return response.status(200).json({
        success: true,
        data: {
          name: fileId,
          size: '0MB',
          extension: 'unknown',
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: directUrl,
          method: 'direct'
        }
      });
    }
    
    return {
      success: false,
      error: 'Direct download tidak berhasil.'
    };
  } catch (error) {
    console.error('Error with direct download:', error);
    return {
      success: false,
      error: 'Direct download gagal: ' + error.message
    };
  }
}

// Handle download repair process
async function handleDownloadRepair(url, response) {
  let browser;
  try {
    // Extract file ID from URL
    const fileId = extractFileId(url);
    if (!fileId) {
      return response.status(400).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak ID file dari URL.' 
      });
    }
    
    const repairUrl = `https://www.mediafire.com/download_repair.php?flag=4&qkey=${fileId}`;
    
    // Use puppeteer to handle the repair process
    browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(repairUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for the continue button to be available
    await page.waitForSelector('.DownloadRepair-continue', { timeout: 10000 });
    
    // Click the continue button
    await page.click('.DownloadRepair-continue');
    
    // Wait for navigation to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    
    // Get the final URL
    const finalUrl = page.url();
    
    await browser.close();
    
    // If we got a direct download URL, return it
    if (finalUrl.includes('mediafire.com/')) {
      // Extract file info from the page if possible
      const fileInfo = {
        name: fileId,
        size: '0MB'
      };
      
      const extension = fileInfo.name.includes('.') ? 
        fileInfo.name.split('.').pop() : 'unknown';
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileInfo.name,
          size: fileInfo.size,
          extension: extension,
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: finalUrl,
          method: 'repair'
        }
      });
    } else {
      return response.status(500).json({ 
        success: false, 
        error: 'Proses perbaikan download tidak berhasil.' 
      });
    }
  } catch (error) {
    if (browser) await browser.close();
    console.error('Error in download repair:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan selama proses perbaikan download.' 
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
