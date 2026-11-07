// Verifies the fix for: two different station names (e.g. RECEIPT and
// HOT_KITCHEN) pointed at the SAME physical printer IP from /admin/printers
// must serialize against each other, not just against themselves — see
// physicalKeyFor/runOnPrinterQueue in index.js. Before this fix, the queue
// was keyed by station name alone, so two such stations could open
// concurrent connections to the one printer they actually share.
//
// No physical printer needed: this checks the queueing/key-derivation logic
// directly against the real index.js and printer.js (not a reimplementation),
// using a mock /api/printer-config server to configure the shared-IP scenario.
//
// Usage:
//   node scripts/test-shared-printer-queue.js

const http = require('http')

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}`)
    failures++
  }
}

async function main() {
  // RECEIPT and HOT_KITCHEN share one IP; COLD_KITCHEN gets its own — so the
  // test also confirms genuinely different printers still get different keys.
  const server = http.createServer((req, res) => {
    if (req.url === '/api/printer-config') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          printers: [
            { station: 'RECEIPT', connectionType: 'LAN', ipAddress: '10.0.0.50', port: 9100 },
            { station: 'HOT_KITCHEN', connectionType: 'LAN', ipAddress: '10.0.0.50', port: 9100 },
            { station: 'COLD_KITCHEN', connectionType: 'LAN', ipAddress: '10.0.0.51', port: 9100 },
          ],
          logoUrl: null,
          paymentQrUrl: null,
        })
      )
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  process.env.API_URL = `http://127.0.0.1:${port}`
  process.env.AGENT_SECRET = 'test-secret'

  const printer = require('../printer')
  const { physicalKeyFor, stationKeyFor, runOnPrinterQueue } = require('../index')

  await printer.ready
  server.close()

  console.log('--- key derivation ---')
  const receiptKey = physicalKeyFor('RECEIPT')
  const hotKitchenKey = physicalKeyFor('HOT_KITCHEN')
  const coldKitchenKey = physicalKeyFor('COLD_KITCHEN')
  console.log({ receiptKey, hotKitchenKey, coldKitchenKey })
  check('RECEIPT and HOT_KITCHEN (same IP) resolve to the SAME queue key', receiptKey === hotKitchenKey)
  check('COLD_KITCHEN (different IP) resolves to a DIFFERENT queue key', coldKitchenKey !== receiptKey)
  check(
    'a DRAWER job (stationKeyFor -> RECEIPT) shares RECEIPT\'s key too',
    physicalKeyFor(stationKeyFor({ type: 'DRAWER' }, {})) === receiptKey
  )

  console.log('--- actual concurrency: same key must serialize, different keys must not ---')
  const events = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // Two jobs on keys that resolve to the same physical printer (RECEIPT +
  // HOT_KITCHEN) — the second must not start until the first's whole
  // job-plus-gap cycle finishes, proving they're on ONE queue, not two.
  const sameQueueRun = Promise.all([
    runOnPrinterQueue(receiptKey, 'RECEIPT', async () => {
      events.push('receipt-start')
      await sleep(150)
      events.push('receipt-end')
    }),
    runOnPrinterQueue(hotKitchenKey, 'HOT_KITCHEN', async () => {
      events.push('hotkitchen-start')
      await sleep(150)
      events.push('hotkitchen-end')
    }),
  ])

  // A job on a genuinely different printer (COLD_KITCHEN) fired at the same
  // moment — must NOT be blocked waiting on the shared-printer queue above.
  const coldStart = Date.now()
  let coldStarted = false
  const differentQueueRun = runOnPrinterQueue(coldKitchenKey, 'COLD_KITCHEN', async () => {
    coldStarted = true
    events.push('coldkitchen-start')
  })

  await sleep(30) // give the shared-printer pair's first job time to actually start
  check('a different physical printer is not blocked by the shared one', coldStarted && Date.now() - coldStart < 100)

  await Promise.all([sameQueueRun, differentQueueRun])

  console.log('event order:', events)
  const firstEnd = events.indexOf('receipt-end') >= 0 && events.indexOf('hotkitchen-start') >= 0
    ? Math.min(events.indexOf('receipt-end'), events.indexOf('hotkitchen-start'))
    : -1
  const receiptStartsFirst = events[0] === 'receipt-start'
  const secondJobWaitedForFirst = receiptStartsFirst
    ? events.indexOf('hotkitchen-start') > events.indexOf('receipt-end')
    : events.indexOf('receipt-start') > events.indexOf('hotkitchen-end')
  check(
    'RECEIPT and HOT_KITCHEN jobs ran one at a time, not overlapping',
    secondJobWaitedForFirst
  )

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('❌ Script crashed:', err)
  process.exit(1)
})
