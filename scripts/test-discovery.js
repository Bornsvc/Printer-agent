// Runs the same printer scan the agent does on startup / on "Scan" from
// /admin/printers, and prints what it found — without reporting it to the web
// app. Use it on the restaurant PC to check that a printer is reachable
// before (or without) involving the admin page.
//
// Usage (from the print-agent folder):
//   node scripts/test-discovery.js
//   DISCOVERY_PORTS=9100,9101 node scripts/test-discovery.js

require('dotenv').config()
const { scanLan, scanComPorts } = require('../discovery')

async function main() {
  const started = Date.now()
  const [lan, usb] = await Promise.all([scanLan(), scanComPorts()])
  console.log(`Scanned: ${lan.networks.map((n) => `${n}.0/24`).join(', ') || '(no private IPv4 network found)'}`)
  console.log(`LAN printers (${lan.devices.length}):`)
  for (const d of lan.devices) console.log(`  ${d.ip}:${d.port}`)
  console.log(`COM ports (${usb.length})${process.platform === 'win32' ? '' : ' — Windows only, skipped'}:`)
  for (const d of usb) console.log(`  ${d.comPort}  ${d.name}`)
  console.log(`Done in ${Date.now() - started}ms`)
}

main().catch((err) => {
  console.error('❌', err.message)
  process.exit(1)
})
