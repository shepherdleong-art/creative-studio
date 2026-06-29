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
  $target = Join-Path $AppDir $RelativePath
  $resolvedApp = [System.IO.Path]::GetFullPath($AppDir)
  $resolvedTarget = [System.IO.Path]::GetFullPath($target)
  if (-not $resolvedTarget.StartsWith($resolvedApp, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prune outside installer payload: $resolvedTarget"
  }
  Remove-Item -LiteralPath $resolvedTarget -Recurse -Force -ErrorAction SilentlyContinue
}

Set-Location $Root

if ($SkipNpmCi) {
  Write-Host 'Skipping npm ci because -SkipNpmCi was provided.'
} else {
  Write-Host 'Installing npm dependencies...'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Remove-Item -LiteralPath (Join-Path $Root '.next\dev') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host 'Building Next.js standalone app...'
& npm.cmd run build
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

Write-Host 'Assembling installer payload...'
Copy-DirectoryContent -Source (Join-Path $Root '.next\standalone') -Destination $AppDir
foreach ($relativePath in @(
  'data',
  'storage',
  'outputs',
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
  'video-panel-mockup.html'
)) {
  Remove-PayloadPath -RelativePath $relativePath
}
Get-ChildItem -LiteralPath $AppDir -Force -Filter '.env*' | Remove-Item -Recurse -Force

$forbiddenPayload = @('data', 'storage', 'outputs', '.env.local')
foreach ($relativePath in $forbiddenPayload) {
  $target = Join-Path $AppDir $relativePath
  if (Test-Path $target) {
    throw "Installer payload still contains forbidden local data path: $target"
  }
}

Copy-DirectoryContent -Source (Join-Path $Root '.next\static') -Destination (Join-Path $AppDir '.next\static')
Copy-DirectoryContent -Source (Join-Path $Root 'public') -Destination (Join-Path $AppDir 'public')
Copy-DirectoryContent -Source $NodeExtracted -Destination (Join-Path $AppDir 'runtime')

New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\stop-installed.ps1') -Destination (Join-Path $AppDir 'scripts\stop-installed.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'installer\windows\clear-user-data.ps1') -Destination (Join-Path $AppDir 'scripts\clear-user-data.ps1') -Force
Copy-Item -LiteralPath (Join-Path $Root 'launcher.html') -Destination (Join-Path $AppDir 'launcher.html') -Force
Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination (Join-Path $AppDir 'README.md') -Force

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
