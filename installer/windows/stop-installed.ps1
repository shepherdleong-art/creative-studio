param(
  [int]$Port = $(if ($env:CREATIVE_STUDIO_PORT) { [int]$env:CREATIVE_STUDIO_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Url = "http://127.0.0.1:$Port"
$PidFile = Join-Path $Root 'storage\run\server.pid'

function Stop-TrackedProcess {
  if (-not (Test-Path $PidFile)) { return }
  $rawPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $processId = 0
  if (-not [int]::TryParse($rawPid, [ref]$processId)) { return }

  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if ($proc -and ([string]$proc.CommandLine).Contains($Root)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped Creative Studio launcher process PID: $processId" -ForegroundColor Green
  }
}

Write-Host "Stopping Creative Studio: $Url"

try {
  Invoke-WebRequest -Uri "$Url/api/shutdown" -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null
  Start-Sleep -Seconds 2
} catch {
  Write-Host 'Shutdown API did not respond; checking local processes.' -ForegroundColor Yellow
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $processId = $listener.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  $commandLine = if ($proc) { [string]$proc.CommandLine } else { '' }
  if ($commandLine.Contains($Root)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped Creative Studio server PID: $processId" -ForegroundColor Green
  } else {
    Write-Host "Port $Port is still used by another process; it was not stopped." -ForegroundColor Yellow
  }
}

Stop-TrackedProcess
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Stop command finished.'
