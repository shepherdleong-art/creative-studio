param(
  [string]$NodeVersion = '22.22.3',
  [string]$InnoSetupCompiler = '',
  [switch]$SkipNpmCi,
  [string]$LiteLLMRuntimeDir = '',
  [switch]$SkipLiteLLMSidecarBuild,
  [string]$NodeRuntimeSha256 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33',
  [string]$PythonEmbeddableSha256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3',
  [string]$PipWheelSha256 = '382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$DistRoot = Join-Path $Root 'dist\windows'
$AppDir = Join-Path $DistRoot 'CreativeStudio'
$CacheDir = Join-Path $Root '.cache\windows-installer'
$NodeName = "node-v$NodeVersion-win-x64"
$NodeZip = Join-Path $CacheDir "$NodeName.zip"
$NodeExtracted = Join-Path $CacheDir $NodeName
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeName.zip"
$LiteLLMVersion = '1.89.2'
$LiteLLMCacheDir = Join-Path $CacheDir 'litellm'
$LiteLLMDefaultRuntimeDir = Join-Path $LiteLLMCacheDir 'runtime-litellm'
$IssPath = Join-Path $Root 'installer\windows\CreativeStudio.iss'

function Copy-DirectoryContent {
  param(
    [string]$Source,
    [string]$Destination
  )
  if (-not (Test-Path $Source)) {
    throw "Missing required path: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

function Resolve-InnoCompiler {
  param([string]$ExplicitPath)
  if ($ExplicitPath) {
    if (-not (Test-Path $ExplicitPath)) {
      throw "Inno Setup compiler was not found: $ExplicitPath"
    }
    return $ExplicitPath
  }

  $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  throw 'Inno Setup 6 compiler was not found. Install it from https://jrsoftware.org/isinfo.php or pass -InnoSetupCompiler.'
}

function Remove-PayloadPath {
  param([string]$RelativePath)
  $target = Join-Path $AppDir $RelativePath
  $resolvedApp = [System.IO.Path]::GetFullPath($AppDir)
  $resolvedTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($resolvedApp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prune outside installer payload: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force -ErrorAction SilentlyContinue
}

Set-Location $Root

$HostNodeMajor = (& node.exe -p "process.versions.node.split('.')[0]").Trim()
$HostNodePlatform = (& node.exe -p 'process.platform').Trim()
$HostNodeArch = (& node.exe -p 'process.arch').Trim()
if ($HostNodeMajor -ne '22') {
  throw "Creative Studio Windows packaging requires Node 22.x on the build host; detected major version $HostNodeMajor."
}
if ($HostNodePlatform -ne 'win32') {
  throw "Creative Studio Windows packaging must run on Windows; detected $HostNodePlatform."
}
if ($HostNodeArch -ne 'x64') {
  throw "Creative Studio Windows packaging requires an x64 Node build host; detected $HostNodeArch. Native modules must match the bundled win-x64 runtime."
}

if ($SkipNpmCi) {
  Write-Host 'Skipping npm ci because -SkipNpmCi was provided.'
} else {
  Write-Host 'Installing npm dependencies...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Turbopack/NFT must never see a previous assembled payload. Otherwise broad
# runtime file patterns can recursively trace dist/windows/CreativeStudio back
# into the next standalone output.
if (Test-Path -LiteralPath $AppDir) {
  Remove-Item -LiteralPath $AppDir -Recurse -Force
}
Remove-Item -LiteralPath (Join-Path $Root '.next\dev') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Building Next.js standalone app...'
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $CacheDir, $DistRoot | Out-Null

if (-not $LiteLLMRuntimeDir) { $LiteLLMRuntimeDir = $LiteLLMDefaultRuntimeDir }
$LiteLLMRuntimeDir = [IO.Path]::GetFullPath($LiteLLMRuntimeDir)
if (-not $SkipLiteLLMSidecarBuild) {
  $sidecarBuilder = Join-Path $Root 'scripts\build-litellm-sidecar.ps1'
  if (-not (Test-Path -LiteralPath $sidecarBuilder)) { throw "Missing LiteLLM sidecar builder: $sidecarBuilder" }
  Write-Host "Building private LiteLLM $LiteLLMVersion runtime..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sidecarBuilder -LiteLLMVersion $LiteLLMVersion -CacheRoot $LiteLLMCacheDir -OutputRoot $LiteLLMRuntimeDir -PythonEmbeddableSha256 $PythonEmbeddableSha256 -PipWheelSha256 $PipWheelSha256
  if ($LASTEXITCODE -ne 0) { throw "LiteLLM sidecar build failed with exit code $LASTEXITCODE; installer assembly aborted." }
} else {
  Write-Host 'Skipping LiteLLM sidecar build; a previously validated runtime is required.' -ForegroundColor Yellow
}

$requiredSidecarFiles = @(
  'python.exe',
  'python312._pth',
  'manifest.json',
  'Lib\site-packages\litellm'
)
foreach ($relativePath in $requiredSidecarFiles) {
  $sidecarPath = Join-Path $LiteLLMRuntimeDir $relativePath
  if (-not (Test-Path -LiteralPath $sidecarPath)) { throw "LiteLLM runtime is incomplete; missing $sidecarPath" }
}
$sidecarManifest = Get-Content -LiteralPath (Join-Path $LiteLLMRuntimeDir 'manifest.json') -Raw | ConvertFrom-Json
if ($sidecarManifest.litellmVersion -ne $LiteLLMVersion -or $sidecarManifest.architecture -ne 'x64') {
  throw "LiteLLM runtime manifest does not match pinned $LiteLLMVersion x64 runtime."
}

if (-not (Test-Path $NodeZip)) {
  Write-Host "Downloading private Node.js runtime: $NodeUrl"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}
$actualNodeRuntimeSha256 = (Get-FileHash -LiteralPath $NodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeRuntimeSha256 -ne $NodeRuntimeSha256.Trim().ToLowerInvariant()) {
  throw "Node.js runtime SHA-256 mismatch. Expected $NodeRuntimeSha256, received $actualNodeRuntimeSha256."
}

if (-not (Test-Path $NodeExtracted)) {
  Write-Host 'Extracting Node.js runtime...'
  Expand-Archive -LiteralPath $NodeZip -DestinationPath $CacheDir -Force
}

if (Test-Path $AppDir) {
  Remove-Item -LiteralPath $AppDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

Write-Host 'Assembling installer payload...'
Copy-DirectoryContent -Source (Join-Path $Root '.next\standalone') -Destination $AppDir
foreach ($relativePath in @(
  'data',
  'storage',
  'outputs',
  'dist',
  '.cache',
  'provisioning',
  'installer',
  'docs',
  'scripts',
  '.claude',
  '.git',
  '.next\cache',
  '.next\dev',
  'node_modules\.cache',
  'tsconfig.tsbuildinfo',
  'package-lock.json',
  'eslint.config.mjs',
  'postcss.config.mjs',
  'create-desktop-shortcut.cmd',
  'create-desktop-shortcut.ps1',
  'start-windows.cmd',
  'stop-windows.cmd',
  'start.command',
  'stop.command',
  'start.sh',
  'stop.sh',
  'launcher.vbs',
  'video-panel-mockup.html',
  'config.yaml',
  'litellm-config.yaml',
  'data\provisioning',
  'runtime.env'
)) {
  Remove-PayloadPath -RelativePath $relativePath
}
Get-ChildItem -LiteralPath $AppDir -Recurse -Force -File -Filter '.env*' -ErrorAction SilentlyContinue | Remove-Item -Force

$forbiddenPayload = @('data', 'storage', 'outputs', 'dist', '.cache', 'provisioning', '.env.local', 'config.yaml', 'litellm-config.yaml', 'data\provisioning', 'runtime.env')
foreach ($relativePath in $forbiddenPayload) {
  $target = Join-Path $AppDir $relativePath
  if (Test-Path $target) {
    throw "Installer payload still contains forbidden local data path: $target"
  }
}

$requiredRuntimeFiles = @(
  'node_modules\ffmpeg-static\ffmpeg.exe',
  'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe',
  'node_modules\@img\sharp-win32-x64\lib\libvips-42.dll',
  'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
)
foreach ($relativePath in $requiredRuntimeFiles) {
  $target = Join-Path $AppDir $relativePath
  if (-not (Test-Path $target)) {
    throw "Installer payload missing required runtime file: $target"
  }
}

$sharpRuntimeDir = Join-Path $AppDir 'node_modules\@img\sharp-win32-x64\lib'
$sharpNativeModules = @(Get-ChildItem -LiteralPath $sharpRuntimeDir -File -Filter 'sharp-win32-x64*.node' -ErrorAction SilentlyContinue)
$libvipsCppLibraries = @(Get-ChildItem -LiteralPath $sharpRuntimeDir -File -Filter 'libvips-cpp-*.dll' -ErrorAction SilentlyContinue)
if ($sharpNativeModules.Count -ne 1) {
  throw "Installer payload must contain exactly one Sharp win32-x64 native module under $sharpRuntimeDir."
}
if ($libvipsCppLibraries.Count -ne 1) {
  throw "Installer payload must contain exactly one versioned libvips C++ runtime under $sharpRuntimeDir."
}

Copy-DirectoryContent -Source (Join-Path $Root '.next\static') -Destination (Join-Path $AppDir '.next\static')
Copy-DirectoryContent -Source (Join-Path $Root 'public') -Destination (Join-Path $AppDir 'public')
Copy-DirectoryContent -Source $NodeExtracted -Destination (Join-Path $AppDir 'runtime')
Copy-DirectoryContent -Source $LiteLLMRuntimeDir -Destination (Join-Path $AppDir 'runtime-litellm')

$runtimeManifest = Join-Path $AppDir 'runtime-litellm\manifest.json'
if (-not (Test-Path -LiteralPath $runtimeManifest)) { throw "Installer payload missing LiteLLM manifest: $runtimeManifest" }
if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'runtime-litellm\Lib\site-packages\litellm'))) {
  throw 'Installer payload is missing vendored LiteLLM package.'
}

New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\stop-installed.ps1') -Destination (Join-Path $AppDir 'scripts\stop-installed.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\clear-user-data.ps1') -Destination (Join-Path $AppDir 'scripts\clear-user-data.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\start-installed.ps1') -Destination (Join-Path $AppDir 'scripts\start-installed.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\start-company-sidecar.ps1') -Destination (Join-Path $AppDir 'scripts\start-company-sidecar.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\stop-company-sidecar.ps1') -Destination (Join-Path $AppDir 'scripts\stop-company-sidecar.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'launcher.html') -Destination (Join-Path $AppDir 'launcher.html') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\README-INSTALLED.md') -Destination (Join-Path $AppDir 'README.md') -Force

$nativeRuntimeCheck = "const sharp=require('sharp');const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('SELECT 1').get();db.close();if(!sharp)process.exit(1);"
Push-Location $AppDir
try {
  & (Join-Path $AppDir 'runtime\node.exe') -e $nativeRuntimeCheck
  if ($LASTEXITCODE -ne 0) { throw 'Bundled sharp/better-sqlite3 native runtime self-check failed.' }
} finally {
  Pop-Location
}

$forbiddenConfigurationFiles = @(Get-ChildItem -LiteralPath $AppDir -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -like '*.provision' -or
  $_.Name -like 'company-profile*.json' -or
  $_.Name -like '.env*' -or
  $_.Name -in @('config.yaml', 'litellm-config.yaml', 'runtime.env')
})
if ($forbiddenConfigurationFiles.Count -gt 0) {
  $paths = ($forbiddenConfigurationFiles | ForEach-Object { $_.FullName }) -join ', '
  throw "Installer payload contains forbidden provisioning delivery files: $paths"
}

# ── Compile CreativeStudio.exe launcher ──
$cscCandidates = @(
  Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
)
$csc = $null
foreach ($candidate in $cscCandidates) {
  if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) {
  throw 'csc.exe (C# compiler) not found. .NET Framework 4.x is required.'
}
$launcherCs = Join-Path $Root 'installer\windows\launcher.cs'
$iconPath = Join-Path $Root 'app\favicon.ico'
$exeOut = Join-Path $AppDir 'CreativeStudio.exe'
Write-Host "Compiling CreativeStudio.exe from $launcherCs ..."
& $csc /nologo /target:winexe /optimize+ /win32icon:"$iconPath" /out:"$exeOut" "$launcherCs"
if ($LASTEXITCODE -ne 0) { throw 'csc.exe failed to compile launcher.cs' }
if (-not (Test-Path $exeOut)) { throw "CreativeStudio.exe was not produced at $exeOut" }
Write-Host 'CreativeStudio.exe compiled successfully.' -ForegroundColor Green

# ── Also copy EXE to project root for dev-mode testing ──
# Running CreativeStudio.exe from I:\creative-studio\ will use .next\standalone for the server
# and .cache\windows-installer for the node runtime (dev layout detection in launcher.cs).
$rootExe = Join-Path $Root 'CreativeStudio.exe'
Copy-Item -LiteralPath $exeOut -Destination $rootExe -Force
Write-Host "Dev copy: $rootExe" -ForegroundColor Cyan

$iscc = Resolve-InnoCompiler -ExplicitPath $InnoSetupCompiler
Write-Host "Compiling installer with Inno Setup: $iscc"
& $iscc $IssPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host "Installer created: $(Join-Path $DistRoot 'CreativeStudioSetup.exe')" -ForegroundColor Green
