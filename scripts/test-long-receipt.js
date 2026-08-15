// Tests a long receipt using the same kind of data as the real oversized bill.
// Renders + sends straight to the RECEIPT printer, bypassing the DB/order flow.
//
// Usage (from the print-agent folder):
//   node scripts/test-long-receipt.js
//   node scripts/test-long-receipt.js "A10"
//   node scripts/test-long-receipt.js --raw
//
// --raw keeps duplicate lines.
// Without --raw, duplicate item names are merged automatically.
//
// A copy of the rendered PNG is also saved next to this script.

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { renderReceiptImage, logoReady, qrReady } = require('../render')
const { printReceiptImage, ready } = require('../printer')

const useRaw = process.argv.includes('--raw')

const tableArg = process.argv
  .slice(2)
  .find((arg) => arg !== '--raw')

// Original test data
const rawLines = [
  { quantity: 3, name: 'ข้าวผัดพริกเผากุ้ง (ใหญ่)VIP', lineTotal: 507 },
  { quantity: 3, name: 'ตำหลวงพระบางVIP', lineTotal: 210 },
  { quantity: 3, name: 'สลัดลาวVIP', lineTotal: 360 },
  { quantity: 3, name: 'ซุปผักลาวVIP', lineTotal: 267 },
  { quantity: 3, name: 'ฝรั่งกอดลาวVIP', lineTotal: 327 },
  { quantity: 3, name: 'อั่วหมูตะไคร้VIP', lineTotal: 447 },
  { quantity: 3, name: 'ต้มยำกุ้งไข่เค็มVIP', lineTotal: 537 },
  { quantity: 1, name: 'ผักบุ้งไฟแดงVIP', lineTotal: 89 },

  { quantity: 1, name: 'เอ็นเหลืองVIP', lineTotal: 89 },
  { quantity: 1, name: 'เอ็นเหลืองVIP', lineTotal: 89 },

  { quantity: 1, name: 'เสือร้องไห้VIP', lineTotal: 149 },

  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'น้ำแข็งVIP', lineTotal: 40 },
  { quantity: 1, name: 'ยำถั่วลิสงVIP', lineTotal: 69 },
  { quantity: 5, name: 'น้ำเปล่า สิงห์ (เล็ก)VIP', lineTotal: 100 },
  { quantity: 1, name: 'สิงห์ (620 มล. / 3 ขวด)VIP', lineTotal: 289 },

  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'เสือร้องไห้VIP', lineTotal: 149 },
  { quantity: 1, name: 'แสงโสมVIP', lineTotal: 449 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 3, name: 'โซดาVIP', lineTotal: 75 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'น้ำเปล่า สิงห์ (เล็ก)VIP', lineTotal: 20 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },
  { quantity: 1, name: 'น้ำแข็งVIP', lineTotal: 40 },
  { quantity: 1, name: 'ไฮเนเก้นVIP', lineTotal: 119 },

  { quantity: 1, name: 'ลาบเป็ด', lineTotal: 120 },
  { quantity: 1, name: 'ข้าวเหนียว (1 กะติบ)', lineTotal: 30 },
  { quantity: 1, name: 'สิงห์ (620 มล. / 3 ขวด)', lineTotal: 289 },
  { quantity: 2, name: 'ไฮเนเก้น', lineTotal: 238 },
  { quantity: 1, name: 'น้ำเปล่า สิงห์ (เล็ก)', lineTotal: 20 },
  { quantity: 1, name: 'โซดา', lineTotal: 25 },

  { quantity: 2, name: 'ไฮเนเก้น', lineTotal: 238 },
  { quantity: 1, name: 'โซดา', lineTotal: 25 },
  { quantity: 1, name: 'น้ำแข็ง', lineTotal: 40 },
]

// Merge duplicate item names.
// Example:
// 1x ไฮเนเก้นVIP ฿119
// 1x ไฮเนเก้นVIP ฿119
// becomes:
// 2x ไฮเนเก้นVIP ฿238
function mergeLines(lines) {
  const byName = new Map()
  const merged = []

  for (const line of lines) {
    const existing = byName.get(line.name)

    if (existing) {
      existing.quantity += line.quantity
      existing.lineTotal += line.lineTotal
    } else {
      const copy = { ...line }
      byName.set(line.name, copy)
      merged.push(copy)
    }
  }

  return merged
}

const lines = useRaw
  ? rawLines
  : mergeLines(rawLines)

const sample = {
  tableNumber: tableArg || 'A10',
  lines,
  subtotal: 6533,
  serviceCharge: 0,
  total: 6533,
}

async function main() {
  console.log(
    `📋 Table: ${sample.tableNumber} — ` +
    `${sample.lines.length} lines ` +
    `(${useRaw ? 'RAW, unmerged' : 'MERGED'}) — ` +
    `฿${sample.total.toLocaleString()}`
  )

  console.log('')

  console.log('⏳ Loading printer config + logo + QR...')
  await Promise.all([
    ready,
    logoReady,
    qrReady,
  ])

  console.log('🖼  Rendering receipt image...')

  const renderStart = Date.now()

  const pages = renderReceiptImage(sample)

  const renderMs = Date.now() - renderStart

  console.log(
    `   ${pages.length} page${pages.length > 1 ? 's' : ''} ` +
    `— rendered in ${renderMs}ms`
  )

  pages.forEach((page, i) => {
    const heightPx = imageHeightFromPng(page)

    const mm = heightPx
      ? ((heightPx / 203) * 25.4).toFixed(0)
      : '?'

    console.log(
      `   page ${i + 1}: ` +
      `${page.length.toLocaleString()} bytes, ` +
      `${heightPx ?? '?'}px tall ` +
      `(~${mm}mm)`
    )

    const suffix = pages.length > 1
      ? `-${i + 1}`
      : ''

    const previewPath = path.join(
      __dirname,
      `last-long-receipt-preview${suffix}.png`
    )

    fs.writeFileSync(
      previewPath,
      page
    )

    console.log(
      `   💾 Saved preview: ${previewPath}`
    )
  })

  console.log('')

  console.log(
    `🖨️  Sending to RECEIPT printer ` +
    `(${pages.length} page${pages.length > 1 ? 's' : ''})...`
  )

  const printStart = Date.now()

  try {
    await printReceiptImage(pages)

    console.log(
      `✅ Printed successfully in ` +
      `${Date.now() - printStart}ms — check the printer.`
    )
  } catch (err) {
    console.log(
      `❌ Failed after ` +
      `${Date.now() - printStart}ms: ${err.message}`
    )

    throw err
  }
}

// Read PNG height from the IHDR chunk.
function imageHeightFromPng(buf) {
  if (
    buf.length < 24 ||
    buf.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return null
  }

  return buf.readUInt32BE(20)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      '❌ Test print failed:',
      err.message
    )

    process.exit(1)
  })