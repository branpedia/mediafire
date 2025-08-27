import cloudscraper from 'cloudscraper';
import { JSDOM } from 'jsdom';
import axios from 'axios';
import * as cheerio from 'cheerio';

// Remove puppeteer imports since they cause issues on Vercel

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

    // Use only CloudScraper and Axios methods (remove Puppeteer)
    let result = null;
    
    // Metode 1: CloudScraper + JSDOM
    try {
      result = await getWithCloudScraper(url);
      console.log('Metode CloudScraper berhasil');
    } catch (error) {
      console.log('Metode CloudScraper gagal:', error.message);
    }
    
    // Metode 2: Axios + Cheerio (jika metode 1 gagal)
    if (!result || !result.downloadUrl) {
      try {
        result = await getWithAxios(url);
        console.log('Metode Axios berhasil');
      } catch (error) {
        console.log('Metode Axios gagal:', error.message);
      }
    }

    if (!result || !result.downloadUrl) {
      throw new Error('Tidak dapat mengambil data dari MediaFire dengan metode apapun');
    }

    response.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Error fetching MediaFire data:', error);
    response.status(500).json({
      success: false,
      error: error.message || 'Gagal mengambil data dari MediaFire. Pastikan URL valid dan coba lagi.'
    });
  }
}

// Metode 1: CloudScraper + JSDOM
async function getWithCloudScraper(url) {
  return new Promise((resolve, reject) => {
    cloudscraper.get(url, (error, res, body) => {
      if (error) {
        reject(error);
        return;
      }
      
      try {
        const dom = new JSDOM(body);
        const document = dom.window.document;
        const result = extractMediaFireData(document, body);
        resolve(result);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// Metode 2: Axios + Cheerio
async function getWithAxios(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const body = response.data;
    
    // Ekstrak data menggunakan Cheerio
    const fileName = $('.dl-btn-label').attr('title') || $('.dl-btn-label').text().trim() || 'Unknown File';
    
    // Cari URL download
    let downloadUrl = '';
    const downloadButton = $('a[data-scrambled-url]');
    
    if (downloadButton.length) {
      const scrambledUrl = downloadButton.attr('data-scrambled-url');
      if (scrambledUrl) {
        downloadUrl = Buffer.from(scrambledUrl, 'base64').toString('utf8');
      }
    }
    
    // Jika tidak ditemukan, coba cari di dalam script
    if (!downloadUrl) {
      const scriptRegex = /data-scrambled-url="([^"]+)"/;
      const match = body.match(scriptRegex);
      if (match && match[1]) {
        downloadUrl = Buffer.from(match[1], 'base64').toString('utf8');
      }
    }
    
    // Extract file size
    let fileSize = 'Unknown';
    const sizeElement = $('.file-size');
    if (sizeElement.length) {
      fileSize = sizeElement.text().trim();
    } else {
      // Coba ekstrak dari teks tombol download
      const downloadText = $('#downloadButton').text();
      const sizeMatch = downloadText.match(/\(([^)]+)\)/);
      if (sizeMatch && sizeMatch[1]) {
        fileSize = sizeMatch[1];
      }
    }
    
    // Extract upload date
    const uploadDate = $('.date-added').text().trim() || $('.UploadedDate').text().trim() || 'Unknown';
    
    // Extract file extension
    const fileExtension = fileName.includes('.') ? 
      fileName.split('.').pop() : 'unknown';
    
    return {
      name: fileName,
      size: fileSize,
      extension: fileExtension,
      uploaded: uploadDate,
      downloadUrl: downloadUrl
    };
  } catch (error) {
    throw new Error(`Axios error: ${error.message}`);
  }
}

// Fungsi untuk mengekstrak data MediaFire dari DOM
function extractMediaFireData(document, body) {
  // Extract file name
  const fileNameElement = document.querySelector('.dl-btn-label');
  const fileName = fileNameElement ? 
    (fileNameElement.getAttribute('title') || fileNameElement.textContent.trim()) : 
    'Unknown File';

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
    const urlMatch = body.match(/data-scrambled-url="([^"]+)"/);
    if (urlMatch && urlMatch[1]) {
      downloadUrl = Buffer.from(urlMatch[1], 'base64').toString('utf8');
    }
  }

  // Extract file size
  let fileSize = 'Unknown';
  const fileSizeElement = document.querySelector('.file-size');
  if (fileSizeElement) {
    fileSize = fileSizeElement.textContent.trim();
  } else {
    // Coba ekstrak dari teks tombol download
    const downloadButtonText = document.querySelector('#downloadButton');
    if (downloadButtonText) {
      const downloadText = downloadButtonText.textContent;
      const sizeMatch = downloadText.match(/\(([^)]+)\)/);
      if (sizeMatch && sizeMatch[1]) {
        fileSize = sizeMatch[1];
      }
    }
  }

  // Extract upload date
  const uploadDateElement = document.querySelector('.date-added') || document.querySelector('.UploadedDate');
  const uploadDate = uploadDateElement ? uploadDateElement.textContent.trim() : 'Unknown';

  // Extract file extension
  const fileExtension = fileName.includes('.') ? 
    fileName.split('.').pop() : 'unknown';

  return {
    name: fileName,
    size: fileSize,
    extension: fileExtension,
    uploaded: uploadDate,
    downloadUrl: downloadUrl
  };
}
