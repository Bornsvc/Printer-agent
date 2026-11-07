// Verifies the fix for: two different station names (e.g. RECEIPT and
// HOT_KITCHEN) pointed at the SAME physical printer IP from /admin/printers
// must serialize against each other, not just against themselves — see
// physicalKeyFor and the per-printer lanes in index.js. Before this fix, the queue
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
  const { physicalKeyFor, stationKeyFor } = require('../index')

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

  // Jobs on the same key share one printer lane in index.js, so they print one
  // at a time; different keys print in parallel. That lane behaviour is
  // exercised end to end by scripts/test-retry-lanes.js.

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('❌ Script crashed:', err)
  process.exit(1)
})
