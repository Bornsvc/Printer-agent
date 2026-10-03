# One-shot setup for a restaurant PC: installs dependencies, creates .env,
# and runs the print agent under a pm2 Windows service so it starts on boot
# (before anyone logs in) and restarts on crash. Safe to re-run any time.
#
# Run via setup.cmd (double-click) — re-launches itself as Administrator.

$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
Start-Transcript -Path (Join-Path $root 'setup-agent.log') -Force | Out-Null

$appName = 'printer-agent'
$serviceName = 'pm2.exe'
$pm2Home = 'C:\ProgramData\pm2'

function Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host "`nERROR: $text" -ForegroundColor Red
  Stop-Transcript | Out-Null
  Read-Host 'Press Enter to close'
  exit 1
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
# Native commands don't throw on non-zero exit; this does.
function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { Fail "'$exe $($argv -join ' ')' failed (exit $LASTEXITCODE)" }
}
# Runs a native command silently and returns its exit code. Redirecting native
# stderr under ErrorActionPreference=Stop throws in PowerShell 5.1, so relax it.
function Quiet($exe, [string[]]$argv) {
  $ErrorActionPreference = 'Continue'
  & $exe @argv *> $null
  return $LASTEXITCODE
}

try {
  # --- 1. Node.js ---------------------------------------------------------
  Step '1/7 Node.js'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org then run setup again.'
    }
    Write-Host 'Node.js not found - installing LTS with winget...'
    Run winget @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-source-agreements', '--accept-package-agreements')
    Refresh-Path
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Fail 'Node.js was installed but is not on PATH yet. Close this window and run setup again.'
    }
  }
  Write-Host "node $(node -v), npm $(npm -v)"

  # --- 2. Project dependencies ---------------------------------------------
  Step '2/7 npm install'
  Run npm @('install', '--no-audit', '--no-fund')

  # --- 3. .env ---------------------------------------------------------------
  Step '3/7 .env'
  $envFile = Join-Path $root '.env'
  $envVals = @{}
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envVals[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  $apiUrl = $envVals['API_URL']
  $secret = $envVals['AGENT_SECRET']
  if (-not $apiUrl -or $apiUrl -eq 'https://yourapp.com' -or -not $secret) {
    Write-Host '.env is missing API_URL / AGENT_SECRET - please enter them.'
    do { $apiUrl = (Read-Host 'API_URL (e.g. https://your-app.ondigitalocean.app)').Trim().TrimEnd('/') } while (-not $apiUrl)
    do { $secret = (Read-Host 'AGENT_SECRET (this restaurant''s agent key)').Trim() } while (-not $secret)

    $template = if (Test-Path $envFile) { Get-Content $envFile } else { Get-Content (Join-Path $root '.env.example') }
    $lines = foreach ($line in $template) {
      if ($line -match '^\s*API_URL\s*=') { "API_URL=$apiUrl" }
      elseif ($line -match '^\s*AGENT_SECRET\s*=') { "AGENT_SECRET=$secret" }
      else { $line }
    }
    [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Saved .env'
  } else {
    Write-Host "Using existing .env (API_URL=$apiUrl)"
  }

  # Same endpoint/header printer.js uses on startup, so a typo shows up now
  # instead of as a silent "Could not refresh printer config" in pm2 logs.
  try {
    $cfg = Invoke-RestMethod -Uri "$apiUrl/api/printer-config" -Headers @{ 'x-agent-key' = $secret } -TimeoutSec 15
    $stations = @($cfg.printers | ForEach-Object { $_.station }) -join ', '
    Write-Host "Server OK. Printers configured: $(if ($stations) { $stations } else { '(none yet - add them in /admin/printers)' })" -ForegroundColor Green
  } catch {
    Write-Host "WARNING: could not reach $apiUrl/api/printer-config with this AGENT_SECRET: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host 'Fix API_URL / AGENT_SECRET in .env if this is wrong, then re-run setup. Continuing anyway...' -ForegroundColor Yellow
  }

  # --- 4. pm2 + pm2-windows-service (global) --------------------------------
  # The service process require()s the *global* pm2 — without it the service
  # crash-loops with "Cannot find module 'pm2'".
  # Only installs what's missing: reinstalling while the service is running
  # fails with EBUSY (the service holds its daemon log files open).
  Step '4/7 pm2 (global)'
  $npmRoot = (npm root -g).Trim()
  $missing = @('pm2', 'pm2-windows-service') | Where-Object { -not (Test-Path (Join-Path $npmRoot "$_\package.json")) }
  if ($missing) {
    Run npm (@('install', '-g') + $missing + @('--no-audit', '--no-fund'))
    Refresh-Path
  } else {
    Write-Host 'pm2 and pm2-windows-service already installed'
  }

  # --- 5. Machine-wide pm2 settings -----------------------------------------
  # The service runs as LocalSystem, so PM2_HOME must be a machine path, not
  # the default %USERPROFILE%\.pm2 — and the admin CLI must use the same one.
  Step '5/7 PM2_HOME'
  New-Item -ItemType Directory -Force $pm2Home | Out-Null
  [Environment]::SetEnvironmentVariable('PM2_HOME', $pm2Home, 'Machine')
  [Environment]::SetEnvironmentVariable('PM2_SERVICE_PM2_DIR', (Join-Path $npmRoot 'pm2\index.js'), 'Machine')
  $env:PM2_HOME = $pm2Home
  Write-Host "PM2_HOME=$pm2Home"

  # pm2-windows-startup (login-time `pm2 resurrect`) would fight the service.
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if (Get-ItemProperty $runKey -Name PM2 -ErrorAction SilentlyContinue) {
    Remove-ItemProperty $runKey -Name PM2
    Write-Host 'Removed old pm2-windows-startup login entry'
  }

  # --- 6. Windows service ---------------------------------------------------
  Step '6/7 PM2 Windows service'
  $svc = Get-Service $serviceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    Run node @((Join-Path $PSScriptRoot 'install-pm2-service.js'), (Join-Path $npmRoot 'pm2-windows-service'))
  } else {
    Set-Service $serviceName -StartupType Automatic
    if ($svc.Status -ne 'Running') { Start-Service $serviceName }
  }

  # Wait for the service's pm2 daemon to accept CLI connections.
  $up = $false
  for ($i = 0; $i -lt 20 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    $up = ((Quiet pm2 @('ping')) -eq 0)
  }
  if (-not $up) { Fail "pm2 service did not come up. Check $npmRoot\pm2-windows-service\src\daemon\pm2.err.log" }
  Get-Service $serviceName | Format-Table Name, Status, StartType

  # --- 7. Start the agent and save ------------------------------------------
  Step '7/7 Start printer-agent'
  # Old setups registered this same index.js under other names.
  foreach ($old in @($appName, 'print-agent', 'index')) { Quiet pm2 @('delete', $old) | Out-Null }
  Run pm2 @('start', (Join-Path $root 'ecosystem.config.js'))
  Run pm2 @('save')

  # Desktop shortcut that opens an elevated cmd in this folder — pm2 commands
  # only work as Administrator with a machine-wide PM2_HOME.
  $desk = [Environment]::GetFolderPath('Desktop')
  $lnk = Join-Path $desk 'PM2 Admin.lnk'
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = "$env:WINDIR\System32\cmd.exe"
  $s.Arguments = "/k cd /d `"$root`" && pm2 status"
  $s.WorkingDirectory = $root
  $s.Save()
  $bytes = [IO.File]::ReadAllBytes($lnk)
  $bytes[0x15] = $bytes[0x15] -bor 0x20  # "Run as administrator" flag
  [IO.File]::WriteAllBytes($lnk, $bytes)

  Start-Sleep -Seconds 3
  pm2 ls
  pm2 logs $appName --lines 10 --nostream

  Write-Host "`nDONE. The print agent now starts automatically when this PC boots." -ForegroundColor Green
  Write-Host "Use the 'PM2 Admin' desktop shortcut to run pm2 status / logs / restart."
} catch {
  Fail $_.Exception.Message
}

Stop-Transcript | Out-Null
Read-Host 'Press Enter to close'
