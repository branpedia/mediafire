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

    // Check if it's an image view URL
    if (url.includes('/view/')) {
      return await handleImageView(url, response);
    }

    // Check if we need to repair download (retry mode)
    if (retry > 0) {
      return await handleDownloadRepair(url, response);
    }

    // First try with cloudscraper to bypass Cloudflare
    try {
      const html = await cloudscraper.get(url);
      const dom = new JSDOM(html);
      const document = dom.window.document;

      // Check if download button exists
      const downloadButton = document.querySelector('#downloadButton');
      if (downloadButton && downloadButton.getAttribute('data-scrambled-url')) {
        const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
        const decodedUrl = Buffer.from(scrambledUrl, 'base64').toString('utf-8');
        
        // Extract filename
        const fileNameElem = document.querySelector('.filename');
        const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'file';
        
        // Extract file size
        const fileSizeElem = document.querySelector('.file-size');
        const fileSize = fileSizeElem ? fileSizeElem.textContent.trim() : '0MB';
        
        // Extract extension
        const extension = fileName.includes('.') ? fileName.split('.').pop() : 'unknown';
        
        return response.status(200).json({
          success: true,
          data: {
            name: fileName,
            size: fileSize,
            extension: extension,
            uploaded: new Date().toLocaleString('id-ID'),
            downloadUrl: decodedUrl
          }
        });
      }
      
      // Check if we need to generate a new key
      const generateKeyMsg = document.querySelector('.DownloadRepair-generateKeyMessage');
      if (generateKeyMsg) {
        // We need to repair the download
        return await handleDownloadRepair(url, response);
      }
      
      // Check if download URL is empty in the JSON response
      const preElements = document.querySelectorAll('pre');
      for (const pre of preElements) {
        try {
          const jsonData = JSON.parse(pre.textContent);
          if (jsonData.success && jsonData.data && (!jsonData.data.downloadUrl || jsonData.data.downloadUrl === '')) {
            // We need to repair the download
            return await handleDownloadRepair(url, response);
          }
        } catch (e) {
          // Not a JSON element, continue
        }
      }
      
      // If we reach here, we couldn't extract the download URL
      return response.status(500).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak URL download. Silakan coba lagi.',
        retryUrl: `/api/mediafire?url=${encodeURIComponent(url)}&retry=1`
      });
      
    } catch (error) {
      console.error('Error with cloudscraper:', error);
      // Fallback to puppeteer if cloudscraper fails
      return await handleWithPuppeteer(url, response);
    }

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan saat memproses permintaan. Silakan coba lagi.' 
    });
  }
}

// Handle image view URLs
async function handleImageView(url, response) {
  try {
    const html = await cloudscraper.get(url);
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    const imgElement = document.querySelector('.mainImage img');
    if (imgElement && imgElement.src) {
      const src = imgElement.src;
      
      // Extract filename from URL or page
      const fileNameElem = document.querySelector('.filename');
      const fileName = fileNameElem ? fileNameElem.textContent.trim() : 'image.jpg';
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileName,
          size: '0MB', // Size not available for images
          extension: fileName.includes('.') ? fileName.split('.').pop() : 'jpg',
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: src
        }
      });
    } else {
      return response.status(500).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak URL gambar.' 
      });
    }
  } catch (error) {
    console.error('Error handling image view:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan saat memproses gambar.' 
    });
  }
}

// Handle download repair process
async function handleDownloadRepair(url, response) {
  try {
    // Extract file ID from URL
    const match = url.match(/mediafire\.com\/(?:file\/|download\/|view\/)([^\/]+)/);
    if (!match || !match[1]) {
      return response.status(400).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak ID file dari URL.' 
      });
    }
    
    const fileId = match[1];
    const repairUrl = `https://www.mediafire.com/download_repair.php?flag=4&qkey=${fileId}`;
    
    // Use puppeteer to handle the repair process
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(repairUrl, { waitUntil: 'networkidle2' });
    
    // Wait for the continue button to be available
    await page.waitForSelector('.DownloadRepair-continue', { timeout: 10000 });
    
    // Click the continue button
    await page.click('.DownloadRepair-continue');
    
    // Wait for navigation to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    // Get the final URL
    const finalUrl = page.url();
    
    await browser.close();
    
    // If we got a direct download URL, return it
    if (finalUrl.includes('mediafire.com/')) {
      return response.status(200).json({
        success: true,
        data: {
          name: 'file',
          size: '0MB',
          extension: 'unknown',
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: finalUrl
        }
      });
    } else {
      return response.status(500).json({ 
        success: false, 
        error: 'Proses perbaikan download tidak berhasil.' 
      });
    }
  } catch (error) {
    console.error('Error in download repair:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Terjadi kesalahan selama proses perbaikan download.' 
    });
  }
}

// Fallback to puppeteer if cloudscraper fails
async function handleWithPuppeteer(url, response) {
  try {
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    
    // Check if we need to handle download repair
    const needsRepair = await page.$('.DownloadRepair-generateKeyMessage') !== null;
    if (needsRepair) {
      await browser.close();
      return await handleDownloadRepair(url, response);
    }
    
    // Try to extract download URL
    const downloadUrl = await page.evaluate(() => {
      // Check for download button with scrambled URL
      const downloadButton = document.querySelector('#downloadButton');
      if (downloadButton && downloadButton.getAttribute('data-scrambled-url')) {
        const scrambledUrl = downloadButton.getAttribute('data-scrambled-url');
        return atob(scrambledUrl);
      }
      
      // Check for direct download link
      const directLink = document.querySelector('.input.popsok[href*="download"]');
      if (directLink && directLink.href) {
        return directLink.href;
      }
      
      return null;
    });
    
    await browser.close();
    
    if (downloadUrl) {
      // Extract filename from URL
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      const fileName = pathParts[pathParts.length - 1] || 'file';
      
      return response.status(200).json({
        success: true,
        data: {
          name: fileName,
          size: '0MB',
          extension: fileName.includes('.') ? fileName.split('.').pop() : 'unknown',
          uploaded: new Date().toLocaleString('id-ID'),
          downloadUrl: downloadUrl
        }
      });
    } else {
      return response.status(500).json({ 
        success: false, 
        error: 'Tidak dapat mengekstrak URL download dengan Puppeteer.' 
      });
    }
  } catch (error) {
    console.error('Error with puppeteer:', error);
    return response.status(500).json({ 
      success: false, 
      error: 'Semua metode ekstraksi URL download gagal.' 
    });
  }
}
