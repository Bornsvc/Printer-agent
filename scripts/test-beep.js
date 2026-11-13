// Sends just the buzzer command to one station's printer — no image, no paper
// cut, no paper used — so you can quickly confirm the printer's buzzer
// actually makes a sound before relying on it for real prints. Uses the same
// BEEP_TIMES / BEEP_LENGTH from .env as real prints. If you don't hear
// anything, check the printer's manual: some ESC/POS printers (Epson-
// compatible ones especially) need a physical DIP switch on the unit flipped
// to enable the internal buzzer before this command does anything audible.
//
// Test a kitchen station this way (and check the printer still prints
// normally afterwards) before adding it to BEEP_STATIONS in .env.
//
// Usage (from the print-agent folder):
//   node scripts/test-beep.js              (RECEIPT printer)
//   node scripts/test-beep.js HOT_KITCHEN  (any station set in /admin/printers)

require('dotenv').config()
const { ready, testBeep } = require('../printer')

const station = (process.argv[2] || 'RECEIPT').trim().toUpperCase()

async function main() {
  console.log('🔔 Printer beep test')
  console.log('')
  console.log('⏳ Loading printer config...')
  await ready

  console.log(`🔊 Sending beep to ${station} printer...`)
  await testBeep(station)
  console.log('✅ Sent — did you hear it?')
  console.log('   If not: check the printer manual for a buzzer DIP switch, or confirm the')
  console.log(`   ${station} printer is set correctly in /admin/printers.`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Beep test failed:', err.message)
    process.exit(1)
  })
