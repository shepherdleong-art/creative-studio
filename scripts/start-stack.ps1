# 一键启动：litellm 代理 + Creative Studio app
# 停止用 scripts\stop-stack.ps1（或 一键停止.cmd）。
# 代理仅监听 127.0.0.1；参考图公网交付走腾讯云 COS（CREATIVE_STUDIO_COS_*，见 lib/cos-media.ts）。
param(
  [int]$AppPort = 3000,
  [int]$ProxyPort = 4000,
  # 只启动代理并写 stack.json（供 start-windows.ps1 调用，app 由调用方自己起）
  [switch]$SkipApp
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'storage\logs'
$RunDir = Join-Path $Root 'storage\run'
$stackFile = Join-Path $RunDir 'stack.json'
New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

# 公司网关运行时二选一：本地 venv（开发机）或 setup-company-gateway.ps1 组装的私有运行时
$venvLiteLLM = Join-Path $Root '.venv-litellm\Scripts\litellm.exe'
$embeddedPython = Join-Path $Root '.litellm-runtime\python.exe'
$litellmExe = $null
$litellmArgs = $null
if (Test-Path -LiteralPath $venvLiteLLM) {
  $litellmExe = $venvLiteLLM
  $litellmArgs = @('--config', 'config.yaml', '--port', "$ProxyPort")
} elseif (Test-Path -LiteralPath $embeddedPython) {
  $litellmExe = $embeddedPython
  $litellmArgs = @('-m', 'litellm.proxy.proxy_cli', '--config', 'config.yaml', '--host', '127.0.0.1', '--port', "$ProxyPort", '--num_workers', '1', '--telemetry', 'false')
}
$nodeExe = Join-Path $Root '.cache\windows-installer\node-v22.22.3-win-x64\node.exe'
$standaloneDir = Join-Path $Root '.next\standalone'

if (-not $litellmExe) {
  Write-Host "缺少公司网关运行时：请运行 scripts\setup-company-gateway.ps1（或创建 .venv-litellm）" -ForegroundColor Red
  exit 1
}
$requiredFiles = @($litellmExe, (Join-Path $Root 'config.yaml'))
if (-not $SkipApp) {
  $requiredFiles += $nodeExe
  $requiredFiles += (Join-Path $standaloneDir 'server.js')
}
foreach ($f in $requiredFiles) {
  if (-not (Test-Path $f)) { Write-Host "缺少文件: $f" -ForegroundColor Red; exit 1 }
}

# ── 端口占用检查 ──
foreach ($port in @($AppPort, $ProxyPort)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "端口 $port 已被占用。请先运行 一键停止.cmd（或 scripts\stop-stack.ps1）再启动。" -ForegroundColor Yellow
    exit 1
  }
}

# 只有端口确认空闲后才清理陈旧状态；若旧 sidecar 仍在运行，必须保留其停止依据。
if (Test-Path $stackFile) { Remove-Item $stackFile -Force -ErrorAction SilentlyContinue }

$started = @{}

try {
  # ── 1. litellm 代理 ──
  Write-Host '[1/2] 启动 litellm 代理...'
  $env:PYTHONUTF8 = '1'
  # 不联网拉取远程 model cost map：公司网络访问 GitHub 会超时，拖慢启动并污染 stderr。
  $env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
  $p = Start-Process -FilePath $litellmExe `
    -ArgumentList $litellmArgs `
    -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir 'litellm.out.log') `
    -RedirectStandardError (Join-Path $LogDir 'litellm.err.log')
  $started.litellmPid = $p.Id

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/health/liveliness" -TimeoutSec 2
      if ($r) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw "litellm 代理 60 秒内未就绪，查看 $LogDir\litellm.err.log" }
  Write-Host "      代理就绪: http://127.0.0.1:$ProxyPort"

  # SkipApp 模式：只起代理，写好 stack.json 就退出（app 由调用方启动）
  if ($SkipApp) {
    $started.appPort = $AppPort
    $started.proxyPort = $ProxyPort
    $started.stopScript = Join-Path $Root 'scripts\stop-stack.ps1'
    $started.startedAt = (Get-Date).ToString('s')
    [System.IO.File]::WriteAllText($stackFile, ($started | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "      公司网关组件就绪（代理 :$ProxyPort）"
    exit 0
  }

  # ── 2. 启动 app（环境变量随进程继承）──
  Write-Host '[2/2] 启动 Creative Studio...'
  $env:CREATIVE_STUDIO_DATA_ROOT = $Root
  $appCmd = "`"$nodeExe`" server.js >> `"$LogDir\server.out.log`" 2>> `"$LogDir\server.err.log`""
  $p = Start-Process cmd -ArgumentList '/c', "`"$appCmd`"" `
    -WorkingDirectory $standaloneDir -WindowStyle Hidden -PassThru
  $started.appCmdPid = $p.Id

  $ok = $false
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw "app 90 秒内未就绪，查看 $LogDir\server.err.log" }

  # ── 记录状态供停止脚本使用 ──
  $started.appPort = $AppPort
  $started.proxyPort = $ProxyPort
  $started.stopScript = Join-Path $Root 'scripts\stop-stack.ps1'
  $started.startedAt = (Get-Date).ToString('s')
  [System.IO.File]::WriteAllText($stackFile, ($started | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

  Write-Host ''
  Write-Host '========================================' -ForegroundColor Green
  Write-Host '  全部就绪' -ForegroundColor Green
  Write-Host "  工作台:   http://127.0.0.1:$AppPort"
  Write-Host "  代理:     http://127.0.0.1:$ProxyPort"
  Write-Host '  停止:     一键停止.cmd'
  Write-Host '========================================' -ForegroundColor Green
} catch {
  Write-Host "启动失败: $_" -ForegroundColor Red
  Write-Host '清理已启动的进程...'
  foreach ($k in 'appCmdPid', 'litellmPid') {
    if ($started[$k]) { Stop-Process -Id $started[$k] -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path $stackFile) { Remove-Item $stackFile -Force -ErrorAction SilentlyContinue }
  exit 1
}
