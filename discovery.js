// Printer discovery: finds printers this PC can reach so an admin can pick
// one on /admin/printers instead of typing an IP or COM port. The web app
// can't see the restaurant's LAN or USB ports itself — only this agent can.
//
//   LAN: every host on this PC's own /24 network(s) with a raw-print port
//        (9100 by default) accepting TCP connections — what thermal printers
//        listen on. Only private (RFC 1918) networks are scanned.
//   USB: Windows COM ports (USB-serial / virtual-COM printer drivers),
//        printed to as \\.\COMx, plus Windows printers on a USB00x spooler
//        port (driver-installed, e.g. "POS-80C"), printed to via spooler.js.
//
// Results are POSTed to {API_URL}/api/printer-discovery. Runs once on
// startup and again whenever an admin presses "Scan" (index.js watches the
// `discoveryRequestedAt` field on its normal job poll).

const net = require('net')
const os = require('os')
const { execFile } = require('child_process')
const fetch = require('node-fetch')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET

// Comma-separated, e.g. "9100,9101" for printers with several raw ports.
const DISCOVERY_PORTS = (process.env.DISCOVERY_PORTS || '9100')
  .split(',')
  .map((p) => Number(p.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
// A printer on the same LAN answers a TCP connect in a few ms; 400ms leaves
// room for a slow Wi-Fi hop without making a 254-host sweep crawl.
const CONNECT_TIMEOUT_MS = Number(process.env.DISCOVERY_TIMEOUT_MS) || 400
// Parallel connection attempts. Each is one SYN — cheap — but some consumer
// routers rate-limit bursts, so it's capped rather than all 254 at once.
const CONCURRENCY = 64
// Never scan more than this many /24 networks (a PC with several NICs/VPNs).
const MAX_NETWORKS = 4

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// The /24 prefixes ("192.168.1") of this PC's private IPv4 interfaces. Scans
// the /24 the PC sits in even on a wider netmask (e.g. a /16) — sweeping
// 65k hosts would take minutes, and printers are almost always on the same
// /24 as the till PC in a restaurant network.
function localNetworks() {
  const prefixes = new Set()
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (!v4 || a.internal || !isPrivateIPv4(a.address)) continue
      prefixes.add(a.address.split('.').slice(0, 3).join('.'))
    }
  }
  return [...prefixes].slice(0, MAX_NETWORKS)
}

function probe(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (open) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, ip)
  })
}

async function runPool(tasks, limit) {
  const results = []
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

async function scanLan() {
  const networks = localNetworks()
  const tasks = []
  for (const prefix of networks) {
    for (let host = 1; host <= 254; host++) {
      for (const port of DISCOVERY_PORTS) {
        const ip = `${prefix}.${host}`
        tasks.push(async () => ((await probe(ip, port)) ? { connectionType: 'LAN', ip, port: String(port) } : null))
      }
    }
  }
  const found = (await runPool(tasks, CONCURRENCY)).filter(Boolean)
  return { networks, devices: found }
}

// Windows only. Win32_PnPEntity (not Win32_SerialPort) because USB-serial
// adapters and printer virtual-COM drivers usually only show up there, named
// like "USB Serial Device (COM3)". `-NoProfile` keeps a slow/broken user
// profile script from stalling the scan.
function scanComPorts() {
  if (process.platform !== 'win32') return Promise.resolve([])
  const script =
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | " +
    'Select-Object -ExpandProperty Name | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.warn('⚠️  COM port scan failed:', err.message)
          return resolve([])
        }
        let names = []
        try {
          const parsed = JSON.parse(stdout.trim() || '[]')
          names = Array.isArray(parsed) ? parsed : [parsed]
        } catch {
          return resolve([])
        }
        const devices = []
        for (const name of names) {
          const m = typeof name === 'string' && name.match(/\((COM\d+)\)/i)
          if (m) devices.push({ connectionType: 'USB', comPort: m[1].toUpperCase(), name })
        }
        resolve(devices)
      }
    )
  })
}

// Windows printers installed with a driver on a USB spooler port (USB001...).
// These never show up as COM ports. comPort is set to the printer's Windows
// name — printer.js sends any non-COMx USB target through the spooler, which
// resolves it by name.
function scanSpoolerPrinters() {
  if (process.platform !== 'win32') return Promise.resolve([])
  const script =
    "Get-Printer | Where-Object { $_.PortName -match '^USB\\d+' } | " +
    'Select-Object Name, PortName | ConvertTo-Json -Compress'
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.warn('⚠️  USB printer scan failed:', err.message)
          return resolve([])
        }
        let printers = []
        try {
          const parsed = JSON.parse(stdout.trim() || '[]')
          printers = Array.isArray(parsed) ? parsed : [parsed]
        } catch {
          return resolve([])
        }
        resolve(
          printers
            .filter((p) => p && typeof p.Name === 'string')
            .map((p) => ({ connectionType: 'USB', comPort: p.Name, name: `${p.Name} (${p.PortName})` }))
        )
      }
    )
  })
}

let scanInProgress = null

// Scans and reports. Concurrent callers share one scan instead of starting a
// second sweep (startup scan + an admin's "Scan" landing at the same time).
function runDiscovery(reason) {
  if (scanInProgress) return scanInProgress
  scanInProgress = (async () => {
    const started = Date.now()
    let devices = []
    let error = null
    try {
      const [lan, com, spooler] = await Promise.all([scanLan(), scanComPorts(), scanSpoolerPrinters()])
      devices = [...lan.devices, ...com, ...spooler]
      if (lan.networks.length === 0) error = 'No private IPv4 network found on this PC — LAN printers were not scanned'
      console.log(
        `🔎 Printer scan (${reason}) found ${devices.length} device(s) in ${Date.now() - started}ms` +
          (lan.networks.length ? ` — scanned ${lan.networks.map((n) => `${n}.0/24`).join(', ')}` : '')
      )
    } catch (err) {
      error = `Scan failed: ${err.message}`
      console.error('⚠️  Printer scan failed:', err.message)
    }

    try {
      const res = await fetch(`${API_URL}/api/printer-discovery`, {
        method: 'POST',
        headers: { 'x-agent-key': AGENT_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices, error }),
        timeout: 10_000,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.error('⚠️  Could not report printer scan:', err.message)
    }
    return devices
  })().finally(() => {
    scanInProgress = null
  })
  return scanInProgress
}

module.exports = { runDiscovery, scanLan, scanComPorts, scanSpoolerPrinters, localNetworks }
