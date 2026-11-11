const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
const fetch = require('node-fetch')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { syncBranding } = require('./render')
const { spoolerInterface } = require('./spooler')

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

// Guards only against overlapping with the next tick — same shape as
// index.js's pollInProgress. Matters more now than it used to: syncBranding
// below fetches an admin-controlled URL (see render.js's comment on why that
// fetch has a timeout), and without this guard a slow-but-not-yet-timed-out
// sync could still overlap the next interval's own sync of a different URL.
let refreshInProgress = false

async function refreshPrinterConfig() {
  if (refreshInProgress) return
  refreshInProgress = true
  try {
    // 10s timeout for the same reason render.js's branding fetch has one —
    // this is API_URL, normally your own server, but a flaky network or a
    // hung reverse proxy would otherwise wedge markReady() below forever.
    const res = await fetch(`${API_URL}/api/printer-config`, {
      headers: { 'x-agent-key': AGENT_SECRET },
      timeout: 10_000,
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

    const branding = await syncBranding({ logoUrl: data.logoUrl, paymentQrUrl: data.paymentQrUrl })
    if (branding.logoChanged || branding.qrChanged) {
      console.log('🖼️  Branding synced:', branding)
    }
  } catch (err) {
    console.error('⚠️  Could not refresh printer config (using last known values):', err.message)
  } finally {
    markReady()
    refreshInProgress = false
  }
}

// Refresh immediately on startup, then every 60 seconds.
refreshPrinterConfig()
setInterval(refreshPrinterConfig, 60_000)

// A USB target's comPort is either a serial port (COM3) or, for a printer
// installed with a Windows driver, its printer name (POS-80C) / spooler port
// (USB001) — those aren't device files and can only be reached via the spooler.
function isSerialPort(name) {
  return /^COM\d+$/i.test(name)
}

function usbInterface(comPort) {
  // Serial: node-thermal-printer falls through to its File interface for any
  // string that isn't tcp://... or printer:..., so a raw Windows device
  // path (\\.\COM3) is written to directly — no native driver needed.
  return isSerialPort(comPort) ? `\\\\.\\${comPort}` : spoolerInterface(comPort)
}

function createPrinterForTarget(target) {
  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: target.connectionType === 'USB' ? usbInterface(target.comPort) : `tcp://${target.ip}:${target.port}`,
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
  // Audible cue that a job actually finished, since staff aren't always
  // standing right at the printer to see paper come out.
  //
  // RECEIPT-only on purpose: scripts/test-beep.js has only ever confirmed
  // this ESC/POS command against the RECEIPT printer. On an unverified
  // model (the kitchen stations, still various clone units) a rejected or
  // misinterpreted buzzer command can stall the printer's command
  // processor mid-buffer and drop the job — invisibly, since execute()
  // still resolves once the bytes are handed to the OS socket either way
  // (see index.js's PRINT_GAP_MS comment). Enable per-station once that
  // station's printer has been beep-tested the same way.
  await printImageToTarget(target, imageBuffer, station, { beep: station === 'RECEIPT' })
}

// Prints one PNG to an explicit printer target and cuts. Station jobs go
// through printImageBufferToStation above; TEST jobs from /admin/printers'
// found-printers list call this directly with the scanned target, since that
// device isn't assigned to any station yet. `label` only names the printer in
// error messages.
async function printImageToTarget(target, imageBuffer, label, { beep = false } = {}) {
  const tmpPath = path.join(os.tmpdir(), `print-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
  fs.writeFileSync(tmpPath, imageBuffer)

  try {
    const printer = createPrinterForTarget(target)
    await printer.printImage(tmpPath)
    printer.cut()
    // Queued into the same command buffer as printImage/cut above — one
    // execute() flushes all of them together.
    if (beep) printer.beep()
    await printer.execute()
  } catch (err) {
    throw new Error(`Print failed for ${label} (${describeTarget(target)}): ${err.message}`)
  } finally {
    fs.unlink(tmpPath, () => {})
  }
}

// A TEST job's target comes from the job payload, not from this agent's own
// config — the server only queues targets its last scan reported, but the
// agent still refuses anything that isn't a well-formed LAN or COM target
// before opening a connection with it.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
// Same RFC 1918 rule discovery.js scans by (and the web app enforces) — a
// test print never leaves the restaurant's own private network.
function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
// A USB target is a COM port or — for a driver-installed printer — its Windows
// printer name ("POS-80C"), the same two forms the web app's
// sanitizeDevices() (lib/printer-discovery.ts) accepts. Anything COM<digits>
// must be a valid COM port, as isSerialPort() routes those to \\.\COMx.
const COM_PORT = /^COM[1-9]\d{0,2}$/i
const PRINTER_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} _.()-]{0,78}[\p{L}\p{M}\p{N})])?$/u
function parseUsbTarget(value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (/^COM\d+$/i.test(v)) return COM_PORT.test(v) ? v.toUpperCase() : null
  return PRINTER_NAME.test(v) ? v : null
}
function parseTestTarget(raw) {
  if (raw && raw.connectionType === 'USB') {
    const comPort = parseUsbTarget(raw.comPort)
    return comPort ? { connectionType: 'USB', comPort } : null
  }
  const port = Number(raw && raw.port)
  if (
    raw &&
    raw.connectionType === 'LAN' &&
    IPV4.test(raw.ip || '') &&
    isPrivateIPv4(raw.ip) &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536
  ) {
    return { connectionType: 'LAN', ip: raw.ip, port: String(port) }
  }
  return null
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

// Exposes the current station -> physical-printer mapping to index.js, so a
// job's print queue can be keyed by what it actually talks to (ip:port or a
// COM port) instead of just its station name — two different station names
// can be pointed at the same physical printer from /admin/printers (e.g. a
// lean single-printer setup), and nothing else would notice they're the same
// device. Returns null for a station with no printer configured yet.
function getPrinterTarget(station) {
  return printerCache[station] ?? null
}

module.exports = {
  printReceiptImage,
  printKotImage,
  printImageBufferToStation,
  printImageToTarget,
  parseTestTarget,
  openCashDrawer,
  testBeep,
  ready,
  getPrinterTarget,
}
