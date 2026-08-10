// Test KOT (Kitchen Order Ticket) printing.
//
// Usage:
//
//   node scripts/test-kot.js
//
//   node scripts/test-kot.js 192.168.1.100
//
//   node scripts/test-kot.js 192.168.1.100 H5 Kitchen
//
// Arguments:
//   1. printer IP
//   2. table number
//   3. kitchen/station name
//
// A copy of the rendered PNG is also saved next to this script
// so you can preview the KOT before/after printing.

require('dotenv').config()

const path = require('path')
const fs = require('fs')

const { renderKotImage } = require('../render')
const { printReceiptImage } = require('../printer')

// --------------------------------------------------
// Arguments
// --------------------------------------------------

const printerIP = process.argv[2] || process.env.KOT_PRINTER_IP || null
const tableNumber = process.argv[3] || 'H5'
const station = process.argv[4] || 'Kitchen'

// --------------------------------------------------
// Sample KOT data
// --------------------------------------------------

const sample = {
  tableNumber,

  station,

  items: [
    {
      quantity: 2,
      name: 'ตำหลวงพระบาง',
      note: 'เผ็ดน้อย',
    },
    {
      quantity: 1,
      name: 'คอหมูย่าง',
    },
    {
      quantity: 1,
      name: 'ยำเล็บมือนาง',
      note: 'ไม่ใส่ผักชี',
    },
    {
      quantity: 2,
      name: 'เอ็นไก่ทอด',
    },
    {
      quantity: 1,
      name: 'เฟรนช์ฟรายส์หมาล่า',
    },
    {
      quantity: 2,
      name: 'ข้าวเหนียว',
    },
  ],
}

// --------------------------------------------------
// Main
// --------------------------------------------------

async function main() {
  console.log('🍳 KOT printer test')
  console.log('')

  console.log(`🖨️  Printer IP: ${printerIP || 'default printer'}`)
  console.log(`🍽️  Table: ${tableNumber}`)
  console.log(`👨‍🍳 Station: ${station}`)
  console.log('')

  // Render KOT
  console.log('🖼️  Rendering KOT...')

  const image = renderKotImage(sample)

  // Save preview
  const previewPath = path.join(
    __dirname,
    'last-kot-preview.png',
  )

  fs.writeFileSync(previewPath, image)

  console.log(`💾 Saved preview: ${previewPath}`)

  // Print
  console.log('🖨️  Sending KOT to printer...')

  await printReceiptImage(image)

  console.log('✅ KOT printed successfully.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ KOT test failed:', err.message)
    process.exit(1)
  })