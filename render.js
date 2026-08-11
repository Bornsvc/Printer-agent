const { createCanvas, GlobalFonts, Image } = require('@napi-rs/canvas')
const path = require('path')
const fs = require('fs')

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

// Loads a PNG/JPG that may not exist (logo, payment QR — both optional).
// img.complete reports true the instant src is set, but drawImage silently
// paints nothing until decode() actually resolves — so callers must await
// `ready` before the first receipt is rendered, or the image draws blank.
function loadImageAsset(assetPath) {
  const asset = { image: null }
  asset.ready = (async () => {
    if (!fs.existsSync(assetPath)) return
    try {
      const img = new Image()
      img.src = fs.readFileSync(assetPath)
      await img.decode()
      asset.image = img
    } catch (err) {
      console.warn(`⚠️  Failed to load ${path.basename(assetPath)}:`, err.message)
    }
  })()
  return asset
}

// Scales an image down to maxWidth (never up), preserving aspect ratio —
// stretching a QR code even slightly can make it fail to scan.
function scaledDims(image, maxWidth) {
  if (!image) return null
  const width = Math.min(image.width, maxWidth)
  const height = image.height * (width / image.width)
  return { width, height }
}

// Optional restaurant logo printed at the top of RECEIPT tickets (not KOTs —
// kitchen slips stay logo-free to save paper/time). Drop a PNG/JPG at
// print-agent/assets/logo.png to enable it; receipts print without a logo
// if the file is missing.
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png')
const LOGO_MAX_WIDTH = 320
const LOGO_MARGIN_BOTTOM = 14
const logo = loadImageAsset(LOGO_PATH)
const logoReady = logo.ready

// Optional payment QR code printed near the total on RECEIPT tickets. Drop a
// PNG/JPG at print-agent/assets/qr-payment.png to enable it.
const QR_PATH = path.join(__dirname, 'assets', 'qr-payment.png')
const QR_MAX_WIDTH = 260
const QR_MARGIN_TOP = 16
const qr = loadImageAsset(QR_PATH)
const qrReady = qr.ready

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

function renderReceiptImage(data) {
  // Same dry-layout-then-draw approach as renderKotImage — height always
  // matches drawn content exactly, no magic line-count formula to keep in
  // sync as lines are added/removed here.
  const ops = []
  const logoDims = scaledDims(logo.image, LOGO_MAX_WIDTH)
  const qrDims = scaledDims(qr.image, QR_MAX_WIDTH)
  let y = 20

  if (logoDims) {
    ops.push({ image: logo.image, x: (WIDTH - logoDims.width) / 2, y, width: logoDims.width, height: logoDims.height })
    y += logoDims.height + LOGO_MARGIN_BOTTOM
  }

  // The logo already carries the restaurant name/branding as an image, so a
  // plain-text name line is only drawn if the caller explicitly passes one
  // (e.g. a future settings-driven name) — skipped by default, which also
  // sidesteps needing that string to be in a script this font covers.
  if (data.restaurantName) {
    ops.push({ y, text: data.restaurantName, opts: { size: 22, bold: true, align: 'center' } })
    y += LINE_HEIGHT + 6
  }

  // Table number is the thing staff actually scan for when matching a
  // printed receipt to a bill, so it's the largest, boldest line on the page.
  ops.push({ y, text: `โต๊ะ ${data.tableNumber}`, opts: { size: 30, bold: true, align: 'center' } })
  y += LINE_HEIGHT + 6
  ops.push({ y, text: new Date().toLocaleString('lo-LA'), opts: { size: 16, align: 'center' } })
  y += LINE_HEIGHT

  ops.push({ divider: true, y })
  y += 25

  for (const line of data.lines) {
    ops.push({ y, text: `${line.quantity}x ${line.name}`, opts: { align: 'left' } })
    ops.push({ y, text: line.lineTotal.toLocaleString(), opts: { align: 'right' } })
    y += LINE_HEIGHT
  }

  ops.push({ divider: true, y })
  y += 25
  ops.push({ y, text: 'รวมย่อย', opts: { align: 'left' } })
  ops.push({ y, text: `฿${data.subtotal.toLocaleString()}`, opts: { align: 'right' } })
  y += LINE_HEIGHT
  if (data.serviceCharge > 0) {
    ops.push({ y, text: 'ค่าบริการ', opts: { align: 'left' } })
    ops.push({ y, text: `฿${data.serviceCharge.toLocaleString()}`, opts: { align: 'right' } })
    y += LINE_HEIGHT
  }
  // Snapshotted onto the Bill at print time (see printBill/closeBillAndTable
  // in bill-actions.ts) — only present when a discount campaign was applied.
  if (data.discountAmount > 0) {
    ops.push({ y, text: `ส่วนลด ${data.discountName} ${data.discountPercent}%`, opts: { align: 'left' } })
    ops.push({ y, text: `-฿${data.discountAmount.toLocaleString()}`, opts: { align: 'right' } })
    y += LINE_HEIGHT
  }
  ops.push({ y, text: 'รวมทั้งหมด', opts: { size: 24, bold: true, align: 'left' } })
  ops.push({ y, text: `฿${data.total.toLocaleString()}`, opts: { size: 24, bold: true, align: 'right' } })
  y += LINE_HEIGHT + 14

  // Only present on the reprint fired after payment is confirmed (see
  // closeBillAndTable/enqueueReceipt) — the pre-payment "① Print bill" job
  // never sets these, so this block is skipped there.
  if (data.received != null) {
    ops.push({ divider: true, y })
    y += 25
    ops.push({ y, text: 'รับเงิน', opts: { align: 'left' } })
    ops.push({ y, text: `฿${data.received.toLocaleString()}`, opts: { align: 'right' } })
    y += LINE_HEIGHT
    ops.push({ y, text: 'เงินทอน', opts: { align: 'left' } })
    ops.push({ y, text: `฿${data.change.toLocaleString()}`, opts: { align: 'right' } })
    y += LINE_HEIGHT + 14
  }

  if (qrDims) {
    ops.push({ y, text: 'สแกนเพื่อชำระเงิน', opts: { size: 18, align: 'center' } })
    y += LINE_HEIGHT
    ops.push({ image: qr.image, x: (WIDTH - qrDims.width) / 2, y, width: qrDims.width, height: qrDims.height })
    y += qrDims.height + QR_MARGIN_TOP
  }

  ops.push({ y, text: 'ขอบคุณที่ใช้บริการ', opts: { size: 18, align: 'center' } })
  y += 8

  const height = y + 20
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  for (const op of ops) {
    if (op.image) ctx.drawImage(op.image, op.x, op.y, op.width, op.height)
    else if (op.divider) drawDivider(ctx, op.y)
    else drawLine(ctx, op.y, op.text, op.opts)
  }

  return canvas.toBuffer('image/png')
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

  ops.push({ y, text: `โต๊ะ ${data.tableNumber}`, opts: { size: 28, bold: true, align: 'center' } })
  y += LINE_HEIGHT + 4

  if (data.station) {
    ops.push({ y, text: data.station, opts: { size: 20, align: 'center' } })
    y += LINE_HEIGHT
  }

  ops.push({ y, text: new Date().toLocaleString('lo-LA'), opts: { size: 16, align: 'center' } })
  y += LINE_HEIGHT

  ops.push({ divider: true, y })
  y += 25

  for (const item of data.items) {
    ops.push({ y, text: `${item.quantity}x ${item.name}`, opts: { size: 24, bold: true } })
    y += LINE_HEIGHT
    if (item.note) {
      ops.push({ y, text: `  * ${item.note}`, opts: { size: 18 } })
      y += LINE_HEIGHT
    }
  }

  const height = y + 20
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  for (const op of ops) {
    if (op.divider) drawDivider(ctx, op.y)
    else drawLine(ctx, op.y, op.text, op.opts, 35)
  }

  return canvas.toBuffer('image/png')
}

module.exports = { renderReceiptImage, renderKotImage, logoReady, qrReady }