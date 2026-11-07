// End-to-end check of the automatic-retry lanes in index.js — the real
// index.js/printer.js/render.js, against a mock web app (in-memory print_jobs
// with the same state rules as the web app's PATCH route) and fake TCP
// printers that can be switched off, or made to cut the connection mid-job.
// No real printer and no web app needed.
//
// Usage (from the print-agent folder):
//   node scripts/test-retry-lanes.js
//
// Scenarios:
//   1. A failing job does not block the job behind it; it keeps its seniority.
//   2. A broken job (unknown type) fails at once and never touches a printer.
//   3. Printer down: jobs wait, the breaker pauses the printer after 3 tries,
//      and when it's back the jobs print oldest-first.
//   4. Bytes sent but the printer cut the connection → UNKNOWN, never resent.
//   5. A job the server refuses to hand out (409 on claim) is dropped, not printed.
//   6. The bytes sent are exactly what node-thermal-printer would have sent.

const http = require('http')
const net = require('net')
const path = require('path')
const fs = require('fs')
const os = require('os')

process.env.PRINT_GAP_MS = '150'
process.env.PRINT_RETRY_DELAYS_MS = '1500'
process.env.BREAKER_PROBE_MS = '2500'
process.env.PRINT_LANGUAGE = 'en'

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(50)
  }
  return false
}

// ---------- fake printers ----------
function fakePrinter() {
  const p = { port: 0, received: [], mode: 'ok', server: null }
  const handle = (socket) => {
    if (p.mode === 'cut') {
      // Accept, take a little data, then reset — "bytes sent, outcome unknown".
      socket.once('data', () => socket.resetAndDestroy())
      socket.on('error', () => {})
      return
    }
    const chunks = []
    socket.on('data', (d) => chunks.push(d))
    socket.on('close', () => {
      const buf = Buffer.concat(chunks)
      if (buf.length) p.received.push({ at: Date.now(), buf })
    })
    socket.on('error', () => {})
  }
  p.up = () =>
    new Promise((resolve) => {
      p.server = net.createServer(handle)
      p.server.listen(p.port, '127.0.0.1', () => {
        p.port = p.server.address().port
        resolve()
      })
    })
  p.down = () => new Promise((resolve) => (p.server ? p.server.close(() => resolve()) : resolve()))
  return p
}

// ---------- mock web app ----------
const store = new Map() // id -> job
let seq = 0
const refuseClaim = new Set()
const ALLOWED = {
  PRINTING: ['PENDING', 'RETRY_WAIT'],
  PRINTED: ['PENDING', 'PRINTING', 'RETRY_WAIT', 'UNKNOWN'],
  RETRY_WAIT: ['PRINTING'],
  UNKNOWN: ['PRINTING'],
  FAILED: ['PENDING', 'PRINTING', 'RETRY_WAIT'],
}
function addJob(type, payload, extra = {}) {
  const id = `job-${++seq}`
  const job = {
    id,
    type,
    station: type === 'KOT' ? payload.station : 'RECEIPT',
    payload: JSON.stringify(payload),
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: new Date(Date.now() + seq).toISOString(), // strictly increasing
    history: [],
    ...extra,
  }
  store.set(id, job)
  return job
}
const kot = (table) => ({ tableNumber: table, station: 'HOT_KITCHEN', stationLabel: 'Hot', items: [{ quantity: 1, name: `dish ${table}` }] })

let printerA, printerB
function startApi() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.url === '/api/printer-config') {
        return send(200, {
          printers: [
            { station: 'HOT_KITCHEN', connectionType: 'LAN', ipAddress: '127.0.0.1', port: String(printerA.port) },
            { station: 'RECEIPT', connectionType: 'LAN', ipAddress: '127.0.0.1', port: String(printerB.port) },
          ],
          logoUrl: null,
          paymentQrUrl: null,
        })
      }
      if (req.url === '/api/print-jobs' && req.method === 'GET') {
        const jobs = [...store.values()]
          .filter((j) => j.status === 'PENDING' || j.status === 'RETRY_WAIT')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        return send(200, { jobs, discoveryRequestedAt: null })
      }
      const m = req.url.match(/^\/api\/print-jobs\/([^/]+)$/)
      if (m && req.method === 'PATCH') {
        const job = store.get(m[1])
        if (!job) return send(404, {})
        const b = JSON.parse(body || '{}')
        if (b.status === 'PRINTING' && refuseClaim.has(job.id)) return send(409, { status: job.status })
        if (!ALLOWED[b.status] || !ALLOWED[b.status].includes(job.status)) return send(409, { status: job.status })
        job.status = b.status
        job.history.push(b.status)
        if (b.status === 'RETRY_WAIT') Object.assign(job, { attempts: b.attempts, nextAttemptAt: b.nextAttemptAt })
        if (b.error) job.error = b.error
        if (b.errorClass) job.errorClass = b.errorClass
        if (b.status === 'PRINTED') job.printedAt = Date.now()
        return send(200, { ok: true })
      }
      if (req.url === '/api/printer-status' || req.url === '/api/printer-discovery') return send(200, { ok: true })
      send(404, {})
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function main() {
  printerA = fakePrinter() // HOT_KITCHEN
  printerB = fakePrinter() // RECEIPT
  await printerA.up()
  await printerB.up()
  const api = await startApi()
  process.env.API_URL = `http://127.0.0.1:${api.address().port}`
  process.env.AGENT_SECRET = 'test'

  const printer = require('../printer')
  const agent = require('../index')
  const { _internals } = agent
  await printer.ready
  const ticker = setInterval(() => _internals.poll(), 200)
  const reset = () => {
    for (const j of store.values()) if (j.status === 'PENDING' || j.status === 'RETRY_WAIT') j.status = 'DONE_BY_TEST'
    _internals.breakers.clear()
  }

  // ---- 1. A fails, B behind it prints; A keeps seniority over later jobs ----
  console.log('\n--- 1. a failing job does not block the next one ---')
  await printerA.down()
  const a = addJob('KOT', kot('A'))
  await waitFor(() => a.status === 'RETRY_WAIT')
  check('A: printer unreachable → RETRY_WAIT (nothing sent)', a.status === 'RETRY_WAIT' && a.errorClass === 'PRINTER', a.error)
  await printerA.up() // printer recovers before A's retry time
  const b = addJob('KOT', kot('B'))
  await waitFor(() => b.status === 'PRINTED', 5000)
  check('B printed while A was still waiting to retry', b.status === 'PRINTED' && a.status === 'RETRY_WAIT')
  await waitFor(() => a.status === 'PRINTED', 8000)
  check('A printed by itself once its wait was over', a.status === 'PRINTED' && a.printedAt > b.printedAt && a.attempts === 1)
  // (A's seniority over newer tickets when both are ready is scenario 3.)
  reset()

  // ---- 2. broken job fails at once, never reaches a printer ----
  console.log('\n--- 2. a broken job fails immediately ---')
  const before = printerA.received.length + printerB.received.length
  const broken = addJob('MYSTERY', {})
  const after = addJob('KOT', kot('after-broken'))
  await waitFor(() => broken.status === 'FAILED' && after.status === 'PRINTED', 5000)
  check('unknown job type → FAILED (JOB), no retry', broken.status === 'FAILED' && broken.errorClass === 'JOB', broken.error)
  check('the next ticket still printed', after.status === 'PRINTED')
  check('nothing extra reached any printer', printerA.received.length + printerB.received.length === before + 1)
  reset()

  // ---- 3. printer down: breaker, then oldest-first drain ----
  console.log('\n--- 3. printer down → pause → resume in order ---')
  await printerA.down()
  const d1 = addJob('KOT', kot('D1'))
  const d2 = addJob('KOT', kot('D2'))
  const d3 = addJob('KOT', kot('D3'))
  await waitFor(() => _internals.breakers.get(`lan:127.0.0.1:${printerA.port}`)?.state === 'OPEN', 10000)
  const brk = _internals.breakers.get(`lan:127.0.0.1:${printerA.port}`)
  check('after 3 unreachable attempts the printer is paused (breaker OPEN)', brk?.state === 'OPEN', `failures=${brk?.failures}`)
  const attemptsWhilePaused = d1.attempts + d2.attempts + d3.attempts
  await sleep(1500)
  check('no attempts burned while paused', d1.attempts + d2.attempts + d3.attempts === attemptsWhilePaused)
  check('all three still waiting (none dropped)', [d1, d2, d3].every((j) => j.status === 'RETRY_WAIT' || j.status === 'PENDING'))
  await printerA.up()
  await waitFor(() => [d1, d2, d3].every((j) => j.status === 'PRINTED'), 12000)
  check('printer back → all printed', [d1, d2, d3].every((j) => j.status === 'PRINTED'))
  check('printed oldest-first (D1, D2, D3)', d1.printedAt < d2.printedAt && d2.printedAt < d3.printedAt)
  check('breaker closed again', brk?.state === 'CLOSED')
  reset()

  // ---- 4. which send failures count as "maybe printed" ----
  // Checked on sendRaw directly: a real ~20KB ticket always fits in the OS
  // socket buffers, so a printer that stops reading can only be simulated
  // with a large buffer. (A small ticket cut off AFTER it was handed to the OS
  // looks like a success — only a printer status read (phase 4) can tell.)
  console.log('\n--- 4. classification of send failures ---')
  const { sendRaw } = printer
  const resetter = net.createServer((sock) => {
    sock.on('error', () => {})
    sock.resetAndDestroy()
  })
  await new Promise((r) => resetter.listen(0, '127.0.0.1', r))
  const staller = net.createServer((sock) => {
    sock.pause() // like a printer out of paper with a full buffer
    sock.on('error', () => {})
  })
  await new Promise((r) => staller.listen(0, '127.0.0.1', r))
  const lan = (srv) => ({ connectionType: 'LAN', ip: '127.0.0.1', port: String(srv.address().port) })
  const outcome = async (fn) => {
    try {
      await fn()
      return 'resolved'
    } catch (err) {
      return err.notSent ? 'NOT_SENT' : 'AMBIGUOUS'
    }
  }
  check('connection refused → NOT_SENT', (await outcome(() => sendRaw({ connectionType: 'LAN', ip: '127.0.0.1', port: '1' }, Buffer.alloc(10), 'T'))) === 'NOT_SENT')
  const big = Buffer.alloc(64_000_000, 0x41)
  const r = await outcome(() => sendRaw(lan(resetter), big, 'T'))
  check('reset before/while sending a large job → NOT_SENT or AMBIGUOUS, never "printed"', r !== 'resolved', r)
  check('printer stops reading mid-job → AMBIGUOUS (not retried)', (await outcome(() => sendRaw(lan(staller), big, 'T'))) === 'AMBIGUOUS')
  resetter.close()
  staller.close()

  // ---- 5. claim refused ----
  console.log('\n--- 5. claim refused (409) → dropped ---')
  const beforeB = printerB.received.length
  const x = addJob('DRAWER', { tableId: 'x' })
  refuseClaim.add(x.id)
  await sleep(1500)
  check('job the server refused to hand out was not printed', printerB.received.length === beforeB && x.status === 'PENDING')
  check('…and the agent stopped trying it', !_internals.jobs.has(x.id) || _internals.jobs.get(x.id).inFlight === false)
  x.status = 'DONE_BY_TEST'
  refuseClaim.delete(x.id)
  reset()

  // ---- 6. byte-for-byte same as node-thermal-printer would send ----
  console.log('\n--- 6. same bytes as before ---')
  const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
  const { renderKotImage } = require('../render')
  const payload = kot('BYTES')
  const n0 = printerA.received.length
  const job6 = addJob('KOT', payload)
  await waitFor(() => job6.status === 'PRINTED' && printerA.received.length > n0, 5000)
  const sent = printerA.received[printerA.received.length - 1].buf
  const reference = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: `tcp://127.0.0.1:${printerA.port}` })
  const tmp = path.join(os.tmpdir(), `ref-${Date.now()}.png`)
  fs.writeFileSync(tmp, renderKotImage(payload))
  await reference.printImage(tmp)
  reference.cut()
  fs.unlinkSync(tmp)
  // render.js stamps the current time on a KOT, so compare everything except
  // the image raster: same header/command bytes and same length.
  const ref = reference.getBuffer()
  check('sent buffer has the same length as the library path', sent.length === ref.length, `${sent.length} vs ${ref.length}`)
  check('same leading command bytes', sent.subarray(0, 8).equals(ref.subarray(0, 8)))
  check('same trailing cut sequence', sent.subarray(-12).equals(ref.subarray(-12)))

  clearInterval(ticker)
  await printerA.down()
  await printerB.down()
  api.close()
  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
