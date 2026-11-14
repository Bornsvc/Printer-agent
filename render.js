const { createCanvas, GlobalFonts, Image } = require('@napi-rs/canvas')
const path = require('path')
const fs = require('fs')
const fetch = require('node-fetch')
const QRCode = require('qrcode')

// ⚠️ REQUIRED: a Thai-capable font at print-agent/fonts/NotoSansThai-Regular.ttf
// (full glyph set, not a script-only subset — subsetted downloads from Google
// Fonts can be missing Basic Latin, which silently drops digits/punctuation
// and prints tofu boxes instead of numbers/prices).
// Most thermal printers do NOT have a built-in Thai codepage, so we render
// text to an image ourselves instead of sending raw text to the printer.
const FONT_PATH = path.join(__dirname, 'fonts', 'NotoSansThai-Regular.ttf')
const FONT_FAMILY = 'ThaiFont'

if (fs.existsSync(FONT_PATH)) {
  GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY)
} else {
  console.warn(
    '⚠️  Thai font not found at print-agent/fonts/NotoSansThai-Regular.ttf — ' +
      'Thai text will not render correctly until you add it.'
  )
}

// Lao glyphs (ໂຕະ, ລວມທັງໝົດ, Lao item names...) — the Thai font has none,
// so without this Lao text prints as blanks/tofu boxes. Registered under its
// own family and listed alongside ThaiFont in FONT_STACK below, so each
// character falls back to whichever font actually has it: Thai + Lao + digits
// can all mix on the same line regardless of PRINT_LANGUAGE.
const LAO_FONT_PATH = path.join(__dirname, 'fonts', 'NotoSansLao-VariableFont.ttf')
const LAO_FONT_FAMILY = 'LaoFont'

if (fs.existsSync(LAO_FONT_PATH)) {
  GlobalFonts.registerFromPath(LAO_FONT_PATH, LAO_FONT_FAMILY)
} else {
  console.warn(
    '⚠️  Lao font not found at print-agent/fonts/NotoSansLao-VariableFont.ttf — ' +
      'Lao text will not render correctly until you add it.'
  )
}

// 80mm thermal paper prints 576 dots wide at 203dpi (its printable area is
// ~72mm — the rest is margin the printer itself reserves). ESC/POS image
// printing does NOT center a narrower image on a wider print head; it just
// starts at the left edge — so this must match the paper actually loaded, or
// everything prints hugging the left with dead space on the right. Change to
// 384 if a station is loaded with 58mm paper instead.
const WIDTH = 576
const LINE_HEIGHT = 30
const MARGIN = 16

// Fixed labels printed on receipts/KOTs. Data from the API (restaurant name,
// notes, stationLabel, discountName) prints as-is in whatever language it was
// entered in — only these hardcoded strings switch, plus item names (see
// itemName below). PRINT_LANGUAGE in .env picks the set; unset/unknown falls
// back to Thai.
const LABELS = {
  th: {
    table: 'โต๊ะ',
    subtotal: 'รวมย่อย',
    serviceCharge: 'ค่าบริการ',
    discount: 'ส่วนลด',
    excludesDrinks: 'ไม่รวมเครื่องดื่ม',
    total: 'รวมทั้งหมด',
    received: 'รับเงิน',
    change: 'เงินทอน',
    scanToPay: 'สแกนเพื่อชำระเงิน',
    thankYou: 'ขอบคุณที่ใช้บริการ',
    scanToOrder: 'สแกนเพื่อสั่งอาหาร',
    openedAt: 'เปิดโต๊ะ',
    printerTest: 'ทดสอบเครื่องพิมพ์',
    itemNo: 'ลำดับ',
    itemName: 'รายการ',
    itemQty: 'จำนวน',
    itemPrice: 'ราคา',
    itemAmount: 'รวม',
    billCode: 'รหัสบิล',
    date: 'วันที่',
    time: 'เวลา',
    cashier: 'พนักงานเช็คบิล',
    roles: { admin: 'ผู้ดูแลระบบ', cashier: 'แคชเชียร์' },
    dateLocale: 'lo-LA',
  },
  en: {
    table: 'Table',
    subtotal: 'Subtotal',
    serviceCharge: 'Service charge',
    discount: 'Discount',
    excludesDrinks: 'Excludes drinks',
    total: 'Total',
    received: 'Received',
    change: 'Change',
    scanToPay: 'Scan to pay',
    thankYou: 'Thank you',
    scanToOrder: 'Scan to order',
    openedAt: 'Opened',
    printerTest: 'Printer test',
    itemNo: 'No.',
    itemName: 'Item',
    itemQty: 'Qty',
    itemPrice: 'Price',
    itemAmount: 'Amount',
    billCode: 'Bill code',
    date: 'Date',
    time: 'Time',
    cashier: 'Checked by',
    roles: { admin: 'Admin', cashier: 'Cashier' },
    dateLocale: 'en-GB',
  },
  lo: {
    table: 'ໂຕະ',
    subtotal: 'ລວມຍ່ອຍ',
    serviceCharge: 'ຄ່າບໍລິການ',
    discount: 'ສ່ວນຫຼຸດ',
    excludesDrinks: 'ບໍ່ລວມເຄື່ອງດື່ມ',
    total: 'ລວມທັງໝົດ',
    received: 'ຮັບເງິນ',
    change: 'ເງິນທອນ',
    scanToPay: 'ສະແກນເພື່ອຊຳລະເງິນ',
    thankYou: 'ຂອບໃຈທີ່ໃຊ້ບໍລິການ',
    scanToOrder: 'ສະແກນເພື່ອສັ່ງອາຫານ',
    openedAt: 'ເປີດໂຕະ',
    printerTest: 'ທົດສອບເຄື່ອງພິມ',
    itemNo: 'ລຳດັບ',
    itemName: 'ລາຍການ',
    itemQty: 'ຈຳນວນ',
    itemPrice: 'ລາຄາ',
    itemAmount: 'ລວມ',
    billCode: 'ລະຫັດບິນ',
    date: 'ວັນທີ',
    time: 'ເວລາ',
    cashier: 'ພະນັກງານເຊັກບິນ',
    roles: { admin: 'ຜູ້ດູແລ', cashier: 'ພະນັກງານເຄົ້າເຕີ້' },
    dateLocale: 'lo-LA',
  }
}
const PRINT_LANGUAGE = (process.env.PRINT_LANGUAGE || 'th').trim().toLowerCase()
const T = LABELS[PRINT_LANGUAGE] || LABELS.th

// Currency on printed amounts. Mirrors the web app's lib/currencies.ts.
// PRINT_CURRENCY in .env (THB / LAK / USD) wins when set — it pins this
// printer to one currency no matter what the job says. Otherwise the job's
// own `currency` (the restaurant's setting in /admin/settings) is used, then
// THB for jobs from app versions that don't send one.
const CURRENCIES = {
  THB: { symbol: '฿', decimals: 0 },
  LAK: { symbol: '₭', decimals: 0 },
  USD: { symbol: '$', decimals: 2 },
}
const PRINT_CURRENCY = (process.env.PRINT_CURRENCY || '').trim().toUpperCase()
if (PRINT_CURRENCY && !CURRENCIES[PRINT_CURRENCY]) {
  console.warn(`⚠️  Unknown PRINT_CURRENCY "${PRINT_CURRENCY}" — expected THB, LAK or USD. Ignoring it.`)
}

function currencyFor(data) {
  return CURRENCIES[PRINT_CURRENCY] || CURRENCIES[data.currency] || CURRENCIES.THB
}

// Plain amount (line totals) and amount with symbol (subtotal, total, ...).
function amount(value, cur) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: cur.decimals,
    maximumFractionDigits: cur.decimals,
  })
}
function money(value, cur) {
  return `${cur.symbol}${amount(value, cur)}`
}

// Item names: the API sends the base (Thai) `name` plus optional per-locale
// `names` ({ lo, en } — only the ones an admin translated). Print the one for
// PRINT_LANGUAGE when there is one, otherwise the base name. Older app
// versions don't send `names` at all, which just means the base name.
function itemName(item) {
  const translated = item.names && item.names[PRINT_LANGUAGE]
  return typeof translated === 'string' && translated.trim() ? translated : item.name
}

// Primary font follows PRINT_LANGUAGE (so Lao receipts get Lao-styled digits
// and punctuation); the other font is the per-character fallback.
const FONT_STACK =
  PRINT_LANGUAGE === 'lo' ? `${LAO_FONT_FAMILY}, ${FONT_FAMILY}` : `${FONT_FAMILY}, ${LAO_FONT_FAMILY}`

const RECEIPT_LINE_HEIGHT = 46
const RECEIPT_TEXT_SIZE = 36

// Gap after a divider before the next text baseline — must clear that text's
// ascent (roughly 0.7-0.8x its font size) or the divider line visually cuts
// through it. Was a flat 25px tuned for the original 22px text; derived from
// RECEIPT_TEXT_SIZE now so bumping the size again (as happened once already)
// can't reintroduce the same overlap.
const RECEIPT_DIVIDER_GAP = Math.round(RECEIPT_TEXT_SIZE * 1.14)

// Runtime-refreshable image asset (logo, payment QR — both optional,
// per-tenant). A tenant sets these from /admin/settings in the main app;
// printer.js polls /api/printer-config every 60s and calls sync(url) here
// with whatever that tenant currently has configured. Unset (null) means no
// image at all — this agent serves whichever tenant its own agentKey
// belongs to, so there's no sensible "generic fallback image" to show a
// restaurant that hasn't set its own; layoutReceipt already skips the whole
// logo/QR block when `.image` is null, so an unconfigured tenant's receipts
// just print without one, same as before this feature existed. Caches the
// last-synced remote image to disk (under assets/cache/) so a network
// hiccup — or the agent restarting — doesn't blank out a tenant's real,
// already-configured branding; sync() only re-fetches when the URL changed.
//
// img.complete reports true the instant src is set, but drawImage silently
// paints nothing until decode() actually resolves — so callers must await
// `ready` before the first receipt is rendered, or the image draws blank.
const CACHE_DIR = path.join(__dirname, 'assets', 'cache')

function createImageAsset(name) {
  const cacheBinPath = path.join(CACHE_DIR, `${name}.bin`)
  const cacheUrlPath = path.join(CACHE_DIR, `${name}.url`)
  const asset = { image: null }
  let currentUrl = null // null = no image configured (or the fetch for it never succeeded)

  async function decode(buf) {
    const img = new Image()
    img.src = buf
    await img.decode()
    return img
  }

  // Best-effort initial load from a previously-cached remote image, so a
  // restart doesn't blank a tenant's real branding while waiting on the
  // next network sync. No cache yet (or unreadable) just means no image
  // until the first successful sync() — never throws.
  asset.ready = (async () => {
    const cachedUrl = fs.existsSync(cacheUrlPath) ? fs.readFileSync(cacheUrlPath, 'utf8').trim() : ''
    if (!cachedUrl || !fs.existsSync(cacheBinPath)) return
    try {
      asset.image = await decode(fs.readFileSync(cacheBinPath))
      currentUrl = cachedUrl
    } catch (err) {
      console.warn(`⚠️  Cached ${name} image unreadable:`, err.message)
    }
  })()

  // Called by printer.js after each /api/printer-config poll. Returns
  // whether the displayed image actually changed; never throws — a failed
  // fetch just keeps showing the last known-good image. A tenant admin
  // controls this URL (see BillBrandingForm's paste-URL field) and it's
  // fetched from this machine's network on every poll, so both a timeout and
  // a size cap are required, not just good practice — node-fetch v2 has no
  // default timeout, and a host that accepts the connection but never
  // responds (a captive portal, a stalled proxy) would otherwise hang this
  // promise forever. That's fatal here: printer.js awaits this inside the
  // same try/finally that calls markReady(), which index.js awaits before
  // ever starting to poll for print jobs — so a single stuck fetch would
  // silently stop the whole agent from printing anything, not just branding.
  asset.sync = async (url) => {
    const next = url || null
    if (next === currentUrl) return false

    if (!next) {
      asset.image = null
      currentUrl = null
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true })
        fs.writeFileSync(cacheUrlPath, '')
      } catch (err) {
        console.warn(`⚠️  Failed to clear cached ${name} image:`, err.message)
      }
      return true
    }

    try {
      const res = await fetch(next, { timeout: 10_000, size: 10 * 1024 * 1024 })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.buffer()
      const img = await decode(buf)
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      fs.writeFileSync(cacheBinPath, buf)
      fs.writeFileSync(cacheUrlPath, next)
      asset.image = img
      currentUrl = next
      return true
    } catch (err) {
      console.warn(`⚠️  Failed to sync ${name} image from ${next} (keeping last known image):`, err.message)
      return false
    }
  }

  return asset
}

// Scales an image down to fit within maxWidth x maxHeight (never up),
// preserving aspect ratio — stretching a QR code even slightly can make it
// fail to scan. Clamping height as well as width matters now that these can
// be admin-uploaded rather than only a manually-vetted local file: an
// extreme aspect ratio (e.g. a phone screenshot) clamped on width alone
// could still come out over 1000px tall, and a receipt whose total height
// (text + images) crosses a few thousand px is a confirmed real hardware
// failure — see MAX_PAGE_HEIGHT's comment on the printer's raster parser
// desyncing and printing garbled output instead of the image.
function scaledDims(image, maxWidth, maxHeight) {
  if (!image) return null
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)
  return { width: image.width * scale, height: image.height * scale }
}

// Converts an image to pure black/white via Floyd-Steinberg error-diffusion
// dithering, composited onto a white background first (so a transparent
// background — e.g. from a background-removal tool — becomes "no ink", not
// black). This exists because the physical printer's own image conversion
// (node-thermal-printer's EPSON driver, in node_modules — not our code) does
// a hard per-pixel luminance threshold with no dithering at all: every pixel
// below 128 grayscale prints as ink, everything else prints as nothing.
// A logo in light/pastel colors can have EVERY pixel above that threshold —
// confirmed on a real uploaded logo (solid gold/orange text, grayscale
// 167-182 throughout) — so it renders correctly in the PNG preview shown in
// /admin/settings but prints as a completely blank patch of paper, not just
// faded. Dithering spreads each pixel's rounding error to its neighbors, so
// a mid-tone color comes out as a recognizable stippled pattern instead of
// vanishing outright. Runs fresh per receipt render (at whatever the logo's
// final on-paper size is) rather than once at sync time, since MAX_PAGE_HEIGHT's
// shrink pass can change that size receipt to receipt — dithering a fixed
// source size and later resizing it would just reintroduce the same soft
// gray edges dithering exists to remove. Cheap enough either way: at most
// LOGO_MAX_WIDTH x LOGO_MAX_HEIGHT (320x320) pixels.
//
// Deliberately not used for the QR code — a real QR is already black/white,
// so there's no washing-out problem to fix, and this codebase already treats
// "don't distort a QR's fine modules" as a hard rule (see scaledDims' own
// comment above): dithering's error diffusion could bleed across module
// edges exactly where downscaling has already softened them, which is a
// risk worth avoiding for zero benefit on an image that doesn't need it.
function ditherToBlackWhite(image, width, height) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(image, 0, 0, w, h)

  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const old = gray[i]
      const black = old < 128
      const err = old - (black ? 0 : 255)

      if (x + 1 < w) gray[i + 1] += (err * 7) / 16
      if (y + 1 < h) {
        if (x > 0) gray[i - 1 + w] += (err * 3) / 16
        gray[i + w] += (err * 5) / 16
        if (x + 1 < w) gray[i + 1 + w] += (err * 1) / 16
      }

      const out = black ? 0 : 255
      const di = i * 4
      data[di] = out
      data[di + 1] = out
      data[di + 2] = out
      data[di + 3] = 255
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

// Optional restaurant logo printed at the top of RECEIPT tickets (not KOTs —
// kitchen slips stay logo-free to save paper/time). Set from /admin/settings
// (see BillBrandingForm.tsx); receipts print without a logo until a tenant
// uploads one.
const LOGO_MAX_WIDTH = 320
const LOGO_MAX_HEIGHT = 320
const LOGO_MARGIN_BOTTOM = 14
const logo = createImageAsset('logo')
const logoReady = logo.ready

// Optional payment QR code printed near the total on RECEIPT tickets. Set
// from /admin/settings, same as the logo above.
const QR_MAX_WIDTH = 260
const QR_MAX_HEIGHT = 260
const QR_MARGIN_TOP = 16
const qr = createImageAsset('qr')
const qrReady = qr.ready

// Called by printer.js's refreshPrinterConfig() after each /api/printer-config
// poll, with that tenant's current { logoUrl, paymentQrUrl } (either may be
// null). Returns which images actually changed, for logging.
async function syncBranding({ logoUrl, paymentQrUrl } = {}) {
  const [logoChanged, qrChanged] = await Promise.all([logo.sync(logoUrl), qr.sync(paymentQrUrl)])
  return { logoChanged, qrChanged }
}

// Splits text into lines no wider than maxWidth at the given font size, so a
// long item name (English names especially) wraps instead of running into
// the price column or off the paper. Thai/Lao have no spaces between words,
// so breaking uses Intl.Segmenter's dictionary word boundaries rather than
// spaces, falling back to whole characters (graphemes — never splitting a
// vowel/tone mark off its consonant) for a single word wider than the line.
const measureCtx = createCanvas(1, 1).getContext('2d')
const wordSegmenter = new Intl.Segmenter(PRINT_LANGUAGE, { granularity: 'word' })
const graphemeSegmenter = new Intl.Segmenter(PRINT_LANGUAGE, { granularity: 'grapheme' })

function wrapText(text, maxWidth, size, bold = false) {
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_STACK}`
  const fits = (t) => measureCtx.measureText(t).width <= maxWidth
  if (fits(text)) return [text]

  const lines = []
  let current = ''
  for (const { segment } of wordSegmenter.segment(text)) {
    if (fits(current + segment)) {
      current += segment
      continue
    }
    if (current.trim()) lines.push(current.trimEnd())
    current = segment.trimStart()
    // One word on its own is still too wide — break it by character.
    while (!fits(current)) {
      let head = ''
      for (const { segment: ch } of graphemeSegmenter.segment(current)) {
        if (!fits(head + ch) && head) break
        head += ch
      }
      lines.push(head)
      current = current.slice(head.length)
    }
  }
  if (current.trim()) lines.push(current.trimEnd())
  return lines
}

function drawLine(ctx, y, text, opts = {}, textSize = 22) {
  const { size = textSize, bold = false, align = 'left', x: xOverride } = opts
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_STACK}`
  ctx.fillStyle = '#000'
  ctx.textAlign = align
  const x = xOverride ?? (align === 'center' ? WIDTH / 2 : align === 'right' ? WIDTH - MARGIN : MARGIN)
  ctx.fillText(text, x, y)
}

function drawDivider(ctx, y, dashed = false) {
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1
  if (dashed) ctx.setLineDash([8, 5])
  ctx.beginPath()
  ctx.moveTo(MARGIN, y)
  ctx.lineTo(WIDTH - MARGIN, y)
  ctx.stroke()
  if (dashed) ctx.setLineDash([])
}

// Soft target height, in dots, for a single receipt image. Not a spec limit —
// ESC/POS's GS v 0 raster command technically allows up to 65535 — it's a
// REAL, observed hardware/firmware limit: a 3256px (~407mm) receipt got the
// printer's raster parser to desync entirely and print garbled characters
// instead of the image (confirmed on the actual printer — see
// scripts/test-long-receipt.js). 1876px printed correctly. Receipts are
// always a single slip (staff want one bill, never a "(continued)" cut), so
// whenever the content would land above this, the whole layout is scaled
// down — see MIN_RECEIPT_SCALE — instead of splitting into multiple pages.
// A bill so long it still doesn't fit even at the minimum readable scale
// prints taller than this target rather than ever being cut into two.
const MAX_PAGE_HEIGHT = 1600

// Floor on how far a long bill gets shrunk before we give up shrinking and
// just let the page grow past MAX_PAGE_HEIGHT — 36 * 0.6 = ~22px, the size
// this receipt text used to run at full-time (see "up text size" in git
// history) before it was bumped to 36, so it's a known-readable minimum
// rather than an untested guess.
const MIN_RECEIPT_SCALE = 0.6

// Receipt date/time pieces are printed in Laos/Thailand time (UTC+7, no DST)
// no matter what timezone this machine is set to — the main app sends them as
// ISO instants. null for anything that isn't a real date, so a malformed value
// drops its line instead of printing "Invalid Date".
const RECEIPT_TZ = 'Asia/Bangkok'
function receiptDateParts(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!value || Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: RECEIPT_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  )
  return { date: `${parts.day}-${parts.month}-${parts.year}`, time: `${parts.hour}:${parts.minute}:${parts.second}` }
}

const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')

// Lays out a full receipt at a given scale and returns the draw ops plus the
// resulting height, without touching a canvas. renderReceiptImage calls this
// once at scale 1 to measure the natural height, then (if that's over
// MAX_PAGE_HEIGHT) again at a smaller scale. Shrinking the font size alone
// would NOT shrink the total height — each line's vertical position is
// driven by the line-height increment, not the glyph size — so every
// vertical measurement here (line height, gaps, margins) scales together.
function layoutReceipt(data, logoDims, qrDims, scale) {
  const cur = currencyFor(data)
  const curCode = Object.keys(CURRENCIES).find((code) => CURRENCIES[code] === cur)
  const sz = (px) => Math.round(px * scale)
  const lineHeight = sz(RECEIPT_LINE_HEIGHT)
  const textSize = sz(RECEIPT_TEXT_SIZE)
  const dividerGap = Math.round(textSize * 1.14)
  // Header details and the item table run smaller than the totals so a
  // five-column row still fits 576 dots.
  const infoSize = sz(28)
  const infoLine = sz(38)
  const tableSize = sz(28)
  const tableLine = sz(38)
  const innerWidth = WIDTH - MARGIN * 2

  const ops = []
  // Text is drawn from its baseline, so with no logo above it the first line
  // needs its own ascent of room or its top gets clipped off the paper.
  let y = sz(logoDims ? 20 : 44)

  // Header — width/height go through sz() too (not just the margin below
  // them), so the MAX_PAGE_HEIGHT shrink pass actually shrinks an oversized
  // image along with the text instead of leaving it at full size while the
  // text around it gets smaller.
  if (logoDims) {
    const w = sz(logoDims.width)
    const h = sz(logoDims.height)
    ops.push({ image: logo.image, x: (WIDTH - w) / 2, y, width: w, height: h, dither: true })
    y += h + sz(LOGO_MARGIN_BOTTOM)
  }

  // Up to 60 characters from /admin/settings — wrapped, not drawn as one line,
  // or a long name gets clipped at both paper edges.
  const restaurantName = nonEmptyString(data.restaurantName)
  if (restaurantName) {
    for (const text of wrapText(restaurantName, innerWidth, textSize, true)) {
      ops.push({ y, text, opts: { size: textSize, bold: true, align: 'center' } })
      y += lineHeight
    }
    y += sz(6)
  }

  ops.push({ y, text: `${T.table} ${data.tableNumber}`, opts: { size: sz(34), bold: true, align: 'center' } })
  y += lineHeight + sz(6)

  // "Label: value" rows, left-aligned, value in bold. A value too long for the
  // rest of the line wraps and its continuation lines stay under the value.
  const infoRow = (label, value) => {
    const prefix = label ? `${label}: ` : ''
    measureCtx.font = `${infoSize}px ${FONT_STACK}`
    const prefixWidth = prefix ? measureCtx.measureText(prefix).width : 0
    // A label taking up much of the line would squeeze its value into a
    // sliver of a column — give it its own (wrapped) line(s) and let the
    // value use the full width underneath.
    const stacked = prefixWidth > innerWidth * 0.45
    if (stacked) {
      for (const text of wrapText(`${label}:`, innerWidth, infoSize)) {
        ops.push({ y, text, opts: { size: infoSize, align: 'left' } })
        y += infoLine
      }
    }
    const valueX = stacked ? MARGIN : MARGIN + prefixWidth
    const valueLines = wrapText(value, WIDTH - MARGIN - valueX, infoSize, true)
    if (prefix && !stacked) ops.push({ y, text: prefix, opts: { size: infoSize, align: 'left' } })
    for (const text of valueLines) {
      ops.push({ y, text, opts: { size: infoSize, bold: true, align: 'left', x: valueX } })
      y += infoLine
    }
  }

  // Admin-defined contact rows (phone, WhatsApp, address...) from
  // /admin/settings — see lib/receipt-info.ts in the main app. Validated here
  // again: the payload is JSON from the network, and one malformed row must
  // not take the whole receipt down.
  const headerLines = Array.isArray(data.headerLines) ? data.headerLines : []
  for (const row of headerLines) {
    const value = nonEmptyString(row && row.value)
    if (value) infoRow(nonEmptyString(row.label), value)
  }

  const billCode = nonEmptyString(data.billCode)
  if (billCode) infoRow(T.billCode, billCode)

  // Date + "opened - closed" time range. `closedAt` is when this slip was
  // issued; without it (old app versions) fall back to the print time like
  // the receipt always did.
  const closed = receiptDateParts(data.closedAt) || receiptDateParts(new Date())
  const opened = receiptDateParts(data.openedAt)
  infoRow(T.date, closed.date)
  infoRow(T.time, opened ? `${opened.time} - ${closed.time}` : closed.time)

  const cashierName = nonEmptyString(data.cashier && data.cashier.name)
  if (cashierName) {
    const role = nonEmptyString(data.cashier.role)
    const roleLabel = role ? T.roles[role] || role : ''
    infoRow(T.cashier, roleLabel ? `${cashierName} - ${roleLabel}` : cashierName)
  }

  y += sz(4)
  ops.push({ divider: true, dashed: true, y })
  y += dividerGap

  // Item table: No. | Item | Qty | Price | Amount. The numeric columns are
  // laid out right-to-left from the widest value actually in each column
  // (header included), so 7-digit kip amounts can't run into their neighbour —
  // fixed x positions did exactly that. Positions are NOT scaled by sz(): the
  // paper width doesn't shrink with the font, only the measured text does.
  const rows = data.lines.map((line) => {
    const quantity = Number(line.quantity)
    // Older app versions don't send unitPrice — derive it from the line total.
    const unitPrice = Number.isFinite(Number(line.unitPrice))
      ? Number(line.unitPrice)
      : quantity > 0
        ? Number(line.lineTotal) / quantity
        : Number(line.lineTotal)
    return {
      qty: String(line.quantity),
      price: amount(unitPrice, cur),
      total: amount(line.lineTotal, cur),
      name: itemName(line),
    }
  })
  const headSize = sz(24)
  const widest = (header, values) => {
    measureCtx.font = `bold ${headSize}px ${FONT_STACK}`
    let max = measureCtx.measureText(header).width
    measureCtx.font = `${tableSize}px ${FONT_STACK}`
    for (const v of values) max = Math.max(max, measureCtx.measureText(v).width)
    return Math.ceil(max)
  }
  const colGap = sz(12)
  const colNo = MARGIN
  const colName = MARGIN + sz(64)
  const colTotalRight = WIDTH - MARGIN
  const colPriceRight = colTotalRight - widest(T.itemAmount, rows.map((r) => r.total)) - colGap
  const colQtyRight = colPriceRight - widest(T.itemPrice, rows.map((r) => r.price)) - colGap
  const qtyWidth = widest(T.itemQty, rows.map((r) => r.qty))
  const nameWidth = Math.max(sz(80), colQtyRight - qtyWidth - colGap - colName)
  const head = { size: headSize, bold: true }
  ops.push({ y, text: T.itemNo, opts: { ...head, align: 'left', x: colNo } })
  ops.push({ y, text: T.itemName, opts: { ...head, align: 'left', x: colName } })
  ops.push({ y, text: T.itemQty, opts: { ...head, align: 'right', x: colQtyRight } })
  ops.push({ y, text: T.itemPrice, opts: { ...head, align: 'right', x: colPriceRight } })
  ops.push({ y, text: T.itemAmount, opts: { ...head, align: 'right', x: colTotalRight } })
  y += tableLine + sz(4)

  rows.forEach((row, index) => {
    const nameLines = wrapText(row.name, nameWidth, tableSize)
    const opts = { size: tableSize }
    ops.push({ y, text: String(index + 1), opts: { ...opts, align: 'left', x: colNo } })
    ops.push({ y, text: row.qty, opts: { ...opts, align: 'right', x: colQtyRight } })
    ops.push({ y, text: row.price, opts: { ...opts, align: 'right', x: colPriceRight } })
    ops.push({ y, text: row.total, opts: { ...opts, align: 'right', x: colTotalRight } })
    for (const text of nameLines) {
      ops.push({ y, text, opts: { ...opts, align: 'left', x: colName } })
      y += tableLine
    }
  })

  // Totals
  y -= sz(8)
  ops.push({ divider: true, dashed: true, y })
  y += dividerGap
  ops.push({ y, text: T.subtotal, opts: { size: textSize, align: 'left' } })
  ops.push({ y, text: money(data.subtotal, cur), opts: { size: textSize, align: 'right' } })
  y += lineHeight

  // Discount is always listed (a plain 0 when none was applied) so the slip
  // reads the same every time. Snapshotted onto the Bill at print time (see
  // printBill/closeBillAndTable in bill-actions.ts) — a campaign's name and
  // percent only appear when one was actually applied.
  if (data.discountAmount > 0) {
    ops.push({ y, text: `${T.discount} ${data.discountName} ${data.discountPercent}%`, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `-${money(data.discountAmount, cur)}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight - sz(8)
    ops.push({ y, text: T.excludesDrinks, opts: { size: sz(16), align: 'left' } })
    y += lineHeight - sz(6)
  } else {
    ops.push({ y, text: T.discount, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: money(0, cur), opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  // Service charge: shown with its percent whenever the app says what the
  // rate is (even 0%), otherwise only when there is a charge — older app
  // versions never sent the percent.
  const hasServicePercent = Number.isFinite(Number(data.serviceChargePercent))
  if (hasServicePercent || data.serviceCharge > 0) {
    const percent = Number(Number(data.serviceChargePercent).toFixed(2)) // 7.000000000000001 -> 7
    const label = hasServicePercent ? `${T.serviceCharge} ${percent}%` : T.serviceCharge
    ops.push({ y, text: label, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: money(data.serviceCharge, cur), opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  // VIP table hourly surcharge — shown whenever the table is VIP, even at ฿0
  // (the spend threshold waived it), so that's visible rather than silently
  // absent. vipDurationLabel arrives pre-formatted (e.g. "2h 20m") from the
  // main app's lib/vip-charge.ts — no duration math done here.
  if (data.isVip) {
    const label = data.vipChargeAmount > 0 ? `VIP Table (${data.vipDurationLabel})` : 'VIP Table Charge'
    ops.push({ y, text: label, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: money(data.vipChargeAmount, cur), opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  ops.push({ divider: true, dashed: true, y })
  y += dividerGap

  // Total
  ops.push({ y, text: T.total, opts: { size: sz(28), bold: true, align: 'left' } })
  ops.push({ y, text: money(data.total, cur), opts: { size: sz(28), bold: true, align: 'right' } })
  y += lineHeight + sz(4)

  // Total in the other currencies the shop quotes (LAK / THB / USD), converted
  // by the main app from the exchange rates in /admin/settings and sent as
  // `currencyTotals`. The slip's own currency is skipped — the total line
  // above already is that figure. Absent when no rates are set, so
  // unconfigured jobs print no extra lines. Entries with an unknown currency
  // are skipped rather than trusted.
  const currencyTotals = Array.isArray(data.currencyTotals)
    ? data.currencyTotals.filter(
        (c) => c && Object.hasOwn(CURRENCIES, c.currency) && c.currency !== (Object.hasOwn(CURRENCIES, data.currency) ? data.currency : curCode) && Number.isFinite(Number(c.amount))
      )
    : []
  for (const c of currencyTotals) {
    ops.push({ y, text: `${c.currency}:`, opts: { size: sz(30), bold: true, align: 'left' } })
    ops.push({ y, text: money(c.amount, CURRENCIES[c.currency]), opts: { size: sz(30), bold: true, align: 'right' } })
    y += lineHeight - sz(4)
  }
  if (currencyTotals.length > 0) y += sz(6)

  // Payment — only present on the reprint fired after payment is confirmed
  // (see closeBillAndTable/enqueueReceipt) — the pre-payment "① Print bill"
  // job never sets these, so this block is skipped there. One centered line
  // ("Received 80,000 LAK, Change 0 LAK"), wrapped if the shop's currency or
  // language makes it wider than the paper.
  if (data.received != null) {
    ops.push({ divider: true, dashed: true, y })
    y += dividerGap
    const code = curCode ? ` ${curCode}` : ''
    const summary = `${T.received} ${amount(data.received, cur)}${code}, ${T.change} ${amount(data.change ?? 0, cur)}${code}`
    for (const text of wrapText(summary, innerWidth, sz(26))) {
      ops.push({ y, text, opts: { size: sz(26), align: 'center' } })
      y += tableLine
    }
    y += sz(8)
  }

  // QR
  if (qrDims) {
    ops.push({ y, text: T.scanToPay, opts: { size: sz(20), align: 'center' } })
    y += lineHeight
    const w = sz(qrDims.width)
    const h = sz(qrDims.height)
    ops.push({ image: qr.image, x: (WIDTH - w) / 2, y, width: w, height: h })
    y += h + sz(QR_MARGIN_TOP)
  }

  // Closing message: the admin's own footer text, else the stock thank-you.
  const footer = nonEmptyString(data.footerText) || T.thankYou
  for (const text of wrapText(footer, innerWidth, sz(24))) {
    ops.push({ y, text, opts: { size: sz(24), align: 'center' } })
    y += infoLine
  }
  y += sz(8)

  return { ops, height: y + sz(20) }
}

function renderReceiptImage(data) {
  const logoDims = scaledDims(logo.image, LOGO_MAX_WIDTH, LOGO_MAX_HEIGHT)
  const qrDims = scaledDims(qr.image, QR_MAX_WIDTH, QR_MAX_HEIGHT)

  let layout = layoutReceipt(data, logoDims, qrDims, 1)
  if (layout.height > MAX_PAGE_HEIGHT) {
    const scale = Math.max(MIN_RECEIPT_SCALE, MAX_PAGE_HEIGHT / layout.height)
    layout = layoutReceipt(data, logoDims, qrDims, scale)
  }

  const canvas = createCanvas(WIDTH, layout.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, layout.height)

  for (const op of layout.ops) {
    if (op.image) {
      const source = op.dither ? ditherToBlackWhite(op.image, op.width, op.height) : op.image
      ctx.drawImage(source, op.x, op.y, op.width, op.height)
    } else if (op.divider) drawDivider(ctx, op.y, op.dashed)
    else drawLine(ctx, op.y, op.text, op.opts)
  }

  // Still returned as an array — printer.js's printReceiptImage loops over
  // it, and scripts/test-*.js log pages.length — so callers don't need to
  // change even though it's always exactly one page now.
  return [canvas.toBuffer('image/png')]
}

// Currency *code* for the kitchen slip's price line ("65,000 LAK") — same
// precedence as currencyFor(): PRINT_CURRENCY, then the job's own currency, THB.
function currencyCodeFor(data) {
  if (CURRENCIES[PRINT_CURRENCY]) return PRINT_CURRENCY
  return CURRENCIES[data.currency] ? data.currency : 'THB'
}

// "13/11/26 | 12:01" in Laos/Thailand time, regardless of this machine's zone.
function kotStamp(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: RECEIPT_TZ,
      hourCycle: 'h23',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  )
  return `${p.day}/${p.month}/${p.year} | ${p.hour}:${p.minute}`
}

// Largest font size (down to `min`) at which `text` fits in `maxWidth`.
function fitFontSize(text, maxWidth, size, min, bold = false) {
  for (let s = size; s > min; s -= 2) {
    measureCtx.font = `${bold ? 'bold ' : ''}${s}px ${FONT_STACK}`
    if (measureCtx.measureText(text).width <= maxWidth) return s
  }
  return min
}

// Kitchen slip (one item per job — see the web app's enqueueOrderKot):
//
//   [ B2 ██████████ ]  Restaurant name      table, inverted, + restaurant
//   Item name (qty)                          bold, wraps
//   * note                                   only when the customer wrote one
//   ລວມ 65,000 LAK                           line total, when the job carries a price
//   - - - - - - - - - - - - - - - - - -
//   ຄົວຮ້ອນ                13/11/26 | 12:01   station (small) + print time
//
// Optional payload fields (`restaurantName`, `currency`, items[].price) come
// from newer web app versions; without them those parts are simply omitted.
function renderKotImage(data) {
  // Height must match content exactly — a flat per-item line-count estimate
  // (e.g. always reserving a note line) leaves blank paper at the bottom of
  // every ticket. So layout runs as a dry pass first (no canvas yet, just
  // tracking y) to get the exact height, then a second pass draws using the
  // positions recorded in `ops` — the two passes can't drift apart since the
  // draw pass never recomputes a position, only replays what the dry pass logged.
  const ops = []
  const BAR_TOP = 20
  const BAR_PAD = 14
  const TABLE_SIZE = 40
  const TABLE_MIN_SIZE = 24
  const NAME_GAP = 16
  const NAME_MIN_ROOM = 150 // beside the box; narrower than this → name goes under it
  const ITEM_SIZE = 36
  const KOT_LINE_HEIGHT = 44
  const innerWidth = WIDTH - MARGIN * 2
  const textRoom = innerWidth - BAR_PAD * 2

  // Inverted table box. Table names are free text, so the label is shrunk to
  // fit the full width and, past the minimum size, wrapped onto more lines (the
  // box grows) — the table is the one field that must never be cut off.
  const tableText = String(data.tableNumber ?? '')
  const tableSize = fitFontSize(tableText, textRoom, TABLE_SIZE, TABLE_MIN_SIZE, true)
  const tableLines = wrapText(tableText, textRoom, tableSize, true)
  const TABLE_LINE_HEIGHT = Math.round(tableSize * 1.25)
  const barHeight =
    tableLines.length === 1 ? 58 : tableLines.length * TABLE_LINE_HEIGHT + 14
  measureCtx.font = `bold ${tableSize}px ${FONT_STACK}`
  const widest = Math.max(...tableLines.map((l) => measureCtx.measureText(l).width))
  // At least half the paper wide (matches the sample), wider for a long label.
  const barWidth = Math.min(innerWidth, Math.max(innerWidth * 0.5, widest + BAR_PAD * 2))
  const barBottom = BAR_TOP + barHeight
  ops.push({
    draw: (ctx) => {
      ctx.fillStyle = '#000'
      ctx.fillRect(MARGIN, BAR_TOP, barWidth, barHeight)
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${tableSize}px ${FONT_STACK}`
      ctx.textAlign = 'left'
      const first = tableLines.length === 1 ? barBottom - 14 : BAR_TOP + TABLE_LINE_HEIGHT
      tableLines.forEach((line, i) => ctx.fillText(line, MARGIN + BAR_PAD, first + i * TABLE_LINE_HEIGHT))
    },
  })

  // Restaurant name: beside the box when there's room, otherwise on its own
  // line under it.
  let y = barBottom + 46
  const restaurant = typeof data.restaurantName === 'string' ? data.restaurantName.trim() : ''
  if (restaurant) {
    const besideX = MARGIN + barWidth + NAME_GAP
    const beside = WIDTH - MARGIN - besideX >= NAME_MIN_ROOM
    const nameX = beside ? besideX : MARGIN
    const nameWidth = WIDTH - MARGIN - nameX
    // Shrink to fit, but never below a readable size — past that, cut with "…".
    const nameSize = fitFontSize(restaurant, nameWidth, 30, 20, true)
    measureCtx.font = `bold ${nameSize}px ${FONT_STACK}`
    let nameText = restaurant
    if (measureCtx.measureText(nameText).width > nameWidth) {
      const chars = Array.from(graphemeSegmenter.segment(restaurant), (g) => g.segment)
      while (chars.length > 1 && measureCtx.measureText(chars.join('') + '…').width > nameWidth) chars.pop()
      nameText = chars.join('') + '…'
    }
    if (beside) {
      ops.push({ y: barBottom - 14, text: nameText, opts: { size: nameSize, bold: true, x: nameX } })
    } else {
      ops.push({ y: barBottom + 36, text: nameText, opts: { size: nameSize, bold: true, x: nameX } })
      y += 40
    }
  }

  const cur = currencyFor(data)
  const code = currencyCodeFor(data)
  for (const item of data.items) {
    // Quantity stays glued to the end of the name's last line; if it doesn't
    // fit there it moves down whole (never split as "(" / "12)").
    const nameLines = wrapText(itemName(item), innerWidth, ITEM_SIZE, true)
    const qty = `(${item.quantity})`
    measureCtx.font = `bold ${ITEM_SIZE}px ${FONT_STACK}`
    const withQty = `${nameLines[nameLines.length - 1]} ${qty}`
    if (measureCtx.measureText(withQty).width <= innerWidth) nameLines[nameLines.length - 1] = withQty
    else nameLines.push(qty)
    for (const text of nameLines) {
      ops.push({ y, text, opts: { size: ITEM_SIZE, bold: true } })
      y += KOT_LINE_HEIGHT
    }
    if (item.note) {
      for (const text of wrapText(`  * ${item.note}`, innerWidth, 26)) {
        ops.push({ y, text, opts: { size: 26 } })
        y += KOT_LINE_HEIGHT - 6
      }
    }
    if (typeof item.price === 'number' && Number.isFinite(item.price)) {
      ops.push({ y, text: `${T.itemAmount} ${amount(item.price, cur)} ${code}`, opts: { size: 28 } })
      y += KOT_LINE_HEIGHT - 4
    }
    y += 6
  }

  y += 8
  ops.push({ divider: true, dashed: true, y })
  y += 34

  // Station (small, left) shares the footer row with the print time (right).
  const stationHeader = data.stationLabel || data.station
  if (stationHeader) ops.push({ y, text: stationHeader, opts: { size: 22 } })
  ops.push({ y, text: kotStamp(), opts: { size: 24, align: 'right' } })

  const height = y + 24
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  for (const op of ops) {
    if (op.draw) op.draw(ctx)
    else if (op.divider) drawDivider(ctx, op.y, op.dashed)
    else drawLine(ctx, op.y, op.text, op.opts, 70)
  }

  return canvas.toBuffer('image/png')
}

// Per-session ordering QR slip (job type SESSION_QR — see the web app's
// lib/table-session.ts enqueueSessionQrPrint): table number, the session's
// order URL as a QR code, and when the table was opened. The QR is drawn
// module-by-module as solid black squares rather than via the printer's own
// ESC/POS QR command — many clone printers don't implement that command, and
// drawing it keeps this slip on the same image path as every other job.
const SESSION_QR_MODULE_DOTS = 10 // dots per QR module — ~1.25mm at 203dpi, easy for phone cameras
const SESSION_QR_QUIET_MODULES = 4 // white border the QR spec requires around the code

function renderSessionQrImage(data) {
  const qr = QRCode.create(String(data.orderUrl), { errorCorrectionLevel: 'M' })
  const modules = qr.modules.size
  // Shrink modules for very long URLs so the code (plus quiet zone) still fits the paper.
  const moduleDots = Math.max(
    4,
    Math.min(SESSION_QR_MODULE_DOTS, Math.floor((WIDTH - MARGIN * 2) / (modules + SESSION_QR_QUIET_MODULES * 2)))
  )
  const qrSize = modules * moduleDots

  const ops = []
  let y = 58
  ops.push({ y, text: `${T.table} ${data.tableNumber}`, opts: { size: 44, bold: true, align: 'center' } })
  y += 30
  const qrTop = y + SESSION_QR_QUIET_MODULES * moduleDots
  y = qrTop + qrSize + SESSION_QR_QUIET_MODULES * moduleDots + 34
  ops.push({ y, text: T.scanToOrder, opts: { size: 32, bold: true, align: 'center' } })
  y += 40
  const opened = data.openedAt ? new Date(data.openedAt) : null
  if (opened && !Number.isNaN(opened.getTime())) {
    ops.push({ y, text: `${T.openedAt} ${opened.toLocaleString(T.dateLocale)}`, opts: { size: 20, align: 'center' } })
    y += 30
  }

  const height = y + 20
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  const left = Math.round((WIDTH - qrSize) / 2)
  ctx.fillStyle = '#000'
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.modules.get(row, col)) ctx.fillRect(left + col * moduleDots, qrTop + row * moduleDots, moduleDots, moduleDots)
    }
  }
  for (const op of ops) drawLine(ctx, op.y, op.text, op.opts)

  return canvas.toBuffer('image/png')
}

// Short slip for a "Test print" sent from /admin/printers' found-printers
// list (job type TEST) — prints the address it was sent to, so an admin
// standing at a printer can tell which scanned address that printer is.
function renderTestImage(data) {
  const target = data.target || {}
  const address = target.connectionType === 'USB' ? `USB ${target.comPort}` : `${target.ip}:${target.port}`
  const lines = [
    { text: T.printerTest, opts: { size: 36, bold: true, align: 'center' }, step: 52 },
    { text: address, opts: { size: 40, bold: true, align: 'center' }, step: 48 },
    { text: new Date().toLocaleString(T.dateLocale), opts: { size: 20, align: 'center' }, step: 30 },
  ]
  let y = 52
  const ops = lines.map((l) => {
    const op = { y, text: l.text, opts: l.opts }
    y += l.step
    return op
  })
  const height = y + 10
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)
  for (const op of ops) drawLine(ctx, op.y, op.text, op.opts)
  return canvas.toBuffer('image/png')
}

module.exports = {
  renderReceiptImage,
  renderKotImage,
  renderSessionQrImage,
  renderTestImage,
  logoReady,
  qrReady,
  syncBranding,
}