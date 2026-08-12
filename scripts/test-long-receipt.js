// Tests the SAME real oversized bill (table H1, ฿7,571 — the one that
// originally failed to print) but through the merge-duplicate-lines fix now
// in enqueueReceipt (pos/lib/actions/print-jobs.ts) — mirrors that exact
// logic here since this is a separate project with no shared TS import.
// Renders + sends straight to the RECEIPT printer, bypassing the DB/order
// flow, and reports timing/size so you can see the before/after.
//
// Usage (from the print-agent folder):
//   node scripts/test-long-receipt.js
//   node scripts/test-long-receipt.js "H1 (retest)"      # custom table label
//   node scripts/test-long-receipt.js --raw              # old unmerged 80-line version, for comparison
//
// A copy of the rendered PNG is also saved next to this script so you can
// see exactly how tall/long the receipt is without waiting on the printer.

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const { renderReceiptImage, logoReady, qrReady } = require('../render')
const { printReceiptImage, ready } = require('../printer')

const raw = require('./sample-long-receipt.json')
const useRaw = process.argv.includes('--raw')
const tableArg = process.argv.slice(2).find((a) => a !== '--raw')

// Mirrors enqueueReceipt's merge in pos/lib/actions/print-jobs.ts exactly —
// same dish ordered across multiple rounds becomes one line, quantity summed.
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

const sample = {
  ...raw,
  lines: useRaw ? raw.lines : mergeLines(raw.lines),
}
if (tableArg) sample.tableNumber = tableArg

async function main() {
  console.log(`📋 Table: ${sample.tableNumber} — ${sample.lines.length} lines (${useRaw ? 'RAW, unmerged' : 'merged'}), ฿${sample.total.toLocaleString()}`)
  console.log('')

  console.log('⏳ Loading printer config + logo + QR...')
  await Promise.all([ready, logoReady, qrReady])

  console.log('🖼  Rendering receipt image...')
  const renderStart = Date.now()
  const pages = renderReceiptImage(sample) // array of page buffers — see render.js's MAX_PAGE_HEIGHT
  const renderMs = Date.now() - renderStart

  console.log(`   ${pages.length} page${pages.length > 1 ? 's' : ''} — rendered in ${renderMs}ms`)
  pages.forEach((page, i) => {
    const heightPx = imageHeightFromPng(page)
    const mm = heightPx ? ((heightPx / 203) * 25.4).toFixed(0) : '?'
    console.log(`   page ${i + 1}: ${page.length.toLocaleString()} bytes, ${heightPx ?? '?'}px tall (~${mm}mm)`)
    const suffix = pages.length > 1 ? `-${i + 1}` : ''
    const previewPath = path.join(__dirname, `last-long-receipt-preview${suffix}.png`)
    fs.writeFileSync(previewPath, page)
    console.log(`   💾 Saved preview: ${previewPath}`)
  })

  console.log('')
  console.log(`🖨️  Sending to RECEIPT printer (${pages.length} page${pages.length > 1 ? 's' : ''}, watch for a timeout around 5000ms per page)...`)
  const printStart = Date.now()
  try {
    await printReceiptImage(pages)
    console.log(`✅ Printed successfully in ${Date.now() - printStart}ms — check the printer.`)
  } catch (err) {
    console.log(`❌ Failed after ${Date.now() - printStart}ms: ${err.message}`)
    throw err
  }
}

// PNG height lives in the IHDR chunk at a fixed byte offset — cheaper than
// pulling in a PNG-parsing dependency just for a diagnostic number.
function imageHeightFromPng(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return buf.readUInt32BE(20)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test print failed:', err.message)
    process.exit(1)
  })
