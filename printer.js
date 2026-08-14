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
      const connectionType = p.connectionType === 'USB' ? 'USB' : 'LAN'
      if (connectionType === 'USB') {
        if (p.comPort) next[p.station] = { connectionType, comPort: p.comPort }
      } else if (p.ipAddress) {
        next[p.station] = { connectionType, ip: p.ipAddress, port: p.port }
      }
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
    // USB: node-thermal-printer falls through to its File interface for any
    // string that isn't tcp://... or printer:..., so a raw Windows device
    // path (\\.\COM3) is written to directly — no native driver needed.
    interface:
      target.connectionType === 'USB'
        ? `\\\\.\\${target.comPort}`
        : `tcp://${target.ip}:${target.port}`,
    options: { timeout: 5000 },
  })
}

// USB targets have no ip/port, LAN targets have no comPort — this picks
// whichever description makes sense so error messages point at the right thing.
function describeTarget(target) {
  return target.connectionType === 'USB' ? `USB ${target.comPort}` : `${target.ip}:${target.port}`
}

const HEALTH_CHECK_INTERVAL_MS = 30_000

// Periodic liveness probe — separate from actual printing, so staff can see
// which printers are reachable without waiting for a real job to fail. LAN
// targets get a real TCP connect/close via node-thermal-printer's
// isPrinterConnected(). USB targets can't be verified without printing, so
// they report UNKNOWN — the server only lets that fill in a never-checked
// station, never overwrite a real ONLINE/OFFLINE set by an actual print-job
// outcome (see app/api/printer-status in the Next.js app).
async function checkAllPrinters() {
  const entries = Object.entries(printerCache)
  if (entries.length === 0) return

  const results = await Promise.all(
    entries.map(async ([station, target]) => {
      if (target.connectionType === 'USB') {
        return { station, status: 'UNKNOWN' }
      }
      const printer = createPrinterForTarget(target)
      const connected = await printer.isPrinterConnected()
      return connected
        ? { station, status: 'ONLINE' }
        : { station, status: 'OFFLINE', error: `Could not connect to ${describeTarget(target)}` }
    })
  )

  try {
    const res = await fetch(`${API_URL}/api/printer-status`, {
      method: 'POST',
      headers: { 'x-agent-key': AGENT_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ results }),
    })
    if (!res.ok) throw new Error(`Status POST failed: ${res.status}`)
  } catch (err) {
    console.error('⚠️  Could not report printer health:', err.message)
  }
}

// Wait for the first config load so this doesn't run against an empty cache.
ready.then(() => {
  checkAllPrinters()
  setInterval(checkAllPrinters, HEALTH_CHECK_INTERVAL_MS)
})

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
    // Audible cue that a job actually finished, since staff aren't always
    // standing right at the printer to see paper come out. Queued into the
    // same command buffer as printImage/cut above — one execute() flushes
    // all three together. No-op on hardware with no buzzer (the printer
    // just ignores the ESC/POS beep command), so safe to always send.
    printer.beep()
    await printer.execute()
  } catch (err) {
    throw new Error(`Print failed for ${station} (${describeTarget(target)}): ${err.message}`)
  } finally {
    fs.unlink(tmpPath, () => {})
  }
}

// renderReceiptImage returns an array of page buffers (usually just one) —
// each gets printed and cut in sequence, on the same connection-per-call
// pattern printImageBufferToStation already uses, so a bill too long for one
// slip comes out as several instead of failing/garbling (see render.js's
// MAX_PAGE_HEIGHT). Also accepts a bare single buffer for any older caller.
async function printReceiptImage(pages) {
  const list = Array.isArray(pages) ? pages : [pages]
  for (const page of list) {
    await printImageBufferToStation('RECEIPT', page)
  }
}

async function printKotImage(station, imageBuffer) {
  await printImageBufferToStation(station, imageBuffer)
}

// The cash drawer is wired to the RECEIPT printer's drawer-kick (DK) port —
// opening it is just a pulse command, no image involved.
async function openCashDrawer() {
  const target = printerCache['RECEIPT']
  if (!target) {
    throw new Error(`ບໍ່ໄດ້ຕັ້ງຄ່າ IP ໃຫ້ RECEIPT — ໄປຕັ້ງໃນ /admin/printers`)
  }

  try {
    const printer = createPrinterForTarget(target)
    printer.openCashDrawer()
    await printer.execute()
  } catch (err) {
    throw new Error(`Drawer open failed for RECEIPT (${describeTarget(target)}): ${err.message}`)
  }
}

// Isolated buzzer test (see scripts/test-beep.js) — same ESC/POS command
// printImageBufferToStation already sends on every real print, but on its
// own with no image/cut, so you can confirm the printer's buzzer works
// without spending paper on a full test print each time.
async function testBeep() {
  const target = printerCache['RECEIPT']
  if (!target) {
    throw new Error(`ບໍ່ໄດ້ຕັ້ງຄ່າ IP ໃຫ້ RECEIPT — ໄປຕັ້ງໃນ /admin/printers`)
  }

  try {
    const printer = createPrinterForTarget(target)
    printer.beep()
    await printer.execute()
  } catch (err) {
    throw new Error(`Beep failed for RECEIPT (${describeTarget(target)}): ${err.message}`)
  }
}

module.exports = { printReceiptImage, printKotImage, openCashDrawer, testBeep, ready }
