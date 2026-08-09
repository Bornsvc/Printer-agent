require('dotenv').config()
const fetch = require('node-fetch')
const { renderReceiptImage, renderKotImage, logoReady, qrReady } = require('./render')
const { printReceiptImage, printKotImage, openCashDrawer, ready } = require('./printer')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000
const PRINT_RETRY_DELAY_MS = Number(process.env.PRINT_RETRY_DELAY_MS) || 3000
const DRAWER_RETRIES = Number(process.env.DRAWER_RETRIES) || 1
const PRINT_GAP_MS = Number(process.env.PRINT_GAP_MS) || 2000
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
// This queues jobs per physical printer so same-station jobs run strictly
// one-after-another, while different stations still print in parallel.
//
// execute() resolving only means the bytes were handed to the OS socket — it
// does NOT mean the printer has finished physically feeding/cutting the
// paper. Starting the next job's TCP connection while the printer is still
// mid-cut can still corrupt/drop it even though nothing overlapped in Node.
// PRINT_GAP_MS is a cooldown enforced between jobs on the same station to
// give the printer time to finish before the next one starts.
const stationTails = new Map()

function runOnStationQueue(station, fn) {
  const tail = stationTails.get(station) ?? Promise.resolve()
  const result = tail.then(fn, fn)
  const nextTail = result.then(
    () => {
      console.log(`⏳ ${station}: job done, waiting ${PRINT_GAP_MS}ms before next in queue`)
      return sleep(PRINT_GAP_MS)
    },
    () => sleep(PRINT_GAP_MS)
  )
  stationTails.set(station, nextTail.catch(() => {}))
  return result
}

// RECEIPT and DRAWER jobs both target the RECEIPT printer specifically —
// they must serialize against each other too, not just against themselves.
function stationKeyFor(job, payload) {
  if (job.type === 'KOT') return payload.station
  return 'RECEIPT'
}

async function handleJob(job) {
  try {
    const payload = JSON.parse(job.payload)
    const station = stationKeyFor(job, payload)

    await runOnStationQueue(station, async () => {
      console.log(`🖨️  ${station}: starting job ${job.id} (${job.type})`)
      if (job.type === 'RECEIPT') {
        const image = renderReceiptImage(payload)
        await retryPrintAction(() => printReceiptImage(image), `Receipt print for job ${job.id}`)
      } else if (job.type === 'KOT') {
        const image = renderKotImage(payload)
        await retryPrintAction(() => printKotImage(payload.station, image), `KOT print for job ${job.id}`)
      } else if (job.type === 'DRAWER') {
        await openCashDrawer()
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
  await poll()
  setInterval(poll, POLL_INTERVAL_MS)
  console.log(`✅ Polling for new print jobs every ${POLL_INTERVAL_MS / 1000}s...`)
}

main()
