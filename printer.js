const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
const net = require('net')
const fetch = require('node-fetch')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { syncBranding } = require('./render')

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

// Identifies a physical printer — same scheme the web app's printer discovery
// uses ("lan:ip:port" / "usb:COM3").
function targetKey(target) {
  return target.connectionType === 'USB' ? `usb:${target.comPort}` : `lan:${target.ip}:${target.port}`
}

const healthListeners = new Set()
function onPrinterHealth(listener) {
  healthListeners.add(listener)
  return () => healthListeners.delete(listener)
}

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

  // index.js's per-printer circuit breaker listens for ONLINE results to let a
  // paused printer try its oldest job again (see onPrinterHealth below).
  for (const r of results) {
    const target = printerCache[r.station]
    if (target) {
      for (const listener of healthListeners) {
        try {
          listener({ ...r, targetKey: targetKey(target) })
        } catch (err) {
          console.error('⚠️  Printer health listener failed:', err.message)
        }
      }
    }
  }

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

// How long to wait for a printer to accept a connection / finish taking the
// bytes. Same budget node-thermal-printer used (options.timeout above).
const CONNECT_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 10_000

// Whether a failed send may already have put paper through the printer.
//   notSent: true  — the connection (or COM port) never opened, so nothing
//                    reached the printer; safe to retry automatically.
//   notSent: false — bytes were (or may have been) written; the printer may
//                    have printed, or buffered the job to print later (e.g.
//                    once paper is reloaded). Never resent automatically —
//                    index.js reports it UNKNOWN for staff to decide.
// This is why the agent sends bytes itself instead of calling execute():
// node-thermal-printer reports a connect timeout and a mid-send timeout as the
// same 'Socket timeout', and its COM-port writer keeps retrying in the
// background for minutes after execute() has already rejected.
class SendError extends Error {
  constructor(message, { notSent }) {
    super(message)
    this.notSent = notSent
  }
}

// The job couldn't even be turned into printer bytes (bad image, disk error
// writing the temp PNG) — nothing was sent, and retrying won't help.
class BuildError extends Error {}

function sendLan(target, buffer) {
  return new Promise((resolve, reject) => {
    let connected = false
    let settled = false
    const socket = new net.Socket()
    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(writeTimer)
      socket.destroy()
      if (err) reject(err)
      else resolve()
    }
    const connectTimer = setTimeout(
      () => finish(new SendError('Connection timed out', { notSent: true })),
      CONNECT_TIMEOUT_MS
    )
    let writeTimer
    socket.once('error', (err) =>
      finish(new SendError(err.code || err.message, { notSent: !connected }))
    )
    socket.connect(Number(target.port), target.ip, () => {
      connected = true
      clearTimeout(connectTimer)
      writeTimer = setTimeout(
        () => finish(new SendError('Timed out while sending', { notSent: false })),
        WRITE_TIMEOUT_MS
      )
      // Callback = bytes handed to the OS socket (same point node-thermal-printer
      // treated as done). The printer may still be printing; PRINT_GAP_MS in
      // index.js covers that.
      socket.write(buffer, (err) => finish(err ? new SendError(err.message, { notSent: false }) : null))
    })
  })
}

function sendUsb(target, buffer) {
  const devicePath = `\\\\.\\${target.comPort}`
  return new Promise((resolve, reject) => {
    let timedOut = false
    const openTimer = setTimeout(() => {
      timedOut = true
      reject(new SendError(`Could not open ${target.comPort} in time`, { notSent: true }))
    }, CONNECT_TIMEOUT_MS)
    fs.open(devicePath, 'w', (openErr, fd) => {
      clearTimeout(openTimer)
      if (timedOut) {
        // Gave up already and reported "not sent" — make sure that stays true.
        if (!openErr) fs.close(fd, () => {})
        return
      }
      if (openErr) {
        reject(new SendError(openErr.code || openErr.message, { notSent: true }))
        return
      }
      // A COM-port write can block indefinitely (printer offline mid-job),
      // so it gets its own timer — otherwise this promise never settles and
      // the printer's lane in index.js stays busy until the agent restarts.
      let done = false
      const settle = (err) => {
        if (done) return
        done = true
        clearTimeout(writeTimer)
        fs.close(fd, () => {})
        if (err) reject(err)
        else resolve()
      }
      const writeTimer = setTimeout(
        () => settle(new SendError('Timed out while sending', { notSent: false })),
        WRITE_TIMEOUT_MS
      )
      // fs.write may write fewer bytes than asked — keep going until all of
      // the job is out, or report the partial write as ambiguous.
      const writeFrom = (offset) => {
        fs.write(fd, buffer, offset, buffer.length - offset, null, (writeErr, written) => {
          if (writeErr) return settle(new SendError(writeErr.code || writeErr.message, { notSent: false }))
          const next = offset + written
          if (next >= buffer.length) return settle(null)
          if (written === 0) return settle(new SendError('Printer stopped accepting data', { notSent: false }))
          writeFrom(next)
        })
      }
      writeFrom(0)
    })
  })
}

// Sends an already-built ESC/POS buffer to one printer, with a precise
// "did anything reach the printer?" answer on failure (SendError.notSent).
async function sendRaw(target, buffer, label) {
  try {
    if (target.connectionType === 'USB') await sendUsb(target, buffer)
    else await sendLan(target, buffer)
  } catch (err) {
    const notSent = err instanceof SendError ? err.notSent : false
    throw new SendError(`Print failed for ${label} (${describeTarget(target)}): ${err.message}`, { notSent })
  }
}

function missingConfigError(station) {
  // Nothing was sent — and once an admin fills the printer in, a retry works.
  return new SendError(`ບໍ່ໄດ້ຕັ້ງຄ່າ IP ໃຫ້ ${station} — ໄປຕັ້ງໃນ /admin/printers`, { notSent: true })
}

async function printImageBufferToStation(station, imageBuffer, options = {}) {
  const target = printerCache[station]
  if (!target) throw missingConfigError(station)
  // Audible cue that a job actually finished, since staff aren't always
  // standing right at the printer to see paper come out.
  //
  // RECEIPT-only on purpose: scripts/test-beep.js has only ever confirmed
  // this ESC/POS command against the RECEIPT printer. On an unverified
  // model (the kitchen stations, still various clone units) a rejected or
  // misinterpreted buzzer command can stall the printer's command
  // processor mid-buffer and drop the job — invisibly, since the send
  // still succeeds once the bytes are handed to the OS socket either way
  // (see index.js's PRINT_GAP_MS comment). Enable per-station once that
  // station's printer has been beep-tested the same way.
  await printImageToTarget(target, imageBuffer, station, { beep: station === 'RECEIPT', ...options })
}

// Prints one or more PNG pages to an explicit printer target, each followed by
// a cut, as ONE send — so a multi-page job either goes out whole or fails
// before anything was sent (no half-printed bill on retry). Station jobs go
// through printImageBufferToStation above; TEST jobs from /admin/printers'
// found-printers list call this directly with the scanned target. `label` only
// names the printer in error messages.
async function printImageToTarget(target, pages, label, { beep = false } = {}) {
  const list = Array.isArray(pages) ? pages : [pages]
  const printer = createPrinterForTarget(target)
  const tmpPaths = []
  try {
    for (const page of list) {
      const tmpPath = path.join(os.tmpdir(), `print-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
      fs.writeFileSync(tmpPath, page)
      tmpPaths.push(tmpPath)
      await printer.printImage(tmpPath)
      printer.cut()
    }
    if (beep) printer.beep()
  } catch (err) {
    // Turning the image into printer bytes failed — nothing was sent, and
    // sending again won't fix the image. index.js fails it as a broken job.
    throw new BuildError(`Could not prepare ${label} job: ${err.message}`)
  } finally {
    for (const p of tmpPaths) fs.unlink(p, () => {})
  }
  await sendRaw(target, printer.getBuffer(), label)
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
function parseTestTarget(raw) {
  if (raw && raw.connectionType === 'USB' && /^COM[1-9]\d{0,2}$/i.test(raw.comPort || '')) {
    return { connectionType: 'USB', comPort: raw.comPort.toUpperCase() }
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
// printed and cut in sequence within one send (see printImageToTarget). Also
// accepts a bare single buffer for any older caller (scripts/test-*.js).
async function printReceiptImage(pages) {
  await printImageBufferToStation('RECEIPT', pages)
}

async function printKotImage(station, imageBuffer) {
  await printImageBufferToStation(station, imageBuffer)
}

// The cash drawer is wired to the RECEIPT printer's drawer-kick (DK) port —
// opening it is just a pulse command, no image involved.
async function openCashDrawer() {
  const target = printerCache['RECEIPT']
  if (!target) throw missingConfigError('RECEIPT')
  const printer = createPrinterForTarget(target)
  printer.openCashDrawer()
  await sendRaw(target, printer.getBuffer(), 'RECEIPT drawer')
}

// Isolated buzzer test (see scripts/test-beep.js) — same ESC/POS command
// printImageBufferToStation already sends on every real print, but on its
// own with no image/cut, so you can confirm the printer's buzzer works
// without spending paper on a full test print each time.
async function testBeep() {
  const target = printerCache['RECEIPT']
  if (!target) throw missingConfigError('RECEIPT')
  const printer = createPrinterForTarget(target)
  printer.beep()
  await sendRaw(target, printer.getBuffer(), 'RECEIPT beep')
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
  targetKey,
  onPrinterHealth,
  SendError,
  BuildError,
  sendRaw,
}
