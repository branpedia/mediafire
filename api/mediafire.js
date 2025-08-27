import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';

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
    return response.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const { url } = request.query;

  if (!url) {
    return response.status(400).json({
      success: false,
      error: 'Parameter URL diperlukan'
    });
  }

  try {
    // Validate MediaFire URL
    if (!url.includes('mediafire.com') || (!url.includes('/file/') && !url.includes('/download/'))) {
      return response.status(400).json({
        success: false,
        error: 'URL tidak valid. Pastikan URL berasal dari MediaFire.'
      });
    }

    // Use cloudscraper to bypass Cloudflare protection
    const html = await new Promise((resolve, reject) => {
      cloudscraper.get(url, (error, res, body) => {
        if (error) {
          reject(error);
        } else {
          resolve(body);
        }
      });
    });

    // Parse HTML with JSDOM
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // Extract file name
    const fileNameElement = document.querySelector('.dl-btn-label');
    const fileName = fileNameElement ? fileNameElement.getAttribute('title') || fileNameElement.textContent.trim() : 'Unknown File';

    // Extract download URL from data-scrambled-url attribute
    const downloadButton = document.querySelector('a[data-scrambled-url]');
    let downloadUrl = '';

    if (downloadButton) {
      const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
      if (scrambledUrl) {
        // Decode base64 URL
        downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
      }
    }

    // Alternative method to extract download URL from onclick handler
    if (!downloadUrl) {
      const onclickScript = html.match(/onclick="handleDelayedDownload\([^)]+\)"/);
      if (onclickScript) {
        const urlMatch = html.match(/data-scrambled-url="([^"]+)"/);
        if (urlMatch && urlMatch[1]) {
          downloadUrl = Buffer.from(urlMatch[1], 'base64').toString('utf8');
        }
      }
    }

    // Extract file size
    const fileSizeElement = document.querySelector('.file-size');
    const fileSize = fileSizeElement ? fileSizeElement.textContent.trim() : 'Unknown';

    // Extract upload date
    const uploadDateElement = document.querySelector('.date-added');
    const uploadDate = uploadDateElement ? uploadDateElement.textContent.trim() : 'Unknown';

    // Extract file extension
    const fileExtension = fileName.includes('.') ? 
      fileName.split('.').pop() : 'unknown';

    response.status(200).json({
      success: true,
      data: {
        name: fileName,
        size: fileSize,
        extension: fileExtension,
        uploaded: uploadDate,
        downloadUrl: downloadUrl
      }
    });

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    response.status(500).json({
      success: false,
      error: 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.'
    });
  }
}
