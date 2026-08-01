require('dotenv').config()
const fetch = require('node-fetch')
const { renderReceiptImage, renderKotImage } = require('./render')
const { printReceiptImage, printKotImage, ready } = require('./printer')

const API_URL = process.env.API_URL
const AGENT_SECRET = process.env.AGENT_SECRET
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000

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

async function handleJob(job) {
  const payload = JSON.parse(job.payload)

  try {
    if (job.type === 'RECEIPT') {
      const image = renderReceiptImage(payload)
      await printReceiptImage(image)
    } else if (job.type === 'KOT') {
      const image = renderKotImage(payload)
      await printKotImage(payload.station, image)
    } else {
      throw new Error(`Unknown job type: ${job.type}`)
    }

    await ackJob(job.id, 'PRINTED')
    console.log(`✅ Printed job ${job.id} (${job.type})`)
  } catch (err) {
    console.error(`❌ Failed job ${job.id}:`, err.message)
    await ackJob(job.id, 'FAILED', err.message)
  }
}

// Prevents a slow print job from overlapping with the next tick's fetch,
// which would otherwise process (and print) the same pending job twice.
let pollInProgress = false

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
      await handleJob(job)
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
  await poll()
  setInterval(poll, POLL_INTERVAL_MS)
  console.log(`✅ Polling for new print jobs every ${POLL_INTERVAL_MS / 1000}s...`)
}

main()
