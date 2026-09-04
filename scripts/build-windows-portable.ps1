#Requires -Version 5.1
<#
.SYNOPSIS
  装配 Windows 免安装包（创意工作台 portable 分发目录）。
.DESCRIPTION
  仅供维护者在本机仓库执行，终端用户不运行本脚本。
  - 正式运行时固定在 Windows x64 + Node 22 上执行 npm ci，再重建 Next standalone 与 Electron 桌面壳。
  - 只从显式白名单装配 runtime、standalone、桌面壳、运行时脚本、公司配置、
    启停/迁移入口、许可证、自检与使用说明；本机数据和开发脚本不进成品。
  - config.yaml / .env.local 仅在本机做字段白名单和密钥泄漏扫描，绝不打印值。
  - 在同盘临时目录完成装配、扫描与 manifest 生成后改名发布，拒绝覆盖旧目录。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-portable.ps1 -OutputPath D:\release\创意工作台-0.6.0-免安装版
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  # 仅供临时 fixture 测试；正式发布不得传此参数。
  [switch]$SkipBuild
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
  throw "目标目录已存在，拒绝覆盖：$OutputPath。免安装包每次发布必须装配到全新目录。"
}
$outputParent = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $outputParent)) {
  New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
}
$staging = Join-Path $outputParent ('.portable-staging-{0}' -f [guid]::NewGuid().ToString('N'))

$packageMetadata = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appVersion = [string]$packageMetadata.version
$sourceCommit = 'unknown'
try {
  $sourceCommitCandidate = (& git.exe -C $Root rev-parse HEAD 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -eq 0 -and $sourceCommitCandidate) { $sourceCommit = [string]$sourceCommitCandidate }
} catch {}

function Get-Sha256Hex([string]$FilePath) {
  $stream = [System.IO.File]::OpenRead($FilePath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Get-NodeRuntimeInfo([string]$NodePath) {
  $json = & $NodePath -p "JSON.stringify({node:process.versions.node,modules:process.versions.modules,platform:process.platform,arch:process.arch})"
  if ($LASTEXITCODE -ne 0 -or -not $json) {
    throw "无法读取 Node 运行时信息：$NodePath"
  }
  try {
    return ($json | ConvertFrom-Json)
  } catch {
    throw "Node 运行时信息格式无效：$NodePath"
  }
}

# ── 显式白名单（除此之外一律不进免安装包）──
$whitelistDirs = @(
  'node-runtime',
  'python-runtime',
  'node_modules'
)
$whitelistFiles = @(
  'package.json',
  'config.yaml',
  '.env.local',
  'LICENSE',
  'stop-windows.cmd',
  '环境自检.cmd'
)
$runtimeScriptFiles = @(
  'start-desktop-windows.ps1',
  'start-stack.ps1',
  'stop-stack.ps1',
  'stop-windows.ps1',
  'start-litellm-proxy.py',
  'diagnose-local-env.mjs',
  'migrate-portable-data.ps1',
  'migrate-portable-data.mjs'
)
$desktopPayloadFiles = @(
  'main.js',
  'preload.js',
  'service.js',
  'ipc.js'
)
$templateMap = @(
  @{ Source = 'installer\windows\start-windows-portable.cmd'; Target = 'start-windows.cmd' },
  @{ Source = 'installer\windows\迁移旧版数据.cmd';           Target = '迁移旧版数据.cmd' },
  @{ Source = 'installer\windows\使用说明-portable.txt';      Target = '使用说明.txt' }
)

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
  '.env.local',
  'dist-desktop/main.js',
  'dist-desktop/preload.js',
  'dist-desktop/service.js',
  'dist-desktop/ipc.js',
  'package.json',
  'LICENSE',
  'scripts/stop-stack.ps1',
  'scripts/stop-windows.ps1',
  'scripts/migrate-portable-data.ps1',
  'scripts/migrate-portable-data.mjs',
  'scripts/diagnose-local-env.mjs',
  'start-windows.cmd',
  'stop-windows.cmd',
  '迁移旧版数据.cmd',
  '环境自检.cmd'
)

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
  # ── 1/8 干净依赖与 Node ABI 硬校验 ──
  if (-not $SkipBuild) {
    Write-Host '[1/8] 校验 Windows x64 / Node 22，并从 package-lock 干净安装依赖...'
    $hostNode = (Get-Command node.exe -ErrorAction Stop).Source
    $hostInfo = Get-NodeRuntimeInfo $hostNode
    $hostMajor = ([string]$hostInfo.node).Split('.')[0]
    if ($hostMajor -ne '22' -or $hostInfo.platform -ne 'win32' -or $hostInfo.arch -ne 'x64') {
      throw "正式装配要求 Windows x64 + Node 22；当前为 $($hostInfo.platform)/$($hostInfo.arch) Node $($hostInfo.node)。"
    }

    & npm.cmd ci --include=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败，停止装配。' }

    $electronBinary = Join-Path $Root 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electronBinary -PathType Leaf)) {
      Write-Host 'npm ci 未下载 Electron runtime，执行官方安装脚本...'
      & $hostNode (Join-Path $Root 'node_modules\electron\install.js')
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $electronBinary -PathType Leaf)) {
        throw 'Electron runtime 安装失败，停止装配。'
      }
    }

    $bundledNode = Join-Path $Root 'node-runtime\node.exe'
    if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf)) {
      throw '缺少 node-runtime\node.exe，停止装配。'
    }
    $bundledInfo = Get-NodeRuntimeInfo $bundledNode
    $bundledMajor = ([string]$bundledInfo.node).Split('.')[0]
    if (
      $bundledMajor -ne '22' -or
      $bundledInfo.modules -ne '127' -or
      $bundledInfo.platform -ne 'win32' -or
      $bundledInfo.arch -ne 'x64'
    ) {
      throw "包内 Node 必须是 win32/x64 Node 22 ABI 127；当前为 $($bundledInfo.platform)/$($bundledInfo.arch) Node $($bundledInfo.node) ABI $($bundledInfo.modules)。"
    }
    & $bundledNode -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); require('sharp')"
    if ($LASTEXITCODE -ne 0) {
      throw '包内 Node 无法加载 npm ci 生成的 better-sqlite3/sharp 原生模块，停止装配。'
    }
  } else {
    Write-Host '[1/8] fixture 模式：已显式跳过 npm ci、Node ABI 校验与构建。' -ForegroundColor Yellow
  }

  # ── 2/8 重新生成与当前源码一致的产物 ──
  if (-not $SkipBuild) {
    Write-Host '[2/8] 重新构建 Next standalone 与 Electron 桌面壳...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Next standalone 构建失败，停止装配。' }
    & npm.cmd run build:desktop
    if ($LASTEXITCODE -ne 0) { throw 'Electron 桌面壳编译失败，停止装配。' }
  } else {
    Write-Host '[2/8] fixture 模式：已显式跳过构建。' -ForegroundColor Yellow
  }

  # ── 3/8 python-runtime 只读验收 ──
  Write-Host '[3/8] 验收 python-runtime...'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir 'verify-python-runtime-windows.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'python-runtime 验收失败，停止装配。' }

  # ── 4/8 payload 前置检查 ──
  Write-Host '[4/8] payload 前置检查...'
  $requiredSources = @(
    '.next\standalone',
    'scripts\verify-portable-payload.mjs',
    'node-runtime\node.exe',
    'python-runtime\python.exe',
    'python-runtime\runtime-manifest.json',
    'node_modules\.bin\electron.cmd',
    'node_modules\electron\dist\electron.exe',
    '.next\standalone\server.js',
    '.next\standalone\runtime\server-entry.js',
    'dist-desktop\main.js',
    'dist-desktop\preload.js',
    'dist-desktop\service.js',
    'dist-desktop\ipc.js'
  ) + $whitelistDirs + $whitelistFiles + @($runtimeScriptFiles | ForEach-Object { "scripts\$_" }) + @($desktopPayloadFiles | ForEach-Object { "dist-desktop\$_" }) + @($templateMap | ForEach-Object { $_.Source })
  $missing = @($requiredSources | Sort-Object -Unique | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) })
  if ($missing.Count -gt 0) {
    throw ("payload 前置检查失败，缺少以下来源：`r`n - " + ($missing -join "`r`n - "))
  }

  # ── 5/8 白名单装配 ──
  Write-Host "[5/8] 装配到临时目录：$staging"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  foreach ($dir in $whitelistDirs) {
    Copy-Item -LiteralPath (Join-Path $Root $dir) -Destination (Join-Path $staging $dir) -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $staging 'dist-desktop') | Out-Null
  foreach ($desktopFile in $desktopPayloadFiles) {
    Copy-Item -LiteralPath (Join-Path $Root "dist-desktop\$desktopFile") -Destination (Join-Path $staging "dist-desktop\$desktopFile") -Force
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $staging '.next') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Root '.next\standalone') -Destination (Join-Path $staging '.next\standalone') -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $staging 'scripts') | Out-Null
  foreach ($scriptName in $runtimeScriptFiles) {
    Copy-Item -LiteralPath (Join-Path $Root "scripts\$scriptName") -Destination (Join-Path $staging "scripts\$scriptName") -Force
  }
  foreach ($file in $whitelistFiles) {
    Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $staging $file) -Force
  }
  # 当前开发密钥文件允许用 Markdown 围栏包住 dotenv 段。成品中只删除独占一行的
  # ``` / ```env / ```dotenv 标记，其余每个字节均保留；全程不向控制台输出内容。
  $stagedEnvPath = Join-Path $staging '.env.local'
  $stagedEnvLines = [System.IO.File]::ReadAllLines($stagedEnvPath)
  $normalizedEnvLines = @($stagedEnvLines | Where-Object { $_.Trim() -notmatch '^```(?:env|dotenv)?$' })
  [System.IO.File]::WriteAllLines($stagedEnvPath, $normalizedEnvLines, [System.Text.UTF8Encoding]::new($false))
  foreach ($map in $templateMap) {
    Copy-Item -LiteralPath (Join-Path $Root $map.Source) -Destination (Join-Path $staging $map.Target) -Force
  }

  foreach ($forbidden in $forbiddenInPayload) {
    if (Test-Path -LiteralPath (Join-Path $staging $forbidden)) {
      throw "装配结果包含禁止路径：$forbidden"
    }
  }

  # ── 6/8 递归敏感边界扫描 ──
  Write-Host '[6/8] 扫描 payload 边界与敏感值泄漏...'
  $validationNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $validationNode) { $validationNode = Join-Path $Root 'node-runtime\node.exe' }
  & $validationNode (Join-Path $ScriptDir 'verify-portable-payload.mjs') --payload $staging
  if ($LASTEXITCODE -ne 0) { throw 'payload 安全扫描失败，停止发布。' }

  # ── 7/8 生成 portable-manifest.json ──
  Write-Host '[7/8] 生成 portable-manifest.json...'
  $files = foreach ($rel in $manifestKeyFiles) {
    $abs = Join-Path $staging ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs)) { throw "关键文件缺失，不发布：$rel" }
    [ordered]@{
      path   = $rel
      size   = (Get-Item -LiteralPath $abs).Length
      sha256 = Get-Sha256Hex $abs
    }
  }
  $manifest = [ordered]@{
    schemaVersion = 1
    mode          = 'windows-portable-v1'
    appVersion    = $appVersion
    builtAt       = [DateTime]::UtcNow.ToString('o')
    sourceCommit  = $sourceCommit
    files         = @($files)
  }
  $manifestJson = ($manifest | ConvertTo-Json -Depth 4) + "`r`n"
  [System.IO.File]::WriteAllText(
    (Join-Path $staging 'portable-manifest.json'),
    $manifestJson,
    (New-Object System.Text.UTF8Encoding $false)
  )

  # ── 8/8 同盘改名发布 ──
  Move-Item -LiteralPath $staging -Destination $OutputPath
  Write-Host "[8/8] 免安装包已发布：$OutputPath" -ForegroundColor Green
  Write-Host '主包不要启动；请只从复制出的 QA 目录验收。'
} catch {
  if (Test-Path -LiteralPath $staging) {
    $resolvedStaging = [System.IO.Path]::GetFullPath($staging)
    $resolvedParent = [System.IO.Path]::GetFullPath($outputParent).TrimEnd('\') + '\'
    if ($resolvedStaging.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStaging).StartsWith('.portable-staging-')) {
      Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Host "装配失败：$_" -ForegroundColor Red
  exit 1
}
