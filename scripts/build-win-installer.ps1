param(
  [string]$NodeVersion = '22.22.3',
  [string]$InnoSetupCompiler = '',
  [switch]$SkipNpmCi
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$DistRoot = Join-Path $Root 'dist\windows'
$AppDir = Join-Path $DistRoot 'CreativeStudio'
$Payload = Join-Path $AppDir 'resources\app'
$ElectronDist = Join-Path $Root 'node_modules\electron\dist'
$CacheDir = Join-Path $Root '.cache\windows-installer'
$NodeName = "node-v$NodeVersion-win-x64"
$NodeZip = Join-Path $CacheDir "$NodeName.zip"
$NodeExtracted = Join-Path $CacheDir $NodeName
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/$NodeName.zip"
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
  Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
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
  $target = Join-Path $Payload $RelativePath
  $resolvedPayload = [System.IO.Path]::GetFullPath($Payload)
  $resolvedTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($resolvedPayload + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
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
  if (-not (Test-Path (Join-Path $ElectronDist 'electron.exe'))) {
    Write-Host 'Electron runtime was not installed by npm ci; running Electron installer...'
    & node.exe (Join-Path $Root 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

if (-not (Test-Path (Join-Path $ElectronDist 'electron.exe'))) {
  throw "Electron runtime was not found at $ElectronDist. Run npm ci and the Electron installer on the Windows build host."
}

Remove-Item -LiteralPath (Join-Path $Root '.next\dev') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Building Next.js standalone app...'
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Building Electron main/preload payload...'
& npm.cmd run build:desktop
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $CacheDir, $DistRoot | Out-Null

if (-not (Test-Path $NodeZip)) {
  Write-Host "Downloading private Node.js runtime: $NodeUrl"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}

if (-not (Test-Path $NodeExtracted)) {
  Write-Host 'Extracting Node.js runtime...'
  Expand-Archive -LiteralPath $NodeZip -DestinationPath $CacheDir -Force
}

if (Test-Path $AppDir) {
  Remove-Item -LiteralPath $AppDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null

Write-Host 'Assembling Electron runtime...'
Copy-DirectoryContent -Source $ElectronDist -Destination $AppDir
$electronExe = Join-Path $AppDir 'electron.exe'
$productExe = Join-Path $AppDir 'CreativeStudio.exe'
if (-not (Test-Path $electronExe)) {
  throw "Electron runtime did not contain electron.exe: $electronExe"
}
Move-Item -LiteralPath $electronExe -Destination $productExe -Force
Remove-Item -LiteralPath (Join-Path $AppDir 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

Write-Host 'Assembling Electron app payload...'
New-Item -ItemType Directory -Force -Path $Payload | Out-Null
Copy-DirectoryContent -Source (Join-Path $Root '.next\standalone') -Destination (Join-Path $Payload '.next\standalone')
Copy-DirectoryContent -Source (Join-Path $Root '.next\static') -Destination (Join-Path $Payload '.next\static')
Copy-DirectoryContent -Source (Join-Path $Root 'public') -Destination (Join-Path $Payload 'public')
Copy-DirectoryContent -Source (Join-Path $Root 'dist-desktop') -Destination (Join-Path $Payload 'dist-desktop')
Copy-DirectoryContent -Source $NodeExtracted -Destination (Join-Path $Payload 'runtime')
$packageJson = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$payloadPackage = [ordered]@{
  name = $packageJson.name
  version = $packageJson.version
  private = $true
  main = 'dist-desktop/main.js'
}
$jsonEncoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  (Join-Path $Payload 'package.json'),
  (($payloadPackage | ConvertTo-Json -Depth 4) + [Environment]::NewLine),
  $jsonEncoding
)

Write-Host 'Pruning local-only and development paths from Electron payload...'
foreach ($relativePath in @(
  'data',
  'storage',
  'outputs',
  'installer',
  'docs',
  'scripts',
  'desktop',
  '.claude',
  '.git',
  '.venv-litellm',
  'python-runtime',
  'config.yaml',
  'litellm-config.yaml',
  'requirements-litellm.txt',
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
  'start-desktop.command',
  'stop.command',
  'stop-desktop.command',
  'start.sh',
  'stop.sh',
  'launcher.vbs',
  'launcher.html',
  'video-panel-mockup.html'
)) {
  Remove-PayloadPath -RelativePath $relativePath
}

foreach ($relativePath in @(
  'data',
  'storage',
  'outputs',
  'installer',
  'docs',
  'scripts',
  'desktop',
  '.claude',
  '.git',
  '.venv-litellm',
  'python-runtime',
  'config.yaml',
  'litellm-config.yaml'
)) {
  Remove-PayloadPath -RelativePath (Join-Path '.next\standalone' $relativePath)
}
Get-ChildItem -LiteralPath $Payload -Force -Recurse -Filter '.env*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
if (Get-ChildItem -LiteralPath $Payload -Force -Recurse -Filter '.env*' -ErrorAction SilentlyContinue) {
  throw "Installer payload still contains environment files under $Payload."
}
Get-ChildItem -LiteralPath (Join-Path $Payload 'dist-desktop') -Force -Recurse -File -Include '*.map', '*.ts', '*.tsx' -ErrorAction SilentlyContinue | Remove-Item -Force
if (Get-ChildItem -LiteralPath (Join-Path $Payload 'dist-desktop') -Force -Recurse -File -Include '*.map', '*.ts', '*.tsx' -ErrorAction SilentlyContinue) {
  throw "Installer payload contains desktop source or sourcemap files under $(Join-Path $Payload 'dist-desktop')."
}

$forbiddenPayload = @('data', 'storage', 'outputs', 'docs', 'scripts', 'installer', '.git', '.claude', '.env.local', '.venv-litellm', 'python-runtime', 'config.yaml', 'litellm-config.yaml')
foreach ($relativePath in $forbiddenPayload) {
  $targets = @(
    Join-Path $Payload $relativePath
    Join-Path $Payload (Join-Path '.next\standalone' $relativePath)
  )
  foreach ($target in $targets) {
    if (Test-Path $target) {
      throw "Installer payload still contains forbidden local or development path: $target"
    }
  }
}
if (Test-Path (Join-Path $Payload 'desktop')) {
  throw "Installer payload still contains desktop shell source: $(Join-Path $Payload 'desktop')"
}
if (Test-Path (Join-Path $Payload '.next\standalone\desktop')) {
  throw "Standalone payload still contains desktop shell source: $(Join-Path $Payload '.next\standalone\desktop')"
}

$ffmpegBinaries = @(
  'node_modules\ffmpeg-static\ffmpeg.exe',
  'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe'
)
foreach ($relativePath in $ffmpegBinaries) {
  $target = Join-Path (Join-Path $Payload '.next\standalone') $relativePath
  if (-not (Test-Path $target)) {
    throw "Installer payload missing bundled ffmpeg binary: $target"
  }
}

$runtimeNode = Join-Path $Payload 'runtime\node.exe'
if (-not (Test-Path $runtimeNode)) {
  throw "Installer payload missing private Node runtime: $runtimeNode"
}
$runtimeNodeVersion = (& $runtimeNode -p "process.versions.node.split('.')[0]").Trim()
if ($runtimeNodeVersion -ne '22') {
  throw "Installer payload private Node runtime is not Node 22.x: $runtimeNodeVersion"
}

New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\stop-installed.ps1') -Destination (Join-Path $AppDir 'scripts\stop-installed.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\clear-user-data.ps1') -Destination (Join-Path $AppDir 'scripts\clear-user-data.ps1') -Force

if (-not (Test-Path $productExe)) {
  throw "Electron executable was not produced at $productExe"
}
Write-Host 'Electron application runtime assembled successfully.' -ForegroundColor Green

$iscc = Resolve-InnoCompiler -ExplicitPath $InnoSetupCompiler
Write-Host "Compiling installer with Inno Setup: $iscc"
& $iscc $IssPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host "Installer created: $(Join-Path $DistRoot 'CreativeStudioSetup.exe')" -ForegroundColor Green
