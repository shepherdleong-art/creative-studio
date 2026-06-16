param(
  [int]$Port = $(if ($env:CREATIVE_STUDIO_PORT) { [int]$env:CREATIVE_STUDIO_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$NodeExe = Join-Path $Root 'runtime\node.exe'
$ServerJs = Join-Path $Root 'server.js'
$StorageDir = Join-Path $Root 'storage'
$LogDir = Join-Path $StorageDir 'logs'
$RunDir = Join-Path $StorageDir 'run'
$Url = "http://127.0.0.1:$Port"

function Open-Workbench {
  param([string]$TargetUrl)
  Start-Process $TargetUrl | Out-Null
}

function Get-ListenerProcess {
  param([int]$LocalPort)
  $listener = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
}

function Escape-PowerShellSingleQuoted {
  param([string]$Value)
  return $Value.Replace("'", "''")
}

Write-Host '========================================'
Write-Host '  Creative Studio - Windows Launcher'
Write-Host '========================================'
Write-Host ''

if ([Environment]::OSVersion.Version.Major -lt 10) {
  Write-Host 'Creative Studio requires Windows 10 or Windows 11.' -ForegroundColor Red
  exit 1
}

if (-not [Environment]::Is64BitOperatingSystem) {
  Write-Host 'Creative Studio currently supports Windows x64 only.' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $NodeExe)) {
  Write-Host "Missing private Node runtime: $NodeExe" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $ServerJs)) {
  Write-Host "Missing standalone server file: $ServerJs" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

$existing = Get-ListenerProcess -LocalPort $Port
if ($existing) {
  $commandLine = [string]$existing.CommandLine
  if ($commandLine.Contains($Root)) {
    Write-Host "Creative Studio is already running: $Url" -ForegroundColor Green
    Open-Workbench $Url
    exit 0
  }

  Write-Host "Port $Port is already in use by another process." -ForegroundColor Yellow
  Write-Host "PID: $($existing.ProcessId)"
  if ($commandLine) {
    Write-Host "CommandLine: $commandLine"
  }
  Write-Host 'Set CREATIVE_STUDIO_PORT to another port or close the other program first.'
  exit 1
}

$stdoutLog = Join-Path $LogDir 'server.out.log'
$stderrLog = Join-Path $LogDir 'server.err.log'
$pidFile = Join-Path $RunDir 'server.pid'

$escapedRoot = Escape-PowerShellSingleQuoted $Root
$escapedNode = Escape-PowerShellSingleQuoted $NodeExe
$escapedStdout = Escape-PowerShellSingleQuoted $stdoutLog
$escapedStderr = Escape-PowerShellSingleQuoted $stderrLog
$serverCommand = @"
`$env:PORT = '$Port'
`$env:HOSTNAME = '127.0.0.1'
`$env:NODE_ENV = 'production'
Set-Location -LiteralPath '$escapedRoot'
& '$escapedNode' 'server.js' 1>> '$escapedStdout' 2>> '$escapedStderr'
"@

$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-WindowStyle', 'Hidden',
  '-Command', $serverCommand
) -WorkingDirectory $Root -WindowStyle Hidden -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding UTF8

Write-Host "Starting Creative Studio: $Url"
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  if ($process.HasExited) {
    Write-Host 'Creative Studio exited before the server became ready.' -ForegroundColor Red
    Write-Host "See log: $stderrLog"
    exit 1
  }

  $listener = Get-ListenerProcess -LocalPort $Port
  if ($listener -and ([string]$listener.CommandLine).Contains($Root)) {
    Write-Host "Creative Studio is ready: $Url" -ForegroundColor Green
    Open-Workbench $Url
    exit 0
  }
}

Write-Host 'Creative Studio is still starting. Opening the browser anyway.' -ForegroundColor Yellow
Open-Workbench $Url
exit 0
