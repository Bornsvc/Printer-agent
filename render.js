const { createCanvas, GlobalFonts, Image } = require('@napi-rs/canvas')
const path = require('path')
const fs = require('fs')
const fetch = require('node-fetch')

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

// 80mm thermal paper prints 576 dots wide at 203dpi (its printable area is
// ~72mm — the rest is margin the printer itself reserves). ESC/POS image
// printing does NOT center a narrower image on a wider print head; it just
// starts at the left edge — so this must match the paper actually loaded, or
// everything prints hugging the left with dead space on the right. Change to
// 384 if a station is loaded with 58mm paper instead.
const WIDTH = 576
const LINE_HEIGHT = 30
const MARGIN = 16

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

function drawLine(ctx, y, text, opts = {}, textSize = 22) {
  const { size = textSize, bold = false, align = 'left' } = opts
  ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT_FAMILY}`
  ctx.fillStyle = '#000'
  ctx.textAlign = align
  const x = align === 'center' ? WIDTH / 2 : align === 'right' ? WIDTH - MARGIN : MARGIN
  ctx.fillText(text, x, y)
}

function drawDivider(ctx, y) {
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(MARGIN, y)
  ctx.lineTo(WIDTH - MARGIN, y)
  ctx.stroke()
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

// Lays out a full receipt at a given scale and returns the draw ops plus the
// resulting height, without touching a canvas. renderReceiptImage calls this
// once at scale 1 to measure the natural height, then (if that's over
// MAX_PAGE_HEIGHT) again at a smaller scale. Shrinking the font size alone
// would NOT shrink the total height — each line's vertical position is
// driven by the line-height increment, not the glyph size — so every
// vertical measurement here (line height, gaps, margins) scales together.
function layoutReceipt(data, logoDims, qrDims, scale) {
  const sz = (px) => Math.round(px * scale)
  const lineHeight = sz(RECEIPT_LINE_HEIGHT)
  const textSize = sz(RECEIPT_TEXT_SIZE)
  const dividerGap = Math.round(textSize * 1.14)

  const ops = []
  let y = sz(20)

  // Header — width/height go through sz() too (not just the margin below
  // them), so the MAX_PAGE_HEIGHT shrink pass actually shrinks an oversized
  // image along with the text instead of leaving it at full size while the
  // text around it gets smaller.
  if (logoDims) {
    const w = sz(logoDims.width)
    const h = sz(logoDims.height)
    ops.push({ image: logo.image, x: (WIDTH - w) / 2, y, width: w, height: h })
    y += h + sz(LOGO_MARGIN_BOTTOM)
  }

  if (data.restaurantName) {
    ops.push({ y, text: data.restaurantName, opts: { size: textSize, bold: true, align: 'center' } })
    y += lineHeight + sz(6)
  }

  ops.push({ y, text: `โต๊ะ ${data.tableNumber}`, opts: { size: sz(34), bold: true, align: 'center' } })
  y += lineHeight + sz(6)

  ops.push({ y, text: new Date().toLocaleString('lo-LA'), opts: { size: sz(18), align: 'center' } })
  y += lineHeight

  ops.push({ divider: true, y })
  y += dividerGap

  // Items
  for (const line of data.lines) {
    ops.push({ y, text: `${line.quantity}x ${line.name}`, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: line.lineTotal.toLocaleString(), opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  // Totals
  ops.push({ divider: true, y })
  y += dividerGap
  ops.push({ y, text: 'รวมย่อย', opts: { size: textSize, align: 'left' } })
  ops.push({ y, text: `฿${data.subtotal.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
  y += lineHeight

  if (data.serviceCharge > 0) {
    ops.push({ y, text: 'ค่าบริการ', opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `฿${data.serviceCharge.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  // VIP table hourly surcharge — shown whenever the table is VIP, even at ฿0
  // (the spend threshold waived it), so that's visible rather than silently
  // absent. vipDurationLabel arrives pre-formatted (e.g. "2h 20m") from the
  // main app's lib/vip-charge.ts — no duration math done here.
  if (data.isVip) {
    const label = data.vipChargeAmount > 0 ? `VIP Table (${data.vipDurationLabel})` : 'VIP Table Charge'
    ops.push({ y, text: label, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `฿${data.vipChargeAmount.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight
  }

  // Snapshotted onto the Bill at print time (see printBill/closeBillAndTable
  // in bill-actions.ts) — only present when a discount campaign was applied.
  if (data.discountAmount > 0) {
    ops.push({ y, text: `ส่วนลด ${data.discountName} ${data.discountPercent}%`, opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `-฿${data.discountAmount.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight - sz(8)
    ops.push({ y, text: 'ไม่รวมเครื่องดื่ม', opts: { size: sz(16), align: 'left' } })
    y += lineHeight - sz(6)
  }

  // Total
  ops.push({ y, text: 'รวมทั้งหมด', opts: { size: sz(28), bold: true, align: 'left' } })
  ops.push({ y, text: `฿${data.total.toLocaleString()}`, opts: { size: sz(28), bold: true, align: 'right' } })
  y += lineHeight + sz(14)

  // Payment — only present on the reprint fired after payment is confirmed
  // (see closeBillAndTable/enqueueReceipt) — the pre-payment "① Print bill"
  // job never sets these, so this block is skipped there.
  if (data.received != null) {
    ops.push({ divider: true, y })
    y += dividerGap
    ops.push({ y, text: 'รับเงิน', opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `฿${data.received.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight
    ops.push({ y, text: 'เงินทอน', opts: { size: textSize, align: 'left' } })
    ops.push({ y, text: `฿${data.change.toLocaleString()}`, opts: { size: textSize, align: 'right' } })
    y += lineHeight + sz(14)
  }

  // QR
  if (qrDims) {
    ops.push({ y, text: 'สแกนเพื่อชำระเงิน', opts: { size: sz(20), align: 'center' } })
    y += lineHeight
    const w = sz(qrDims.width)
    const h = sz(qrDims.height)
    ops.push({ image: qr.image, x: (WIDTH - w) / 2, y, width: w, height: h })
    y += h + sz(QR_MARGIN_TOP)
  }

  ops.push({ y, text: 'ขอบคุณที่ใช้บริการ', opts: { size: sz(20), align: 'center' } })
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
    if (op.image) ctx.drawImage(op.image, op.x, op.y, op.width, op.height)
    else if (op.divider) drawDivider(ctx, op.y)
    else drawLine(ctx, op.y, op.text, op.opts)
  }

  // Still returned as an array — printer.js's printReceiptImage loops over
  // it, and scripts/test-*.js log pages.length — so callers don't need to
  // change even though it's always exactly one page now.
  return [canvas.toBuffer('image/png')]
}

function renderKotImage(data) {
  // Height must match content exactly — a flat per-item line-count estimate
  // (e.g. always reserving a note line) leaves blank paper at the bottom of
  // every ticket. So layout runs as a dry pass first (no canvas yet, just
  // tracking y) to get the exact height, then a second pass draws using the
  // positions recorded in `ops` — the two passes can't drift apart since the
  // draw pass never recomputes a position, only replays what the dry pass logged.
  const ops = []
  let y = 36
  // Kitchen slips are read at a glance from across the pass, so KOT text runs
  // noticeably larger than receipt text — with a taller line height to match,
  // otherwise the bigger glyphs overlap the next line.
  const KOT_LINE_HEIGHT = 44

  ops.push({ y, text: `โต๊ะ ${data.tableNumber}`, opts: { size: 38, bold: true, align: 'center' } })
  y += KOT_LINE_HEIGHT + 4

  // stationLabel is the Lao display text (see lib/actions/print-jobs.ts's
  // enqueueOrderKot); `station` is only the routing key (e.g. "HOT_KITCHEN")
  // and falls back here only for scripts/test-kot.js's manual sample data,
  // which sets station but no stationLabel.
  const stationHeader = data.stationLabel || data.station
  if (stationHeader) {
    ops.push({ y, text: stationHeader, opts: { size: 26, align: 'center' } })
    y += KOT_LINE_HEIGHT
  }

  ops.push({ y, text: new Date().toLocaleString('lo-LA'), opts: { size: 18, align: 'center' } })
  y += KOT_LINE_HEIGHT

  ops.push({ divider: true, y })
  y += 25

  for (const item of data.items) {
    ops.push({ y, text: `${item.quantity}x ${item.name}`, opts: { size: 34, bold: true } })
    y += KOT_LINE_HEIGHT
    if (item.note) {
      ops.push({ y, text: `  * ${item.note}`, opts: { size: 24 } })
      y += KOT_LINE_HEIGHT - 6
    }
  }

  const height = y + 20
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  for (const op of ops) {
    if (op.divider) drawDivider(ctx, op.y)
    else drawLine(ctx, op.y, op.text, op.opts, 70)
  }

  return canvas.toBuffer('image/png')
}

module.exports = { renderReceiptImage, renderKotImage, logoReady, qrReady, syncBranding }