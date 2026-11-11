// Raw ESC/POS printing through the Windows print spooler, for USB printers
// installed with a driver (e.g. "POS-80C" on port USB001). Those aren't
// device files like COM3 — the `\\.\COMx` path printer.js uses for serial
// targets can't open them — so this finds the installed printer by its name
// or its spooler port and hands it the bytes as a RAW job, which the driver
// passes through untouched.

const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Win32 WritePrinter with datatype RAW — the standard way to push raw
// ESC/POS through the spooler without the driver re-rendering it.
const RAW_PRINTER_PS = `
param([string]$Target, [string]$Data)
$ErrorActionPreference = 'Stop'
$p = Get-Printer | Where-Object { $_.Name -eq $Target -or $_.PortName -eq $Target } | Select-Object -First 1
if (-not $p) { throw "No Windows printer named or on port '$Target'" }
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
      var di = new DOCINFO { pDocName = "Printer-agent", pDataType = "RAW" };
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

// `target` is a Windows printer name ("POS-80C") or spooler port ("USB001").
// Resolves with the printer name it actually spooled to. Async (not
// execFileSync) so a slow spooler can't stall polling for other stations.
function spoolRaw(target, buffer) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const binPath = path.join(os.tmpdir(), `spool-${stamp}.bin`)
  const psPath = path.join(os.tmpdir(), `spool-${stamp}.ps1`)
  fs.writeFileSync(binPath, buffer)
  fs.writeFileSync(psPath, RAW_PRINTER_PS)

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-Target', target, '-Data', binPath],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        fs.unlink(binPath, () => {})
        fs.unlink(psPath, () => {})
        if (err) {
          // PowerShell puts the thrown message first on stderr.
          const msg = (stderr || '').trim().split(/\r?\n/)[0] || err.message
          reject(new Error(msg))
        } else {
          resolve(stdout.trim())
        }
      }
    )
  })
}

// node-thermal-printer accepts any object with execute(buffer) as its
// interface — this one spools the buffer.
function spoolerInterface(target) {
  return {
    async execute(buffer) {
      return spoolRaw(target, buffer)
    },
  }
}

module.exports = { spoolRaw, spoolerInterface }
