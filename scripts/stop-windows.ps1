param(
  [int]$Port = $(if ($env:BATCH_WORKBENCH_PORT) { [int]$env:BATCH_WORKBENCH_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$url = "http://127.0.0.1:$Port"

Write-Host "正在关闭批量图片编辑工作台: $url"

$looksLikeWorkbench = $false
try {
  $home = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
  $looksLikeWorkbench = $home.Content -match '批量图片编辑工作台|batch-image-workbench'
} catch {
  $looksLikeWorkbench = $false
}

if ($looksLikeWorkbench) {
  try {
    Invoke-WebRequest -Uri "$url/api/shutdown" -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null
    Start-Sleep -Seconds 2
  } catch {
    Write-Host 'shutdown API 没有正常返回，继续检查端口。' -ForegroundColor Yellow
  }
} else {
  Write-Host '端口上的服务不像本工作台，跳过 shutdown API。' -ForegroundColor Yellow
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listeners) {
  Write-Host '服务已停止。' -ForegroundColor Green
  exit 0
}

foreach ($listener in $listeners) {
  $pid = $listener.OwningProcess
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
  $commandLine = if ($proc) { [string]$proc.CommandLine } else { '' }
  $safeToKill = $commandLine.Contains($Root)

  if ($safeToKill) {
    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    Write-Host "已关闭工作台进程 PID: $pid" -ForegroundColor Green
  } else {
    Write-Host "端口 $Port 仍被 PID $pid 占用，但命令行不匹配当前项目，未强制结束。" -ForegroundColor Yellow
    if ($commandLine) {
      Write-Host "CommandLine: $commandLine"
    }
  }
}
