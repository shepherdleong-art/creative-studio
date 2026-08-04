# 一键启动：litellm 代理 + cloudflared 隧道 + Creative Studio app
# 三者联动：先起代理，再起隧道并解析公网地址，最后带环境变量起 app。
# 停止用 scripts\stop-stack.ps1（或 一键停止.cmd）。
param(
  [int]$AppPort = 3000,
  [int]$ProxyPort = 4000,
  # 只启动代理+隧道并写 stack.json（供 start-windows.ps1 调用，app 由调用方自己起）
  [switch]$SkipApp
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'storage\logs'
$RunDir = Join-Path $Root 'storage\run'
$stackFile = Join-Path $RunDir 'stack.json'
New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

$litellmExe = Join-Path $Root '.venv-litellm\Scripts\litellm.exe'
$cloudflaredExe = Join-Path $Root '.cache\cloudflared\cloudflared.exe'
$nodeExe = Join-Path $Root '.cache\windows-installer\node-v22.22.3-win-x64\node.exe'
$standaloneDir = Join-Path $Root '.next\standalone'

$requiredFiles = @($litellmExe, $cloudflaredExe, (Join-Path $Root 'config.yaml'))
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
  Write-Host '[1/3] 启动 litellm 代理...'
  $env:PYTHONUTF8 = '1'
  $p = Start-Process -FilePath $litellmExe `
    -ArgumentList '--config', 'config.yaml', '--port', "$ProxyPort" `
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

  # ── 2. 隧道：先试 cloudflared（无时长限制），失败自动换 pinggy（免费档 60 分钟）──
  Write-Host '[2/3] 启动隧道...'
  $tunnelUrl = $null
  $tunnelEngine = $null

  $cfLog = Join-Path $LogDir 'cloudflared.log'
  for ($attempt = 1; $attempt -le 2 -and -not $tunnelUrl; $attempt++) {
    if ($attempt -gt 1) { Write-Host "      cloudflared 第 $attempt 次尝试..." }
    if (Test-Path $cfLog) { Remove-Item $cfLog -Force }
    $p = Start-Process -FilePath $cloudflaredExe `
      -ArgumentList 'tunnel', '--url', "http://localhost:$AppPort", '--no-autoupdate' `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardError $cfLog
    $started.cloudflaredPid = $p.Id

    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 2
      if ((Test-Path $cfLog)) {
        $m = Select-String -Path $cfLog -Pattern 'https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
             Select-Object -First 1
        if ($m) { $tunnelUrl = $m.Matches[0].Value; break }
      }
      if ($p.HasExited) { break }
    }
    if ($tunnelUrl) { $tunnelEngine = 'cloudflared' } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }

  if (-not $tunnelUrl) {
    Write-Host '      cloudflared 不通，改用 pinggy（免费档 60 分钟后过期，过期需重启本脚本）...'
    $pgLog = Join-Path $LogDir 'pinggy.log'
    if (Test-Path $pgLog) { Remove-Item $pgLog -Force }
    $p = Start-Process -FilePath 'ssh' `
      -ArgumentList '-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=10', '-p', '443', "-R0:localhost:$AppPort", 'a.pinggy.io' `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $pgLog
    $started.pinggyPid = $p.Id

    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 2
      if ((Test-Path $pgLog)) {
        $m = Select-String -Path $pgLog -Pattern 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)' -ErrorAction SilentlyContinue |
             Select-Object -First 1
        if ($m) { $tunnelUrl = $m.Matches[0].Value; break }
      }
      if ($p.HasExited) { break }
    }
    if ($tunnelUrl) { $tunnelEngine = 'pinggy' } else { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }

  if (-not $tunnelUrl) { throw "cloudflared 与 pinggy 均不可用，查看 $LogDir\cloudflared.log 和 pinggy.log" }
  Write-Host "      隧道地址: $tunnelUrl  ($tunnelEngine)"

  # SkipApp 模式：只起代理+隧道，写好 stack.json 就退出（app 由调用方启动）
  if ($SkipApp) {
    $started.tunnelUrl = $tunnelUrl
    $started.tunnelEngine = $tunnelEngine
    $started.appPort = $AppPort
    $started.proxyPort = $ProxyPort
    $started.stopScript = Join-Path $Root 'scripts\stop-stack.ps1'
    $started.startedAt = (Get-Date).ToString('s')
    [System.IO.File]::WriteAllText($stackFile, ($started | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "      公司网关组件就绪（代理 :$ProxyPort，隧道 $tunnelEngine）"
    exit 0
  }

  # ── 3. 启动 app（环境变量随进程继承）──
  Write-Host '[3/3] 启动 Creative Studio...'
  $env:CREATIVE_STUDIO_DATA_ROOT = $Root
  $env:CREATIVE_STUDIO_PUBLIC_BASE_URL = $tunnelUrl
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
  $started.tunnelUrl = $tunnelUrl
  $started.tunnelEngine = $tunnelEngine
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
  Write-Host "  隧道:     $tunnelUrl  ($tunnelEngine)"
  Write-Host '  停止:     一键停止.cmd'
  Write-Host '========================================' -ForegroundColor Green

  # 隧道自检：本机都访问不通的隧道（如被墙的 pinggy），网关大概率也不通
  try {
    $r = Invoke-WebRequest -Uri "$tunnelUrl/" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -ne 200) { Write-Host "注意: 隧道自检返回 $($r.StatusCode)，如生成失败请重启本脚本换隧道" -ForegroundColor Yellow }
  } catch {
    Write-Host '注意: 隧道自检不通（本机访问隧道地址失败），网关可能也访问不到；如生成失败请重启本脚本换隧道' -ForegroundColor Yellow
  }
} catch {
  Write-Host "启动失败: $_" -ForegroundColor Red
  Write-Host '清理已启动的进程...'
  foreach ($k in 'appCmdPid', 'cloudflaredPid', 'pinggyPid', 'litellmPid') {
    if ($started[$k]) { Stop-Process -Id $started[$k] -Force -ErrorAction SilentlyContinue }
  }
  if (Test-Path $stackFile) { Remove-Item $stackFile -Force -ErrorAction SilentlyContinue }
  exit 1
}
