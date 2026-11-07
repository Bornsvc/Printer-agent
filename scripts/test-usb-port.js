// Prints a sample receipt to a Windows printer by its spooler PORT (USB001,
// USB002, ...) — bypasses the API, the DB and /admin/printers entirely.
//
// Why a separate script: USB00x ports aren't device files like COM3, so the
// `\\.\COMx` path printer.js uses for USB targets can't open them. They belong
// to the Windows print spooler, so this script finds the printer installed on
// that port and hands it the same ESC/POS bytes (image + cut + beep) as a
// RAW spooler job — the driver passes them through untouched.
//
// Usage (Windows, from the print-agent folder):
//   node scripts/test-usb-port.js                # port USB002
//   node scripts/test-usb-port.js USB001         # another port
//   node scripts/test-usb-port.js --list         # show printers + their ports
//
// A copy of the rendered PNG is also saved next to this script so you can
// preview it on screen without waiting on the printer.

require('dotenv').config()
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer')
const { renderReceiptImage, logoReady, qrReady } = require('../render')

const arg = process.argv[2] || 'USB002'

const sample = {
  tableNumber: 'TEST ' + arg,
  lines: [
    { quantity: 1, name: 'ตำหลวงพระบาง', lineTotal: 70 },
    { quantity: 1, name: 'คอหมูย่าง', lineTotal: 139 },
    { quantity: 1, name: 'ข้าวเหนียว (1 กะติบ)', lineTotal: 30 },
  ],
  subtotal: 239,
  serviceCharge: 0,
  total: 239,
}

// Win32 WritePrinter with datatype RAW — the standard way to push raw
// ESC/POS through the spooler without the driver re-rendering it.
const RAW_PRINTER_PS = `
param([string]$Port, [string]$Data)
$ErrorActionPreference = 'Stop'
$p = Get-Printer | Where-Object { $_.PortName -eq $Port } | Select-Object -First 1
if (-not $p) { throw "No printer installed on port $Port (run with --list)" }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int StartDocPrinter(IntPtr h, int level, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
  public static void Send(string name, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(name, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = "Printer-agent USB test", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      int written;
      bool ok = WritePrinter(h, data, data.Length, out written);
      EndPagePrinter(h);
      EndDocPrinter(h);
      if (!ok || written != data.Length) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
    } finally { ClosePrinter(h); }
  }
}
'@
[RawPrint]::Send($p.Name, [System.IO.File]::ReadAllBytes($Data))
Write-Output $p.Name
`

function powershell(args) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
  }).trim()
}

function listPrinters() {
  console.log(powershell(['-Command', 'Get-Printer | Format-Table Name, PortName, DriverName -AutoSize']))
}

// node-thermal-printer accepts any object with execute(buffer) as its
// interface — this one writes the buffer to a temp file and spools it.
function spoolerInterface(port) {
  return {
    async execute(buffer) {
      const stamp = Date.now()
      const binPath = path.join(os.tmpdir(), `usb-test-${stamp}.bin`)
      const psPath = path.join(os.tmpdir(), `usb-test-${stamp}.ps1`)
      fs.writeFileSync(binPath, buffer)
      fs.writeFileSync(psPath, RAW_PRINTER_PS)
      try {
        const name = powershell(['-File', psPath, '-Port', port, '-Data', binPath])
        console.log(`   ↳ spooled ${buffer.length} bytes to "${name}" on ${port}`)
      } finally {
        fs.unlink(binPath, () => {})
        fs.unlink(psPath, () => {})
      }
    },
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('USB00x ports only exist on Windows — run this on the restaurant PC.')
  }
  if (arg === '--list') return listPrinters()

  console.log('⏳ Loading logo + QR...')
  await Promise.all([logoReady, qrReady])

  console.log('🖼  Rendering receipt image...')
  const pages = renderReceiptImage(sample)

  for (const [i, page] of pages.entries()) {
    const suffix = pages.length > 1 ? `-${i + 1}` : ''
    const previewPath = path.join(__dirname, `last-usb-preview${suffix}.png`)
    fs.writeFileSync(previewPath, page)
    console.log(`💾 Saved preview: ${previewPath}`)

    // Same image -> cut -> beep sequence printer.js sends for RECEIPT.
    const printer = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: spoolerInterface(arg) })
    await printer.printImage(previewPath)
    printer.cut()
    printer.beep()
    console.log(`🖨️  Sending page ${i + 1}/${pages.length} to port ${arg}...`)
    await printer.execute()
  }
  console.log('✅ Done — check the printer.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test print failed:', err.message)
    process.exit(1)
  })
