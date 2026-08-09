// Renders a sample receipt and sends it straight to the RECEIPT printer
// configured in /admin/printers — bypasses the DB/order flow entirely so you
// can iterate on the receipt layout without placing a real order each time.
//
// Usage (from the print-agent folder):
//   node scripts/test-receipt.js
//   node scripts/test-receipt.js "H5 + H6"      # custom table number
//
// A copy of the rendered PNG is also saved next to this script so you can
// preview it on screen without waiting on the printer.

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { renderReceiptImage, logoReady } = require('../render')
const { printReceiptImage, ready } = require('../printer')

const sample = {
  tableNumber: process.argv[2] || 'H5 + H6',
  lines: [
    { quantity: 1, name: 'ตำหลวงพระบาง', lineTotal: 70 },
    { quantity: 1, name: 'คอหมูย่าง', lineTotal: 139 },
    { quantity: 1, name: 'ยำเล็บมือนาง', lineTotal: 129 },
    { quantity: 1, name: 'เอ็นไก่ทอด', lineTotal: 99 },
    { quantity: 1, name: 'เฟรนช์ฟรายส์หมาล่า', lineTotal: 99 },
    { quantity: 1, name: 'ข้าวเหนียว (1 กะติบ)', lineTotal: 30 },
  ],
  subtotal: 566,
  serviceCharge: 0,
  total: 566,
}

async function main() {
  console.log('⏳ Loading printer config + logo...')
  await Promise.all([ready, logoReady])

  console.log('🖼  Rendering receipt image...')
  const image = renderReceiptImage(sample)

  const previewPath = path.join(__dirname, 'last-receipt-preview.png')
  fs.writeFileSync(previewPath, image)
  console.log(`💾 Saved preview: ${previewPath}`)

  console.log('🖨️  Sending to RECEIPT printer...')
  await printReceiptImage(image)
  console.log('✅ Done — check the printer.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test print failed:', err.message)
    process.exit(1)
  })
