import axios from "axios"
import * as cheerio from "cheerio"

const resolvePinterestUrl = async (url) => {
  try {
    let res = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    }).catch((e) => e.response || e)

    let finalUrl = res.headers?.location || url

    if (/api\.pinterest\.com\/url_shortener/.test(finalUrl)) {
      let res2 = await axios.get(finalUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      }).catch((e) => e.response || e)
      finalUrl = res2.headers?.location || finalUrl
    }

    return finalUrl
  } catch (e) {
    return url
  }
}

export default async function handler(req, res) {
  try {
    const { url } = req.query
    if (!url) return res.status(400).json({ status: false, msg: "Masukkan parameter ?url=" })

    let pinterestUrl = await resolvePinterestUrl(url)
    if (!/pinterest\.com\/pin/.test(pinterestUrl)) {
      return res.status(400).json({ status: false, msg: "❌ URL bukan pin asli!" })
    }

    const apiUrl = `https://www.savepin.app/download.php?url=${encodeURIComponent(
      pinterestUrl
    )}&lang=en&type=redirect`

    const { data: html } = await axios.get(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0 Safari/537.36",
      },
      timeout: 15000,
    })

    const $ = cheerio.load(html)

    const extractMediaUrl = (el) => {
      const href = $(el).attr("href")
      if (!href) return null
      const match = href.match(/url=([^&]+)/)
      return match ? decodeURIComponent(match[1]) : null
    }

    const videoEl = $('a[href*="force-save.php?url="][href*=".mp4"]')
    const imgEl = $(
      'a[href*="force-save.php?url="][href*=".jpg"],a[href*="force-save.php?url="][href*=".png"],a[href*="force-save.php?url="][href*=".jpeg"]'
    )

    const videoUrl = videoEl.length ? extractMediaUrl(videoEl[0]) : null
    const imageUrl = imgEl.length ? extractMediaUrl(imgEl[0]) : null

    if (videoUrl) {
      return res.json({
        status: true,
        type: "video",
        url: videoUrl,
      })
    } else if (imageUrl) {
      return res.json({
        status: true,
        type: "image",
        url: imageUrl,
      })
    } else {
      return res.json({ status: false, msg: "Tidak dapat menemukan media." })
    }
  } catch (e) {
    return res.status(500).json({ status: false, msg: e.message })
  }
}
