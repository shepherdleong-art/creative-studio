﻿param(
  [int]$Port = $(if ($env:BATCH_WORKBENCH_PORT) { [int]$env:BATCH_WORKBENCH_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root

Write-Host '========================================'
Write-Host '  批量图片编辑工作台 - Windows 启动器'
Write-Host '========================================'
Write-Host ''

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '未找到 Node.js。请先安装 Node.js LTS: https://nodejs.org' -ForegroundColor Red
  exit 1
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host '未找到 npm。请确认 Node.js 已正确安装并重新打开 PowerShell。' -ForegroundColor Red
  exit 1
}

$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Write-Host "当前 Node.js 版本是 $nodeVersion，建议安装 Node.js 20 或更高版本。" -ForegroundColor Red
  exit 1
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  Write-Host "端口 $Port 已被占用。" -ForegroundColor Yellow
  if ($proc) {
    Write-Host "PID: $($proc.ProcessId)"
    Write-Host "CommandLine: $($proc.CommandLine)"
  }
  Write-Host "如果这是本工作台，请先运行 stop-windows.cmd；如果要换端口，请运行："
  Write-Host '$env:BATCH_WORKBENCH_PORT=3001; .\start-windows.cmd'
  exit 1
}

$needsInstall = -not (Test-Path (Join-Path $Root 'node_modules'))
$sharpWin = Join-Path $Root 'node_modules\@img\sharp-win32-x64'
$sqliteWin = Join-Path $Root 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
if (-not $needsInstall -and (-not (Test-Path $sharpWin) -or -not (Test-Path $sqliteWin))) {
  Write-Host '检测到 node_modules 可能不是 Windows 环境安装的，准备重新安装依赖。' -ForegroundColor Yellow
  $needsInstall = $true
}

if ($needsInstall) {
  Write-Host '正在安装依赖，请保持联网...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) {
    Write-Host '依赖安装失败。请检查网络、npm registry 或杀毒软件拦截。' -ForegroundColor Red
    exit $LASTEXITCODE
  }
  Write-Host ''
}

$url = "http://127.0.0.1:$Port"
Write-Host "访问地址: $url"
Write-Host '停止服务：在此窗口按 Ctrl+C，或运行 stop-windows.cmd。'
Write-Host ''

& npm.cmd run dev -- --hostname 127.0.0.1 --port $Port
exit $LASTEXITCODE
