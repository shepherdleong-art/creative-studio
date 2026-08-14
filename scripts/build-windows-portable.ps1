#Requires -Version 5.1
<#
.SYNOPSIS
  装配 Windows 免安装包（创意工作台 portable 分发目录）。
.DESCRIPTION
  仅供维护者在本机仓库执行，终端用户不运行本脚本。
  - 只从显式白名单装配：node-runtime、python-runtime、node_modules、
    .next/standalone、dist-desktop、scripts、package.json、config.yaml、.env.local、
    环境自检.cmd，以及 installer/windows 下的 portable 启动模板与使用说明。
    除此之外的本机状态（.venv-litellm、data、storage、outputs、docs、.git、
    .cache、dist 等）一律不进成品。
  - 装配前先运行 python-runtime 只读验收与 payload 前置检查，任一缺失即失败。
  - 在同盘临时目录完成装配并生成 portable-manifest.json，然后改名发布；
    目标目录已存在时拒绝覆盖。
  - config.yaml / .env.local 只复制，不读取、不打印；manifest 只记录相对路径、
    大小与 SHA-256，不含密钥值。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-portable.ps1 -OutputPath D:\release\创意工作台-0.4.0-免安装版
#>
[CmdletBinding()]
param(
  # 成品输出目录（必须是尚不存在的新目录）
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'build-windows-portable.ps1 只能在 Windows 上运行（免安装包面向 Windows x64）。'
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Set-Location $Root

$OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) {
  throw "目标目录已存在，拒绝覆盖：$OutputPath。免安装包每次发布必须装配到全新目录，再由人工复制到共享盘。"
}
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent)) {
  New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
}
# 同盘临时目录：与目标同父目录，最后的改名发布是同盘原子移动
$staging = Join-Path $outputParent ('.portable-staging-{0}' -f [guid]::NewGuid().ToString('N'))

# ── 显式白名单（除此之外一律不进免安装包）──
$whitelistDirs = @(
  'node-runtime',        # 内置便携 Node 22（node-runtime\node.exe）
  'python-runtime',      # 内置便携 Python 3.12.10 + LiteLLM 1.89.2
  'node_modules',        # 含 Electron 二进制与预编译原生模块（better-sqlite3/sharp）
  'dist-desktop'         # 桌面壳编译产物（main.js/preload.js 等）
)
$whitelistFiles = @(
  'package.json',        # Electron 以包根为 app 目录，必须携带
  'config.yaml',         # 公司网关配置（含 Key）：只复制，绝不读取或打印
  '.env.local',          # 腾讯云 COS 密钥：只复制，绝不读取或打印
  '环境自检.cmd'
)
# installer 模板 → 成品根目录落点
$templateMap = @(
  @{ Source = 'installer\windows\start-windows-portable.cmd'; Target = 'start-windows.cmd' },
  @{ Source = 'installer\windows\使用说明-portable.txt';      Target = '使用说明.txt' }
)

# portable-manifest.json 关键文件清单：前 11 项与 scripts/start-desktop-windows.ps1
# 的预检契约保持一致（缺失即判定包损坏），其余为启动/自检入口。
$manifestKeyFiles = @(
  'node-runtime/node.exe',
  'node_modules/.bin/electron.cmd',
  'node_modules/electron/dist/electron.exe',
  '.next/standalone/server.js',
  '.next/standalone/runtime/server-entry.js',
  'python-runtime/python.exe',
  'python-runtime/runtime-manifest.json',
  'scripts/start-desktop-windows.ps1',
  'scripts/start-stack.ps1',
  'scripts/start-litellm-proxy.py',
  'config.yaml',
  'dist-desktop/main.js',
  'package.json',
  'scripts/stop-stack.ps1',
  'scripts/diagnose-local-env.mjs',
  'start-windows.cmd',
  '环境自检.cmd',
  '使用说明.txt'
)

# 成品中绝不允许出现的路径（本机数据、密钥缓存、开发/构建产物）
$forbiddenInPayload = @(
  '.venv-litellm',
  'data',
  'storage',
  'outputs',
  'docs',
  '.git',
  '.cache',
  'dist',
  'desktop',
  'installer'
)

try {
  # ── 1/5 python-runtime 只读验收（版本/manifest/wheel 抽查/许可证）──
  Write-Host '[1/5] 验收 python-runtime...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'verify-python-runtime-windows.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'python-runtime 验收失败，停止装配。' }

  # ── 2/5 payload 前置检查：白名单来源与关键文件齐备 ──
  Write-Host '[2/5] payload 前置检查...'
  $requiredSources = @(
    '.next\standalone',
    'scripts',
    'scripts\start-desktop-windows.ps1',
    'scripts\start-stack.ps1',
    'scripts\stop-stack.ps1',
    'scripts\start-litellm-proxy.py',
    'scripts\diagnose-local-env.mjs',
    'node-runtime\node.exe',
    'python-runtime\python.exe',
    'python-runtime\runtime-manifest.json',
    'node_modules\.bin\electron.cmd',
    'node_modules\electron\dist\electron.exe',
    '.next\standalone\server.js',
    '.next\standalone\runtime\server-entry.js',
    'dist-desktop\main.js'
  ) + $whitelistDirs + $whitelistFiles + @($templateMap | ForEach-Object { $_.Source })
  $missing = @($requiredSources | Sort-Object -Unique | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) })
  if ($missing.Count -gt 0) {
    throw ("payload 前置检查失败，缺少以下来源：`r`n - " + ($missing -join "`r`n - "))
  }

  # ── 3/5 白名单装配到同盘临时目录 ──
  Write-Host "[3/5] 装配到临时目录：$staging"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  foreach ($dir in $whitelistDirs) {
    Copy-Item -LiteralPath (Join-Path $Root $dir) -Destination (Join-Path $staging $dir) -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $staging '.next') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root '.next\standalone') -Destination (Join-Path $staging '.next\standalone') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $Root 'scripts') -Destination (Join-Path $staging 'scripts') -Recurse -Force
  foreach ($file in $whitelistFiles) {
    Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $staging $file) -Force
  }
  foreach ($map in $templateMap) {
    Copy-Item -LiteralPath (Join-Path $Root $map.Source) -Destination (Join-Path $staging $map.Target) -Force
  }

  # 装配后硬断言：成品不得夹带本机状态或开发产物
  foreach ($forbidden in $forbiddenInPayload) {
    if (Test-Path -LiteralPath (Join-Path $staging $forbidden)) {
      throw "装配结果包含禁止路径：$forbidden"
    }
  }

  # ── 4/5 生成 portable-manifest.json（相对路径、大小、SHA-256；不含密钥值）──
  Write-Host '[4/5] 生成 portable-manifest.json...'
  $files = foreach ($rel in $manifestKeyFiles) {
    $abs = Join-Path $staging ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs)) { throw "关键文件缺失，不发布：$rel" }
    [ordered]@{
      path   = $rel
      size   = (Get-Item -LiteralPath $abs).Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $abs).Hash.ToLowerInvariant()
    }
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    mode          = 'windows-portable-v1'
    files         = @($files)
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 4) + "`r`n"
  [System.IO.File]::WriteAllText(
    (Join-Path $staging 'portable-manifest.json'),
    $manifestJson,
    (New-Object System.Text.UTF8Encoding $false)
  )

  # ── 5/5 改名发布（同盘原子移动；目标已存在已在开头拒绝）──
  Move-Item -LiteralPath $staging -Destination $OutputPath
  Write-Host "[5/5] 免安装包已发布：$OutputPath" -ForegroundColor Green
  Write-Host '后续：把该目录整体复制到共享盘新版本目录，再用 portable-manifest.json 复核关键文件完整性。'
} catch {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host "装配失败：$_" -ForegroundColor Red
  exit 1
}
