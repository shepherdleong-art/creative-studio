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

# ── 2. litellm 代理：按端口属主精确停止 ──
Write-Host '[2/2] 停止 litellm 代理...'
Get-NetTCPConnection -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

if (Test-Path $stackFile) { Remove-Item $stackFile -Force -ErrorAction SilentlyContinue }
Write-Host '已全部停止。'
