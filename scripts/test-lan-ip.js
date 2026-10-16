// Prints a sample receipt straight to a LAN printer by IP — bypasses the API,
// the DB and /admin/printers entirely, so you can check a printer's address
// before (or without) entering it in the web app.
//
// Usage (from the print-agent folder):
//   node scripts/test-lan-ip.js 192.168.1.50         # port 9100
//   node scripts/test-lan-ip.js 192.168.1.50 9101    # custom port
//
// A copy of the rendered PNG is also saved next to this script so you can
// preview it on screen without waiting on the printer.

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
const { renderReceiptImage, logoReady, qrReady } = require('../render')

const ip = process.argv[2]
const port = process.argv[3] || '9100'

const sample = {
  tableNumber: `TEST ${ip}`,
  lines: [
    { quantity: 1, name: 'ตำหลวงพระบาง', lineTotal: 70 },
    { quantity: 1, name: 'คอหมูย่าง', lineTotal: 139 },
    { quantity: 1, name: 'ข้าวเหนียว (1 กะติบ)', lineTotal: 30 },
  ],
  subtotal: 239,
  serviceCharge: 0,
  total: 239,
}

// Same config printer.js's createPrinterForTarget() builds for LAN targets.
function createPrinter() {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${ip}:${port}`,
    options: { timeout: 5000 },
  })
}

async function main() {
  if (!ip) {
    throw new Error('Missing IP — usage: node scripts/test-lan-ip.js <ip> [port]')
  }

  console.log(`🔌 Checking connection to ${ip}:${port}...`)
  if (!(await createPrinter().isPrinterConnected())) {
    throw new Error(`Could not connect to ${ip}:${port} — check the IP, port, cable and that the printer is on.`)
  }

  console.log('⏳ Loading logo + QR...')
  await Promise.all([logoReady, qrReady])

  console.log('🖼  Rendering receipt image...')
  const pages = renderReceiptImage(sample)

  for (const [i, page] of pages.entries()) {
    const suffix = pages.length > 1 ? `-${i + 1}` : ''
    const previewPath = path.join(__dirname, `last-lan-preview${suffix}.png`)
    fs.writeFileSync(previewPath, page)
    console.log(`💾 Saved preview: ${previewPath}`)

    // Same image -> cut -> beep sequence printer.js sends for RECEIPT.
    const printer = createPrinter()
    await printer.printImage(previewPath)
    printer.cut()
    printer.beep()
    console.log(`🖨️  Sending page ${i + 1}/${pages.length} to ${ip}:${port}...`)
    await printer.execute()
  }
  console.log('✅ Done — check the printer.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test print failed:', err.message)
    process.exit(1)
  })
