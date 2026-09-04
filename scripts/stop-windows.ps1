# 一键停止 Creative Studio(网页版 + 桌面版)与 LiteLLM 代理。
# 停机顺序:状态文件校验后优雅停机(/api/shutdown)→ 等待端口释放 → 按项目归属强制清理。
# 状态文件缺失或失效时,按端口属主与进程特征兜底;但绝不结束与项目目录无关的进程。
param(
  [int]$Port = $(if ($env:BATCH_WORKBENCH_PORT) { [int]$env:BATCH_WORKBENCH_PORT } else { 3000 })
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$runDir = Join-Path $Root 'storage\run'
$serviceFile = Join-Path $runDir 'electron-service.json'
$stackFile = Join-Path $runDir 'stack.json'

function Get-ListenerPids([int]$TargetPort) {
  @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-ProjectProcess([int]$TargetPid) {
  # 可执行路径或命令行归属本项目目录,才允许强制结束;两者都不沾边的一律不动。
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $exe = [string]$proc.ExecutablePath
  $cmd = [string]$proc.CommandLine
  return (($exe -and $exe.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) -or ($cmd -and $cmd.Contains($Root)))
}

function Wait-PortReleased([int]$TargetPort, [int]$TimeoutSec) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-PortOwners([int]$TargetPort, [string]$Label) {
  foreach ($ownerPid in (Get-ListenerPids $TargetPort)) {
    if (Test-ProjectProcess $ownerPid) {
      Write-Host "强制结束$Label进程 PID: $ownerPid"
      Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    } else {
      Write-Host "端口 $TargetPort 的进程(PID $ownerPid)不属于本项目,跳过(不误杀)。" -ForegroundColor Yellow
    }
  }
}

Write-Host '[1/2] 停止 Creative Studio...'

# ── 桌面版服务:electron-service.json + 实例校验后优雅停机(桌面服务走动态端口)──
$desktopOrigin = $null
if (Test-Path $serviceFile) {
  try {
    $service = Get-Content $serviceFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $origin = [string]$service.origin
    $instanceId = [string]$service.instanceId
    if ($origin -and $instanceId) {
      $health = Invoke-RestMethod -Uri "$origin/api/desktop/health" -TimeoutSec 3 -ErrorAction Stop
      if ($health.instanceId -eq $instanceId) { $desktopOrigin = $origin }
    }
  } catch {}
}
if ($desktopOrigin) {
  try { Invoke-RestMethod -Method Post -Uri "$desktopOrigin/api/shutdown" -TimeoutSec 5 | Out-Null } catch {}
  $desktopPort = [int]([Uri]$desktopOrigin).Port
  if (Wait-PortReleased $desktopPort 8) {
    Write-Host "桌面版服务已停止($desktopOrigin)。"
  } else {
    Stop-PortOwners $desktopPort '桌面版服务'
  }
}

# ── 固定端口(默认 3000):网页版/独立服务优雅停机 + 强制清理 ──
$fixedPids = Get-ListenerPids $Port
if ($fixedPids.Count -gt 0) {
  if ($fixedPids | Where-Object { Test-ProjectProcess $_ }) {
    try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/shutdown" -TimeoutSec 5 | Out-Null } catch {}
    if (Wait-PortReleased $Port 8) {
      Write-Host "端口 $Port 的服务已停止。"
    } else {
      Stop-PortOwners $Port '工作台'
    }
  } else {
    Write-Host "端口 $Port 被非本项目进程占用,跳过(不误杀)。" -ForegroundColor Yellow
  }
}

# ── 进程特征兜底:状态文件丢失时,清掉仍挂在项目目录下的桌面壳/服务/dev 残留 ──
$appMarkers = '(server-entry\.js|standalone[\\/]server\.js|electron[\\/]cli\.js|next[\\/]dist[\\/]bin[\\/]next)'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'electron.exe' } |
  Where-Object {
    $exe = [string]$_.ExecutablePath
    $cmd = [string]$_.CommandLine
    (($_.Name -eq 'electron.exe') -and $exe -and $exe.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) -or
    ($cmd -and $cmd.Contains($Root) -and $cmd -match $appMarkers)
  } |
  ForEach-Object {
    Write-Host "清理残留进程 PID: $($_.ProcessId) ($($_.Name))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
if (Test-Path $serviceFile) { Remove-Item $serviceFile -Force -ErrorAction SilentlyContinue }

# ── 联动关闭 LiteLLM 代理(若曾由启动脚本拉起,或端口仍被占用)──
Write-Host '[2/2] 停止 LiteLLM 代理...'
$proxyBusy = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ((Test-Path $stackFile) -or $proxyBusy) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'stop-stack.ps1')
} else {
  Write-Host 'LiteLLM 代理未在运行。'
}
