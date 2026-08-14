// Sends just the buzzer command to the RECEIPT printer — no image, no paper
// cut, no paper used — so you can quickly confirm the printer's buzzer
// actually makes a sound before relying on it for real prints. If you don't
// hear anything, check the printer's manual: some ESC/POS printers (Epson-
// compatible ones especially) need a physical DIP switch on the unit flipped
// to enable the internal buzzer before this command does anything audible.
//
// Usage (from the print-agent folder):
//   node scripts/test-beep.js

require('dotenv').config()
const { ready, testBeep } = require('../printer')

async function main() {
  console.log('🔔 Printer beep test')
  console.log('')
  console.log('⏳ Loading printer config...')
  await ready

  console.log('🔊 Sending beep to RECEIPT printer...')
  await testBeep()
  console.log('✅ Sent — did you hear it?')
  console.log('   If not: check the printer manual for a buzzer DIP switch, or confirm the')
  console.log('   RECEIPT printer IP is set correctly in /admin/printers.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Beep test failed:', err.message)
    process.exit(1)
  })
