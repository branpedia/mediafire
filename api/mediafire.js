import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import puppeteer from 'puppeteer';

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

    // Use cloudscraper to bypass Cloudflare protection
    const html = await cloudscraper.get(url);
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract file name
    const fileNameElement = document.querySelector('span#image_filename');
    const fileName = fileNameElement ? fileNameElement.textContent : 'Unknown';

    // Extract file size, uploaded date, etc. (you'll need to adjust selectors based on actual page structure)
    const detailsElements = document.querySelectorAll('.details li');
    let fileSize = 'Unknown';
    let uploadedDate = 'Unknown';

    detailsElements.forEach(element => {
      const text = element.textContent;
      if (text.includes('Size')) {
        fileSize = text.replace('Size', '').trim();
      }
      if (text.includes('Uploaded')) {
        uploadedDate = text.replace('Uploaded', '').trim();
      }
    });

    // Extract download URL - this is the most challenging part
    // MediaFire often requires interaction to generate download link
    let downloadUrl = '';

    // Method 1: Try to find direct download link in the page
    const downloadButton = document.querySelector('a#downloadButton');
    if (downloadButton) {
      downloadUrl = downloadButton.href;
    }

    // Method 2: If not found, try to construct it from the file info
    if (!downloadUrl) {
      // This is a common pattern for MediaFire direct links
      const fileIdMatch = url.match(/mediafire\.com\/(?:file|download)\/([^\/]+)/);
      if (fileIdMatch && fileIdMatch[1]) {
        downloadUrl = `https://download${Math.floor(Math.random() * 10000)}.mediafire.com/${fileIdMatch[1]}/${encodeURIComponent(fileName)}`;
      }
    }

    // Method 3: Use Puppeteer as a last resort for JavaScript-heavy pages
    if (!downloadUrl && retry < 2) {
      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      
      // Set a realistic user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      // Wait for the download button to appear
      try {
        await page.waitForSelector('a#downloadButton', { timeout: 10000 });
        downloadUrl = await page.$eval('a#downloadButton', el => el.href);
      } catch (e) {
        console.log('Download button not found with Puppeteer');
      }
      
      await browser.close();
    }

    // If we still don't have a download URL, return an error
    if (!downloadUrl) {
      return response.status(500).json({ 
        success: false, 
        error: 'Tidak dapat menghasilkan URL download. Silakan coba lagi.' 
      });
    }

    // Get file extension
    const fileExtension = fileName.includes('.') ? fileName.split('.').pop() : 'Unknown';

    return response.status(200).json({
      success: true,
      data: {
        name: fileName,
        size: fileSize,
        extension: fileExtension,
        uploaded: uploadedDate,
        downloadUrl: downloadUrl
      }
    });

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);

    // Retry logic
    const retryCount = parseInt(retry);
    if (retryCount < 3) {
      // Exponential backoff
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Return a retry instruction to the client
      return response.status(200).json({
        success: false,
        error: `Mencoba kembali (${retryCount + 1}/3)`,
        retry: retryCount + 1
      });
    }

    return response.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data dari MediaFire. Silakan coba lagi nanti.' 
    });
  }
}
