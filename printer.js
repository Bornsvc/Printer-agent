const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
const fetch = require('node-fetch')
const fs = require('fs')
const os = require('os')
const path = require('path')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET

// In-memory cache of printer IPs, refreshed periodically so admin changes
// (made via /admin/printers) take effect without restarting the agent.
let printerCache = {}

// Resolves once the first config fetch has settled (success or failure), so
// index.js can wait for it before polling instead of racing an empty cache.
let markReady
const ready = new Promise((resolve) => {
  markReady = resolve
})

async function refreshPrinterConfig() {
  try {
    const res = await fetch(`${API_URL}/api/printer-config`, {
      headers: { 'x-agent-key': AGENT_SECRET },
    })
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()

    const next = {}
    for (const p of data.printers) {
      if (p.ipAddress) next[p.station] = { ip: p.ipAddress, port: p.port }
    }
    printerCache = next
    console.log('🔄 Printer config refreshed:', Object.keys(printerCache).join(', '))
  } catch (err) {
    console.error('⚠️  Could not refresh printer config (using last known values):', err.message)
  } finally {
    markReady()
  }
}

// Refresh immediately on startup, then every 60 seconds.
refreshPrinterConfig()
setInterval(refreshPrinterConfig, 60_000)

function createPrinterForTarget(target) {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: `tcp://${target.ip}:${target.port}`,
    options: { timeout: 5000 },
  })
}

async function printImageBufferToStation(station, imageBuffer) {
  const target = printerCache[station]
  if (!target) {
    throw new Error(`ບໍ່ໄດ້ຕັ້ງຄ່າ IP ໃຫ້ ${station} — ໄປຕັ້ງໃນ /admin/printers`)
  }

  const tmpPath = path.join(os.tmpdir(), `print-${Date.now()}.png`)
  fs.writeFileSync(tmpPath, imageBuffer)

  try {
    const printer = createPrinterForTarget(target)
    await printer.printImage(tmpPath)
    printer.cut()
    await printer.execute()
  } catch (err) {
    throw new Error(`Print failed for ${station} (${target.ip}:${target.port}): ${err.message}`)
  } finally {
    fs.unlink(tmpPath, () => {})
  }
}

async function printReceiptImage(imageBuffer) {
  await printImageBufferToStation('RECEIPT', imageBuffer)
}

async function printKotImage(station, imageBuffer) {
  await printImageBufferToStation(station, imageBuffer)
}

module.exports = { printReceiptImage, printKotImage, ready }
