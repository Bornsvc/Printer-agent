// Exercises render.js's runtime branding refresh (see syncBranding in
// render.js) end to end — no physical printer or Next.js dev server needed,
// just two real, publicly-reachable image URLs (e.g. ones just uploaded via
// /admin/settings — see BillBrandingForm.tsx). Checks the full contract:
// fetch+cache on first sync, skip-refetch when the URL hasn't changed,
// revert to the local assets/logo.png / assets/qr-payment.png fallback when
// unset, that the images actually get drawn into a rendered receipt, and
// that a host which accepts the connection but never responds times out
// instead of hanging the whole agent (see render.js's comment on why
// asset.sync has a fetch timeout at all — this is the exact failure mode
// that motivated it).
//
// Usage:
//   node scripts/test-branding-sync.js <logoUrl> <paymentQrUrl>

const http = require('http')
const path = require('path')
const fs = require('fs')
const { createCanvas, Image } = require('@napi-rs/canvas')
const { renderReceiptImage, syncBranding } = require('../render')

const [logoUrl, paymentQrUrl] = process.argv.slice(2)
if (!logoUrl || !paymentQrUrl) {
  console.error('Usage: node scripts/test-branding-sync.js <logoUrl> <paymentQrUrl>')
  process.exit(1)
}

const sample = {
  tableNumber: 'H5',
  lines: [{ quantity: 1, name: 'ตำหลวงพระบาง', lineTotal: 70 }],
  subtotal: 70,
  serviceCharge: 0,
  total: 70,
}

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`)
  } else {
    console.error(`❌ ${label}`)
    failures++
  }
}

function decodePng(pngBuffer) {
  const img = new Image()
  img.src = pngBuffer
  return img
}

// Counts pixels darker than near-white anywhere in [yStart, yEnd) — a crude
// but effective "something got drawn here" probe, since the receipt canvas
// starts pure white and every draw op (text or image) darkens some pixels.
function hasInkInBand(img, yStart, yEnd) {
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const { data } = ctx.getImageData(0, Math.max(0, yStart), img.width, Math.max(1, yEnd - yStart))
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) return true
  }
  return false
}

// A server that accepts the TCP connection and then never writes a
// response — simulates a captive portal or a stalled reverse proxy, which
// is a far more likely real-world trigger than a hostile URL, and is the one
// failure mode a plain "unreachable host" test (ECONNREFUSED, fails
// instantly) can't exercise. Without asset.sync's fetch timeout, this used
// to hang forever and — since printer.js awaits syncBranding before calling
// markReady(), which index.js awaits before it ever starts polling for
// print jobs — silently stopped the whole agent from printing anything.
async function withHangingServer(fn) {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await fn(`http://127.0.0.1:${port}/hang.png`)
  } finally {
    server.close()
  }
}

async function main() {
  console.log('--- initial sync (both URLs, first time) ---')
  const first = await syncBranding({ logoUrl, paymentQrUrl })
  check('logo changed on first sync', first.logoChanged === true)
  check('qr changed on first sync', first.qrChanged === true)
  check('cache files written for logo', fs.existsSync(path.join(__dirname, '..', 'assets', 'cache', 'logo.bin')))
  check('cache files written for qr', fs.existsSync(path.join(__dirname, '..', 'assets', 'cache', 'qr.bin')))

  console.log('--- re-sync with identical URLs (should skip re-fetch) ---')
  const second = await syncBranding({ logoUrl, paymentQrUrl })
  check('logo NOT re-flagged as changed (same URL)', second.logoChanged === false)
  check('qr NOT re-flagged as changed (same URL)', second.qrChanged === false)

  console.log('--- render with branding on: expect ink near the top (logo) and near the bottom (qr) ---')
  const withBranding = renderReceiptImage(sample)[0]
  fs.writeFileSync(path.join(__dirname, 'last-branding-test-on.png'), withBranding)
  const img = decodePng(withBranding)
  check('logo band has ink (y 0-160)', hasInkInBand(img, 0, 160))
  // QR sits after the totals block, above the final thank-you line — bands
  // as a fraction of total height so this doesn't break if the sample bill
  // above it changes length; the last ~60px is reserved for the thank-you
  // text itself, which would make this pass even with no QR drawn at all.
  const qrBandStart = Math.round(img.height * 0.55)
  const qrBandEnd = img.height - 60
  check('qr band has ink (before the closing line)', hasInkInBand(img, qrBandStart, qrBandEnd))

  console.log('--- revert to unset (null, null): should fall back to local assets/*.png ---')
  const reverted = await syncBranding({ logoUrl: null, paymentQrUrl: null })
  check('logo changed on revert to null', reverted.logoChanged === true)
  check('qr changed on revert to null', reverted.qrChanged === true)
  const cachedUrlFile = path.join(__dirname, '..', 'assets', 'cache', 'logo.url')
  check('logo.url cache cleared after revert', fs.readFileSync(cachedUrlFile, 'utf8').trim() === '')

  console.log('--- re-sync with a deliberately unreachable URL (fails fast): should keep last good image ---')
  const failedSync = await syncBranding({ logoUrl: 'http://127.0.0.1:1/nope.png', paymentQrUrl })
  check('failed fetch reports no change (kept last known image)', failedSync.logoChanged === false)

  console.log('--- re-sync against a host that accepts the connection but never responds ---')
  await withHangingServer(async (hangingUrl) => {
    const start = Date.now()
    const guard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('syncBranding did not return within the 15s test guard')), 15_000)
    )
    const result = await Promise.race([syncBranding({ logoUrl: hangingUrl, paymentQrUrl }), guard]).catch((err) => err)
    const elapsed = Date.now() - start
    check(
      `syncBranding returned within 15s instead of hanging (took ${elapsed}ms)`,
      result instanceof Error === false
    )
    if (!(result instanceof Error)) {
      check('hung fetch reports no change (kept last known image)', result.logoChanged === false)
    }
  })

  console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`)
  console.log(`Preview saved: ${path.join(__dirname, 'last-branding-test-on.png')}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('❌ Script crashed:', err)
  process.exit(1)
})
