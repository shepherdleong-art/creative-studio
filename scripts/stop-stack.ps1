# 一键停止：关闭 Creative Studio app、litellm 代理
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $PSScriptRoot
$stackFile = Join-Path $Root 'storage\run\stack.json'
$stack = $null
if (Test-Path $stackFile) {
  try { $stack = Get-Content $stackFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
}
$appPort = if ($stack.appPort) { [int]$stack.appPort } else { 3000 }
$proxyPort = if ($stack.proxyPort) { [int]$stack.proxyPort } else { 4000 }

# ── 1. app：先走优雅停机端点，再按进程特征兜底 ──
Write-Host '[1/2] 停止 Creative Studio...'
try {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$appPort/api/shutdown" -TimeoutSec 5 | Out-Null
  Start-Sleep -Seconds 2
} catch {}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -like '*windows-installer*' -and $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ── 2. litellm 代理：优先按状态文件 PID 停止，并校验可执行路径属于本项目运行时 ──
# 不得仅凭端口杀死未知进程：只有可执行路径位于本项目 python-runtime\ 或
# .venv-litellm\ 下的进程才允许停止，其余一律跳过并明示。
Write-Host '[2/2] 停止 litellm 代理...'
$ownedPrefixes = @(
  ((Join-Path $Root 'python-runtime') + '\'),
  ((Join-Path $Root '.venv-litellm') + '\')
)
function Test-OwnedProcess {
  param([int]$TargetPid)
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $exe = [string]$proc.ExecutablePath
  if ($exe) {
    foreach ($prefix in $ownedPrefixes) {
      if ($exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
  }
  # 解释器型孤儿(如系统 Python 承载本项目的 litellm.exe):可执行路径在项目外,
  # 但命令行同时指向本项目目录且带 litellm 入口时,同样视为本项目所有。
  $cmd = [string]$proc.CommandLine
  return ($cmd -and $cmd.Contains($Root) -and $cmd -match 'litellm')
}
$litellmStopped = $false
if ($stack -and $stack.litellmPid) {
  $litellmPid = [int]$stack.litellmPid
  if (Get-Process -Id $litellmPid -ErrorAction SilentlyContinue) {
    if (Test-OwnedProcess $litellmPid) {
      Stop-Process -Id $litellmPid -Force -ErrorAction SilentlyContinue
      $litellmStopped = $true
    } else {
      Write-Host "状态文件中的 PID $litellmPid 不属于本项目运行时，跳过（不误杀未知进程）。" -ForegroundColor Yellow
    }
  }
}
if (-not $litellmStopped) {
  # 兜底：端口属主中只停止可执行路径属于本项目的进程，其余不动。
  Get-NetTCPConnection -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      if (Test-OwnedProcess $_) {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      } else {
        Write-Host "端口 $proxyPort 的占用进程（PID $_）不属于本项目运行时，未停止。" -ForegroundColor Yellow
      }
    }
}

if (Test-Path $stackFile) { Remove-Item $stackFile -Force -ErrorAction SilentlyContinue }
Write-Host '已全部停止。'
