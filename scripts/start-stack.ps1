# 一键启动：litellm 代理 + Creative Studio app
# 停止用 scripts\stop-stack.ps1（或 一键停止.cmd）。
# 代理仅监听 127.0.0.1；参考图公网交付走腾讯云 COS（CREATIVE_STUDIO_COS_*，见 lib/cos-media.ts）。
param(
  [int]$AppPort = 3000,
  [int]$ProxyPort = 4000,
  # 只启动代理并写 stack.json（供 start-windows.ps1 调用，app 由调用方自己起）
  [switch]$SkipApp,
  # 免安装包模式：只使用包内 python-runtime，损坏即报包不完整，禁止联网修复或回退
  [switch]$Portable
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'storage\logs'
$RunDir = Join-Path $Root 'storage\run'
$stackFile = Join-Path $RunDir 'stack.json'
New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

$litellmExe = Join-Path $Root '.venv-litellm\Scripts\litellm.exe'
$litellmRuntimeKind = 'venv-litellm'
$litellmInterpreter = $litellmExe
$litellmArgs = @('--config', 'config.yaml', '--port', "$ProxyPort", '--host', '127.0.0.1')

if ($Portable) {
  # 免安装模式：只允许包内 python-runtime。缺失、损坏或哈希不符时不删除、
  # 不联网修复、不回退源码 venv 或系统 Python，明确报告包不完整后退出。
  $runtimePython = Join-Path $Root 'python-runtime\python.exe'
  $runtimeManifestFile = Join-Path $Root 'python-runtime\runtime-manifest.json'
  $portableManifestFile = Join-Path $Root 'portable-manifest.json'
  $portableError = $null
  do {
    if (-not (Test-Path $runtimePython)) { $portableError = '缺少 python-runtime\python.exe'; break }
    if (-not (Test-Path $runtimeManifestFile)) { $portableError = '缺少 python-runtime\runtime-manifest.json'; break }
    if (-not (Test-Path $portableManifestFile)) { $portableError = '缺少 portable-manifest.json'; break }
    try {
      $runtimeManifest = Get-Content $runtimeManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { $portableError = 'runtime-manifest.json 无法解析'; break }
    if ([int]$runtimeManifest.schemaVersion -ne 1 -or
        $runtimeManifest.pythonVersion -ne '3.12.10' -or
        $runtimeManifest.litellmVersion -ne '1.89.2' -or
        $runtimeManifest.targetTriple -ne 'x86_64-pc-windows-msvc') {
      $portableError = 'runtime-manifest.json 与锁定基线（Python 3.12.10 / LiteLLM 1.89.2 / win-x64）不符'
      break
    }
    try {
      $portableManifest = Get-Content $portableManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch { $portableError = 'portable-manifest.json 无法解析'; break }
    if ([int]$portableManifest.schemaVersion -ne 1 -or
        $portableManifest.mode -ne 'windows-portable-v1' -or
        -not $portableManifest.files) {
      $portableError = 'portable-manifest.json 模式不是 windows-portable-v1'
      break
    }
    # 关键文件 SHA-256 必须与 portable-manifest.json 记录一致
    foreach ($rel in @('python-runtime/python.exe', 'python-runtime/runtime-manifest.json')) {
      $entry = @($portableManifest.files | Where-Object { $_.path -eq $rel })[0]
      if (-not $entry) { $portableError = "portable-manifest.json 缺少关键文件条目 $rel"; break }
      $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Root ($rel -replace '/', '\'))).Hash.ToLowerInvariant()
      if ($actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
        $portableError = "关键文件哈希不符：$rel"
        break
      }
    }
    if ($portableError) { break }
    # 实测解释器与 LiteLLM 版本，禁止仅凭文件名信任
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $pyVer = (& $runtimePython --version 2>&1 | Out-String).Trim()
      if ($pyVer -ne 'Python 3.12.10') { $portableError = "python-runtime 实际版本不符：$pyVer"; break }
      $liteVer = (& $runtimePython -c "from importlib.metadata import version; print(version('litellm'))" 2>&1 | Out-String).Trim()
      if ($liteVer -ne '1.89.2') { $portableError = "LiteLLM 实际版本不符：$liteVer"; break }
    } finally {
      $ErrorActionPreference = $prevEap
    }
  } while ($false)
  if ($portableError) {
    Write-Host "免安装包不完整，请重新复制（$portableError）。公司网关组件不可用；不执行任何下载、修复或回退。" -ForegroundColor Red
    exit 1
  }
  $litellmExe = $runtimePython
  $litellmRuntimeKind = 'python-runtime'
  $litellmInterpreter = $runtimePython
  $litellmArgs = @('scripts\start-litellm-proxy.py', '--config', 'config.yaml', '--host', '127.0.0.1', '--port', "$ProxyPort")
}
$nodeExe = Join-Path $Root '.cache\windows-installer\node-v22.22.3-win-x64\node.exe'
$standaloneDir = Join-Path $Root '.next\standalone'

$requiredFiles = @($litellmExe, (Join-Path $Root 'config.yaml'))
if (-not $SkipApp) {
  $requiredFiles += $nodeExe
  $requiredFiles += (Join-Path $standaloneDir 'server.js')
}
foreach ($f in $requiredFiles) {
  if (-not (Test-Path $f)) { Write-Host "缺少文件: $f" -ForegroundColor Red; exit 1 }
}

# ── 已有受控 sidecar 且健康时直接复用（与 scripts/start-litellm.sh 语义一致）──
if ($SkipApp -and (Test-Path $stackFile)) {
  try {
    $existing = Get-Content $stackFile -Raw | ConvertFrom-Json
    $existingPid = [int]$existing.litellmPid
    $existingPort = [int]$existing.proxyPort
    if ($existingPid -gt 0 -and $existingPort -eq $ProxyPort -and
        (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
      try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/health/liveliness" -TimeoutSec 2
        if ($r) {
          Write-Host "LiteLLM 已在运行（PID $existingPid），复用现有代理: http://127.0.0.1:$ProxyPort"
          exit 0
        }
      } catch {}
    }
  } catch {}
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
  # 离线加载模型价格表：避免启动时拉取 remote cost map 超时拖慢启动
  $env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
  # 公司网关必须按本机内网路由直连；Codex/终端可能通过 HTTP(S)_PROXY 或 ALL_PROXY 访问公网。
  # 代理变量只从 LiteLLM 子进程移除（等价 start-litellm.sh 的 env -u），
  # 启动后立即恢复，不影响 Codex、Next 或当前 shell。
  $proxyVariables = @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')
  $savedProxyValues = @{}
  foreach ($name in $proxyVariables) {
    $savedProxyValues[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
    [System.Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  try {
    $p = Start-Process -FilePath $litellmExe `
      -ArgumentList $litellmArgs `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $LogDir 'litellm.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'litellm.err.log')
    $started.litellmPid = $p.Id
  } finally {
    foreach ($name in $proxyVariables) {
      [System.Environment]::SetEnvironmentVariable($name, $savedProxyValues[$name], 'Process')
    }
  }

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
    $started.litellmRuntime = $litellmRuntimeKind
    $started.litellmInterpreter = $litellmInterpreter
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
  $started.litellmRuntime = $litellmRuntimeKind
  $started.litellmInterpreter = $litellmInterpreter
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
