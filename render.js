const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')
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

const WIDTH = 384 // ~80mm paper at 203dpi
const LINE_HEIGHT = 30
const MARGIN = 12

function drawLine(ctx, y, text, opts = {}) {
  const { size = 22, bold = false, align = 'left' } = opts
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
  const lineCount = data.lines.length + 8
  const height = LINE_HEIGHT * lineCount + 40
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  let y = 36
  drawLine(ctx, y, data.restaurantName || 'ร้านอาหาร', { size: 28, bold: true, align: 'center' })
  y += LINE_HEIGHT + 6
  drawLine(ctx, y, `โต๊ะ ${data.tableNumber}`, { align: 'center' })
  y += LINE_HEIGHT
  drawLine(ctx, y, new Date().toLocaleString('lo-LA'), { size: 18, align: 'center' })
  y += LINE_HEIGHT
  drawDivider(ctx, y)
  y += 16

  for (const line of data.lines) {
    drawLine(ctx, y, `${line.quantity}x ${line.name}`, { align: 'left' })
    drawLine(ctx, y, line.lineTotal.toLocaleString(), { align: 'right' })
    y += LINE_HEIGHT
  }

  drawDivider(ctx, y)
  y += 16
  drawLine(ctx, y, 'รวมย่อย', { align: 'left' })
  drawLine(ctx, y, data.subtotal.toLocaleString(), { align: 'right' })
  y += LINE_HEIGHT
  if (data.serviceCharge > 0) {
    drawLine(ctx, y, 'ค่าบริการ', { align: 'left' })
    drawLine(ctx, y, data.serviceCharge.toLocaleString(), { align: 'right' })
    y += LINE_HEIGHT
  }
  drawLine(ctx, y, 'รวมทั้งหมด', { size: 24, bold: true, align: 'left' })
  drawLine(ctx, y, `K${data.total.toLocaleString()}`, { size: 24, bold: true, align: 'right' })
  y += LINE_HEIGHT + 10
  drawLine(ctx, y, 'ขอบคุณที่ใช้บริการ', { size: 18, align: 'center' })

  return canvas.toBuffer('image/png')
}

function renderKotImage(data) {
  const lineCount = data.items.length * 2 + 6
  const height = LINE_HEIGHT * lineCount + 30
  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, WIDTH, height)

  let y = 36
  drawLine(ctx, y, `โต๊ะ ${data.tableNumber}`, { size: 28, bold: true, align: 'center' })
  y += LINE_HEIGHT + 4
  if (data.station) {
    drawLine(ctx, y, data.station, { size: 20, align: 'center' })
    y += LINE_HEIGHT
  }
  drawLine(ctx, y, new Date().toLocaleTimeString('lo-LA'), { size: 16, align: 'center' })
  y += LINE_HEIGHT
  drawDivider(ctx, y)
  y += 16

  for (const item of data.items) {
    drawLine(ctx, y, `${item.quantity}x ${item.name}`, { size: 24, bold: true })
    y += LINE_HEIGHT
    if (item.note) {
      drawLine(ctx, y, `  * ${item.note}`, { size: 18 })
      y += LINE_HEIGHT
    }
  }

  return canvas.toBuffer('image/png')
}

module.exports = { renderReceiptImage, renderKotImage }