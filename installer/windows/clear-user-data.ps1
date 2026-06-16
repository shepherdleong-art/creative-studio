param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Targets = @(
  (Join-Path $Root 'data'),
  (Join-Path $Root 'storage'),
  (Join-Path $Root '.env.local')
)

Write-Host 'This will permanently delete Creative Studio user data from:'
foreach ($target in $Targets) {
  Write-Host "  $target"
}
Write-Host ''

if (-not $Force) {
  $answer = Read-Host 'Type DELETE to continue'
  if ($answer -ne 'DELETE') {
    Write-Host 'Cancelled.'
    exit 0
  }
}

$stopScript = Join-Path $ScriptDir 'stop-installed.ps1'
if (Test-Path $stopScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
}

foreach ($target in $Targets) {
  if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Deleted: $target" -ForegroundColor Green
  }
}

Write-Host 'Creative Studio user data has been deleted.'
