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
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/') && !url.includes('/view/'))) {
      return response.status(400).json({ success: false, error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.' });
    }

    let html;
    let browser;

    try {
      // First try with cloudscraper
      html = await cloudscraper.get(url);
    } catch (error) {
      console.log('Cloudscraper failed, trying with Puppeteer...');
      
      // If cloudscraper fails, use Puppeteer as fallback
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      html = await page.content();
      await browser.close();
    }

    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Check if this is a view URL (contains '/view/')
    const isViewUrl = url.includes('/view/');

    // For view URLs, use different selectors
    if (isViewUrl) {
      // Extract file name from the specific element for view pages
      const fileNameElem = document.querySelector('a[onclick="aQn()"] span#image_filename');
      const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'Unknown';

      // Extract file size - need to find the correct selector for view pages
      let fileSize = 'Unknown';
      const detailsElements = document.querySelectorAll('.details__label, .info__label, .label');
      for (let elem of detailsElements) {
        if (elem.textContent.includes('Size') || elem.textContent.includes('Ukuran')) {
          const sizeValue = elem.nextElementSibling;
          if (sizeValue) {
            fileSize = sizeValue.textContent.trim();
            break;
          }
        }
      }

      // Fallback for size if not found with the above method
      if (fileSize === 'Unknown') {
        const sizeElem = document.querySelector('.file__size, .size__value, .info__size');
        if (sizeElem) {
          fileSize = sizeElem.textContent.trim();
        }
      }

      // Extract view URL for images
      let viewUrl = '';
      const viewerImg = document.querySelector('#viewer img');
      if (viewerImg) {
        viewUrl = viewerImg.getAttribute('src');
        // Ensure the URL has the correct protocol
        if (viewUrl && viewUrl.startsWith('//')) {
          viewUrl = 'https:' + viewUrl;
        }
      }
      
      // Alternative method to extract view URL if not found
      if (!viewUrl || viewUrl.includes('clear1x1.gif')) {
        const imgElements = document.querySelectorAll('img');
        for (let img of imgElements) {
          const src = img.getAttribute('src');
          if (src && src.includes('convkey') && !src.includes('clear1x1.gif')) {
            viewUrl = src;
            // Ensure the URL has the correct protocol
            if (viewUrl.startsWith('//')) {
              viewUrl = 'https:' + viewUrl;
            }
            break;
          }
        }
      }

      // Additional fallback - try to find any image that might be the preview
      if (!viewUrl || viewUrl.includes('clear1x1.gif')) {
        const possibleImages = document.querySelectorAll('img[src*="mediafire.com"]');
        for (let img of possibleImages) {
          const src = img.getAttribute('src');
          if (src && !src.includes('clear1x1.gif') && (src.includes('convkey') || src.includes('/image/'))) {
            viewUrl = src;
            // Ensure the URL has the correct protocol
            if (viewUrl.startsWith('//')) {
              viewUrl = 'https:' + viewUrl;
            }
            break;
          }
        }
      }

      return response.status(200).json({
        success: true,
        data: {
          name: fileName,
          size: fileSize,
          viewUrl: viewUrl,
          isView: true
        }
      });
    }

    // For regular file URLs, proceed with the original logic
    const fileNameElem = document.querySelector('.dl-btn-label');
    const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'Unknown';

    const fileSizeElem = document.querySelector('.details li:first-child span');
    const fileSize = fileSizeElem ? fileSizeElem.textContent.trim() : 'Unknown';

    const uploadedElem = document.querySelector('.details li:nth-child(2) span');
    const uploaded = uploadedElem ? uploadedElem.textContent.trim() : 'Unknown';

    // Extract download URL
    const downloadButton = document.querySelector('#downloadButton');
    let downloadUrl = '';

    if (downloadButton) {
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      if (scrambledUrl) {
        // Decode base64 to get the actual URL
        downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
      } else {
        // Alternative method to extract download URL
        const onClickAttr = downloadButton.getAttribute('onclick');
        if (onClickAttr && onClickAttr.includes('http')) {
          const urlMatch = onClickAttr.match(/(https?:\/\/[^\s'"]+)/);
          if (urlMatch) downloadUrl = urlMatch[0];
        }
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
        downloadUrl: downloadUrl,
        isView: false
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
