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
  targetKey,
  onPrinterHealth,
  SendError,
  BuildError,
} = require('./printer')
const { runDiscovery } = require('./discovery')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000
const PRINT_GAP_MS = Number(process.env.PRINT_GAP_MS) || 3000

// ---------------------------------------------------------------------------
// Automatic retry — the design is written up in the web app's
// reports/POS print retry queue design.md; the server side of the state
// machine is lib/print-job-policy.ts. In short:
//
// * Every physical printer has one lane that prints one job at a time, always
//   picking the OLDEST eligible job (by when the ticket was created). A job
//   that fails because the printer can't be reached does NOT hold the lane
//   while it waits to retry: it goes to RETRY_WAIT with a backoff, the next
//   ticket prints meanwhile, and once its wait is over it is again the oldest
//   eligible job, so it goes before anything that arrived after it.
// * Failures are classified before anything is retried:
//     PRINTER   — nothing reached the printer (connect refused/timed out, COM
//                 port wouldn't open, printer not configured): retried
//                 automatically until the ticket's TTL (enforced by the web
//                 app, which expires it).
//     AMBIGUOUS — bytes were sent but the send didn't complete cleanly: the
//                 printer may have printed or buffered the ticket. Reported
//                 UNKNOWN and never resent automatically (duplicate tickets).
//     JOB       — the job itself is broken (bad payload, render error,
//                 unknown type): FAILED at once, no retries.
// * A per-printer circuit breaker stops sending to a printer after repeated
//   PRINTER failures, then lets exactly one job through when the printer looks
//   back (the 30s health ping sees it ONLINE, or BREAKER_PROBE_MS has passed)
//   before draining the rest oldest-first.
// ---------------------------------------------------------------------------

// Backoff for PRINTER failures: 5s, 15s, 45s, then every 60s — ±20% jitter.
// PRINT_RETRY_DELAYS_MS (comma-separated; the last value repeats) overrides it
// — mainly so scripts/test-retry-lanes.js doesn't have to wait minutes.
const RETRY_DELAYS_MS = (process.env.PRINT_RETRY_DELAYS_MS || '5000,15000,45000,60000')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0)
const RETRY_MAX_DELAY_MS = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] || 60_000
const RETRY_JITTER = 0.2
// Consecutive PRINTER failures before a printer's breaker opens.
const BREAKER_THRESHOLD = 3
// Fallback probe while OPEN — USB printers never report ONLINE from the health
// ping, and a printer can accept TCP while still out of paper.
const BREAKER_PROBE_MS = Number(process.env.BREAKER_PROBE_MS) || 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!API_URL || !AGENT_SECRET) {
  console.error('❌ Missing required .env values — copy .env.example to .env and fill it in.')
  process.exit(1)
}

function retryDelayMs(attempts) {
  const base = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_MAX_DELAY_MS
  const jitter = base * RETRY_JITTER * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

// ---------- reporting to the web app ----------

// PATCH a job's new state. Returns 'ok', 'gone' (409/404 — another agent or
// staff already moved it; drop it) or 'error' (network/5xx). A few quick
// retries matter here: a lost RETRY_WAIT/PRINTED report would leave the job
// PRINTING on the server, which it later turns into UNKNOWN.
async function report(jobId, body) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API_URL}/api/print-jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'x-agent-key': AGENT_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 10_000,
      })
      if (res.ok) return 'ok'
      if (res.status === 409 || res.status === 404) return 'gone'
      throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.warn(`⚠️  Could not report ${body.status} for job ${jobId} (attempt ${attempt}/3): ${err.message}`)
      if (attempt < 3) await sleep(1000 * attempt)
    }
  }
  return 'error'
}

// ---------- which printer a job goes to ----------

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
// — and laning purely by station name would let jobs for those two names
// open concurrent connections to what is, physically, one printer. Falls back
// to a station-scoped key when nothing is configured yet, so an unconfigured
// station's jobs still queue predictably against themselves.
function physicalKeyFor(station) {
  const target = getPrinterTarget(station)
  if (!target) return `unconfigured:${station}`
  return targetKey(target)
}

// Which printer lane a job runs on, and the label used in logs. A TEST job
// (sent from /admin/printers' found-printers list) names its printer directly
// instead of a station — it still runs on that physical printer's lane, so a
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

// ---------- per-printer circuit breaker ----------

const breakers = new Map() // queueKey -> { state: 'CLOSED'|'OPEN'|'HALF_OPEN', failures, openedAt }

function breakerFor(key) {
  let b = breakers.get(key)
  if (!b) {
    b = { state: 'CLOSED', failures: 0, openedAt: 0 }
    breakers.set(key, b)
  }
  return b
}

// May this lane send right now? OPEN lanes wait for a sign of life; the first
// job let through after that is the HALF_OPEN probe.
function breakerAllows(key, now) {
  const b = breakerFor(key)
  if (b.state !== 'OPEN') return true
  if (now - b.openedAt >= BREAKER_PROBE_MS) {
    b.state = 'HALF_OPEN'
    console.log(`🔌 ${key}: trying one job (no response for ${BREAKER_PROBE_MS / 1000}s)`)
    return true
  }
  return false
}

function breakerSuccess(key) {
  const b = breakerFor(key)
  if (b.state !== 'CLOSED') console.log(`✅ ${key}: printer is back — printing the waiting jobs in order`)
  b.state = 'CLOSED'
  b.failures = 0
}

function breakerFailure(key, now) {
  const b = breakerFor(key)
  b.failures++
  if (b.state === 'HALF_OPEN' || (b.state === 'CLOSED' && b.failures >= BREAKER_THRESHOLD)) {
    if (b.state === 'CLOSED') console.warn(`⏸️  ${key}: unreachable ${b.failures}x — pausing it until it's back`)
    b.state = 'OPEN'
    b.openedAt = now
  }
}

// The 30s health ping saw a paused printer accept a connection — let one job
// try now instead of waiting for BREAKER_PROBE_MS.
onPrinterHealth(({ targetKey: key, status }) => {
  const b = breakers.get(key)
  if (status === 'ONLINE' && b && b.state === 'OPEN') {
    b.state = 'HALF_OPEN'
    console.log(`🔌 ${key}: health check says it's reachable — trying one job`)
    schedule()
  }
})

// ---------- the lanes ----------

// Jobs this agent knows about and may still print: id -> entry. Filled from
// each poll (PENDING and RETRY_WAIT jobs from the server); a job leaves when
// it is printed, handed to staff (UNKNOWN/FAILED), or the server stops
// returning it (expired, resolved by staff, claimed elsewhere).
const jobs = new Map()
const busyLanes = new Set()

function entryFor(job) {
  const createdAt = Date.parse(job.createdAt) || 0
  const nextAttemptAt = job.status === 'RETRY_WAIT' && job.nextAttemptAt ? Date.parse(job.nextAttemptAt) || 0 : 0
  return { job, createdAt, attempts: job.attempts || 0, nextAttemptAt, inFlight: false }
}

// Starts the next job on every idle lane: the oldest job whose retry time has
// come, if that printer's breaker lets it through.
function schedule() {
  const now = Date.now()
  const candidates = new Map() // queueKey -> { entry, route }
  for (const entry of jobs.values()) {
    if (entry.inFlight || entry.nextAttemptAt > now) continue
    let route
    try {
      route = queueTargetFor(entry.job, JSON.parse(entry.job.payload))
    } catch {
      // Unparseable payload or invalid TEST target — runs on its own lane so
      // it is failed right away without touching any printer.
      route = { queueKey: `invalid:${entry.job.id}`, label: `job ${entry.job.id}`, target: null }
    }
    const current = candidates.get(route.queueKey)
    if (!current || entry.createdAt < current.entry.createdAt) candidates.set(route.queueKey, { entry, route })
  }
  for (const [key, { entry, route }] of candidates) {
    if (busyLanes.has(key) || !breakerAllows(key, now)) continue
    runLane(key, entry, route)
  }
}

async function runLane(key, entry, route) {
  busyLanes.add(key)
  entry.inFlight = true
  let touchedPrinter = false
  try {
    touchedPrinter = await processJob(entry, route)
  } catch (err) {
    console.error(`Unexpected error handling job ${entry.job.id}:`, err.message)
  } finally {
    entry.inFlight = false
    // A finished send only means the bytes reached the OS socket, not that
    // the printer finished feeding and cutting — starting the next job on this
    // printer right away can corrupt or drop it. PRINT_GAP_MS is that
    // cooldown, kept from the original per-printer queue.
    if (touchedPrinter) await sleep(PRINT_GAP_MS)
    busyLanes.delete(key)
    schedule()
  }
}

// Prints one job and reports the outcome. Returns whether bytes may have
// reached the printer (so the lane observes PRINT_GAP_MS).
async function processJob(entry, route) {
  const { job } = entry
  const id = job.id

  // A job the agent can't even parse or route is broken, not unlucky.
  let payload
  try {
    payload = JSON.parse(job.payload)
    if (job.type === 'TEST' && !route.target) throw new Error('Invalid test-print target')
  } catch (err) {
    await finishWith(id, { status: 'FAILED', errorClass: 'JOB', error: `Unreadable job: ${err.message}` })
    return false
  }

  // Claim it — a 409 means another agent or staff got there first.
  const claim = await report(id, { status: 'PRINTING' })
  if (claim === 'gone') {
    jobs.delete(id)
    return false
  }
  if (claim === 'error') {
    // Server unreachable: leave it in place, a later schedule tries again.
    entry.nextAttemptAt = Date.now() + retryDelayMs(1)
    return false
  }

  // Build the job (rendering problems are JOB failures — retrying can't help).
  let send
  try {
    send = buildSend(job, payload, route)
  } catch (err) {
    await finishWith(id, { status: 'FAILED', errorClass: 'JOB', error: err.message })
    return false
  }

  console.log(`🖨️  ${route.label}: printing job ${id} (${job.type})${entry.attempts ? ` — retry #${entry.attempts}` : ''}`)
  try {
    await send()
  } catch (err) {
    if (err instanceof BuildError) {
      await finishWith(id, { status: 'FAILED', errorClass: 'JOB', error: err.message })
      return false
    }
    const notSent = err instanceof SendError && err.notSent
    if (!notSent) {
      console.error(`❓ ${route.label}: job ${id} may or may not have printed — leaving it to staff: ${err.message}`)
      await finishWith(id, { status: 'UNKNOWN', errorClass: 'AMBIGUOUS', error: err.message })
      return true
    }
    breakerFailure(route.queueKey, Date.now())
    if (job.type === 'TEST') {
      // An admin is waiting on the result next to the scanned device — one try.
      await finishWith(id, { status: 'FAILED', errorClass: 'PRINTER', error: err.message })
      return false
    }
    entry.attempts++
    const delay = retryDelayMs(entry.attempts)
    entry.nextAttemptAt = Date.now() + delay
    console.warn(`⏳ ${route.label}: job ${id} not sent (${err.message}) — retry #${entry.attempts} in ${Math.round(delay / 1000)}s`)
    const result = await report(id, {
      status: 'RETRY_WAIT',
      errorClass: 'PRINTER',
      error: err.message,
      attempts: entry.attempts,
      nextAttemptAt: new Date(entry.nextAttemptAt).toISOString(),
    })
    if (result === 'gone') jobs.delete(id)
    return false
  }

  breakerSuccess(route.queueKey)
  await finishWith(id, { status: 'PRINTED' })
  console.log(`✅ Printed job ${id} (${job.type})`)
  return true
}

// Reports a final state and forgets the job locally.
async function finishWith(id, body) {
  await report(id, body)
  jobs.delete(id)
}

// Turns a job into a function that sends it (throws SendError on failure).
// Throws immediately for anything wrong with the job itself.
function buildSend(job, payload, route) {
  switch (job.type) {
    case 'RECEIPT': {
      const pages = renderReceiptImage(payload)
      return () => printReceiptImage(pages)
    }
    case 'KOT': {
      const image = renderKotImage(payload)
      return () => printKotImage(payload.station, image)
    }
    case 'DRAWER':
      return () => openCashDrawer()
    case 'SESSION_QR': {
      // Per-session ordering QR slip (web app: lib/table-session.ts).
      const image = renderSessionQrImage(payload)
      return () => printImageBufferToStation('RECEIPT', image)
    }
    case 'TEST': {
      const image = renderTestImage({ target: route.target })
      return () => printImageToTarget(route.target, image, 'TEST')
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}

// ---------- polling ----------

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

async function poll() {
  if (pollInProgress) return
  pollInProgress = true
  try {
    const res = await fetch(`${API_URL}/api/print-jobs`, {
      headers: { 'x-agent-key': AGENT_SECRET },
      timeout: 10_000,
    })
    if (!res.ok) throw new Error(`Poll fetch failed: ${res.status}`)
    const data = await res.json()
    maybeStartRequestedScan(data.discoveryRequestedAt)
    syncJobs(data.jobs)
  } catch (err) {
    console.error('Poll error:', err.message)
  } finally {
    pollInProgress = false
    // Also runs on a failed poll: jobs already known whose retry time has
    // come still go out while the web app is unreachable.
    schedule()
  }
}

// Merges the server's list of printable jobs into the local map. Local retry
// timing wins for jobs already known (it's in this PC's clock); a restarted
// agent picks up attempts/nextAttemptAt from the server. Jobs the server no
// longer returns (expired, resolved by staff) are dropped unless in flight.
function syncJobs(serverJobs) {
  const seen = new Set()
  for (const job of serverJobs) {
    seen.add(job.id)
    const entry = jobs.get(job.id)
    if (entry) entry.job = job
    else jobs.set(job.id, entryFor(job))
  }
  for (const [id, entry] of jobs) {
    if (!seen.has(id) && !entry.inFlight) jobs.delete(id)
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

// Only auto-starts when run directly (`node index.js`, or pm2 the same way).
// Guarding it means a test can `require('../index.js')` to exercise the real
// lane/key logic instead of a reimplementation, without that require itself
// kicking off real network polling.
if (require.main === module) {
  main()
}

module.exports = {
  physicalKeyFor,
  stationKeyFor,
  queueTargetFor,
  retryDelayMs,
  // exposed for scripts/test-*.js
  _internals: { jobs, busyLanes, breakers, schedule, syncJobs, poll, breakerAllows, breakerFailure, breakerSuccess },
}
