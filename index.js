require('dotenv').config()
const fetch = require('node-fetch')
const {
  renderReceiptImage,
  renderKotImage,
  renderSessionQrImage,
  renderTestImage,
  logoReady,
  qrReady,
} = require('./render')
const {
  printReceiptImage,
  printKotImage,
  printImageBufferToStation,
  printImageToTarget,
  parseTestTarget,
  openCashDrawer,
  ready,
  getPrinterTarget,
} = require('./printer')
const { runDiscovery } = require('./discovery')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000
const PRINT_RETRY_DELAY_MS = Number(process.env.PRINT_RETRY_DELAY_MS) || 3000
const DRAWER_RETRIES = Number(process.env.DRAWER_RETRIES) || 1
const PRINT_GAP_MS = Number(process.env.PRINT_GAP_MS) || 3000
const PRINT_RETRY_ATTEMPTS = Number(process.env.PRINT_RETRY_ATTEMPTS) || 3
const PRINT_RETRY_WINDOW_MS = Number(process.env.PRINT_RETRY_WINDOW_MS) || 6 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Retries a job's primary print action up to PRINT_RETRY_ATTEMPTS times,
// spread evenly across PRINT_RETRY_WINDOW_MS (default: 3 attempts over 6
// minutes). If every attempt fails, throws the last error so the caller
// (handleJob) marks the job FAILED instead of retrying forever — a printer
// that's genuinely down no longer jams the queue. Staff can requeue the job
// from /admin/printers once it's back online.
async function retryPrintAction(fn, label) {
  const gap = PRINT_RETRY_ATTEMPTS > 1 ? PRINT_RETRY_WINDOW_MS / (PRINT_RETRY_ATTEMPTS - 1) : 0
  let lastErr
  for (let attempt = 1; attempt <= PRINT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.warn(`⚠️  ${label} failed (attempt ${attempt}/${PRINT_RETRY_ATTEMPTS}): ${err.message}`)
      if (attempt < PRINT_RETRY_ATTEMPTS) await sleep(gap)
    }
  }
  throw lastErr
}

// Bounded retry for best-effort sub-actions (the drawer kick after a receipt
// prints) that shouldn't hold up acking the job forever if it never opens.
async function retryBounded(fn, label, retries) {
  let lastErr
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.warn(`⚠️  ${label} failed (attempt ${attempt}/${retries}): ${err.message}`)
      if (attempt < retries) await sleep(PRINT_RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

if (!API_URL || !AGENT_SECRET) {
  console.error('❌ Missing required .env values — copy .env.example to .env and fill it in.')
  process.exit(1)
}

async function ackJob(jobId, status, error) {
  await fetch(`${API_URL}/api/print-jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'x-agent-key': AGENT_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, error }),
  })
}

// Physical printers can only handle one job at a time — two concurrent TCP
// connections writing to the same printer interleave their raw ESC/POS bytes
// and corrupt each other (each job's own execute() still resolves fine, since
// the corruption happens on the printer's side, invisible to this process —
// that's why jobs can show PRINTED in the DB while only one paper comes out).
// This queues jobs per physical printer so same-printer jobs run strictly
// one-after-another, while different printers still print in parallel.
//
// execute() resolving only means the bytes were handed to the OS socket — it
// does NOT mean the printer has finished physically feeding/cutting the
// paper. Starting the next job's TCP connection while the printer is still
// mid-cut can still corrupt/drop it even though nothing overlapped in Node.
// PRINT_GAP_MS is a cooldown enforced between jobs on the same printer to
// give the printer time to finish before the next one starts.
const printerQueueTails = new Map()

// `queueKey` identifies the physical printer (see physicalKeyFor below), not
// the station — `label` is only for the console log, so two stations
// sharing one printer still read clearly in the output.
function runOnPrinterQueue(queueKey, label, fn) {
  const tail = printerQueueTails.get(queueKey) ?? Promise.resolve()
  const result = tail.then(fn, fn)
  const nextTail = result.then(
    () => {
      console.log(`⏳ ${label}: job done, waiting ${PRINT_GAP_MS}ms before next in queue`)
      return sleep(PRINT_GAP_MS)
    },
    () => sleep(PRINT_GAP_MS)
  )
  printerQueueTails.set(queueKey, nextTail.catch(() => {}))
  return result
}

// RECEIPT, DRAWER and SESSION_QR jobs all target the RECEIPT printer
// specifically — they must serialize against each other too, not just against
// themselves. TEST jobs have no station (see queueTargetFor).
function stationKeyFor(job, payload) {
  if (job.type === 'KOT') return payload.station
  return 'RECEIPT'
}

// The actual physical printer a station currently resolves to — not just its
// station name. Two different station names can be pointed at the same IP
// (or the same COM port) from /admin/printers — nothing stops an admin from
// wiring, say, HOT_KITCHEN and RECEIPT to one shared printer on a lean setup
// — and queuing purely by station name would let jobs for those two names
// open concurrent connections to what is, physically, the one printer this
// whole queue exists to protect. Falls back to a station-scoped key when
// nothing is configured yet, so an unconfigured station's jobs still queue
// predictably against themselves rather than colliding with every other
// unconfigured station on this same fallback key.
function physicalKeyFor(station) {
  const target = getPrinterTarget(station)
  if (!target) return `unconfigured:${station}`
  return targetKey(target)
}

function targetKey(target) {
  return target.connectionType === 'USB' ? `usb:${target.comPort}` : `lan:${target.ip}:${target.port}`
}

// Which printer queue a job runs on, and the label used in logs. A TEST job
// (sent from /admin/printers' found-printers list) names its printer directly
// instead of a station — it still has to queue on that physical printer, so a
// test print can't interleave with a real receipt if the scanned device is
// already one of the configured printers.
function queueTargetFor(job, payload) {
  if (job.type === 'TEST') {
    const target = parseTestTarget(payload.target)
    if (!target) throw new Error('Invalid test-print target')
    return { queueKey: targetKey(target), label: `TEST ${targetKey(target)}`, target }
  }
  const station = stationKeyFor(job, payload)
  return { queueKey: physicalKeyFor(station), label: station, target: null }
}

async function handleJob(job) {
  try {
    const payload = JSON.parse(job.payload)
    const { queueKey, label, target } = queueTargetFor(job, payload)

    await runOnPrinterQueue(queueKey, label, async () => {
      console.log(`🖨️  ${label}: starting job ${job.id} (${job.type})`)
      if (job.type === 'RECEIPT') {
        const image = renderReceiptImage(payload)
        await retryPrintAction(() => printReceiptImage(image), `Receipt print for job ${job.id}`)
      } else if (job.type === 'KOT') {
        const image = renderKotImage(payload)
        await retryPrintAction(() => printKotImage(payload.station, image), `KOT print for job ${job.id}`)
      } else if (job.type === 'DRAWER') {
        await openCashDrawer()
      } else if (job.type === 'SESSION_QR') {
        // Per-session ordering QR slip (web app: lib/table-session.ts).
        const image = renderSessionQrImage(payload)
        await retryPrintAction(
          () => printImageBufferToStation('RECEIPT', image),
          `Session QR print for job ${job.id}`
        )
      } else if (job.type === 'TEST') {
        // One attempt only — an admin is waiting on the result next to the
        // device on /admin/printers, and a scanned address that isn't really
        // a printer should fail fast rather than retry for minutes.
        await printImageToTarget(target, renderTestImage({ target }), 'TEST')
      } else {
        throw new Error(`Unknown job type: ${job.type}`)
      }
    })

    await ackJob(job.id, 'PRINTED')
    console.log(`✅ Printed job ${job.id} (${job.type})`)
  } catch (err) {
    console.error(`❌ Failed job ${job.id}:`, err.message)
    await ackJob(job.id, 'FAILED', err.message)
  }
}

// Guards only the fetch itself against overlapping with the next tick.
let pollInProgress = false

// Last `discoveryRequestedAt` value seen from the server (an admin's "Scan
// now"). Compared as an opaque value, never against this PC's clock — the
// till PC's clock can be minutes off from the server's. `undefined` until the
// first poll, which only records the value: the startup scan in main() already
// covers any request made before this agent started.
let lastSeenDiscoveryRequest

function maybeStartRequestedScan(requestedAt) {
  const value = requestedAt ?? null
  if (lastSeenDiscoveryRequest === undefined) {
    lastSeenDiscoveryRequest = value
    return
  }
  if (value && value !== lastSeenDiscoveryRequest) {
    lastSeenDiscoveryRequest = value
    runDiscovery('requested from /admin/printers').catch((err) =>
      console.error('⚠️  Requested printer scan failed:', err.message)
    )
  }
}

// Jobs currently being printed (possibly mid-retryPrintAction, which can run
// for a few minutes). Dispatched without awaiting so a stuck job at one station
// can't block polling or other stations' jobs — tracked here instead so the
// next tick's fetch doesn't pick up and re-dispatch the same pending job.
const inFlightJobIds = new Set()

async function poll() {
  if (pollInProgress) return
  pollInProgress = true
  try {
    const res = await fetch(`${API_URL}/api/print-jobs`, {
      headers: { 'x-agent-key': AGENT_SECRET },
    })
    if (!res.ok) throw new Error(`Poll fetch failed: ${res.status}`)
    const data = await res.json()
    maybeStartRequestedScan(data.discoveryRequestedAt)
    for (const job of data.jobs) {
      if (inFlightJobIds.has(job.id)) continue
      inFlightJobIds.add(job.id)
      handleJob(job)
        .catch((err) => console.error(`Unexpected error handling job ${job.id}:`, err.message))
        .finally(() => inFlightJobIds.delete(job.id))
    }
  } catch (err) {
    console.error('Poll error:', err.message)
  } finally {
    pollInProgress = false
  }
}

async function main() {
  console.log(`🖨️  Print agent starting — polling ${API_URL}`)
  await ready
  await Promise.all([logoReady, qrReady])
  // Not awaited — a scan takes a few seconds and must never delay printing.
  runDiscovery('startup').catch((err) => console.error('⚠️  Startup printer scan failed:', err.message))
  await poll()
  setInterval(poll, POLL_INTERVAL_MS)
  console.log(`✅ Polling for new print jobs every ${POLL_INTERVAL_MS / 1000}s...`)
}

// Only auto-starts when run directly (`node index.js`, or pm2 the same way)
// — unchanged for that, the actual entrypoint. Guarding it means a test can
// `require('../index.js')` to exercise physicalKeyFor/runOnPrinterQueue
// against the real code instead of a reimplementation, without that require
// itself kicking off real network polling.
if (require.main === module) {
  main()
}

module.exports = { physicalKeyFor, stationKeyFor, queueTargetFor, runOnPrinterQueue }
