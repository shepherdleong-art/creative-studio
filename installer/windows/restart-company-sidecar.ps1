[CmdletBinding()]
param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = [IO.Path]::GetFullPath($Root)
$StartScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\start-company-sidecar.ps1'))
$LogPath = Join-Path $Root 'storage\logs\litellm.err.log'
$script:exitCode = 1

function Write-SafeDiagnostic {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    Add-Content -LiteralPath $LogPath -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
  } catch { }
}

try {
  if (-not (Test-Path -LiteralPath $StartScript)) {
    Write-SafeDiagnostic 'LiteLLM restart controller could not find the bundled start controller.'
  } else {
    # The start controller owns the single start lock and keeps it held while
    # validating, stopping, starting, and health-checking the sidecar. The
    # same strict ownership checks used by stop-company-sidecar.ps1 run inside start.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StartScript -Root $Root -ForceRestart
    $script:exitCode = [int]$LASTEXITCODE
  }
} catch {
  Write-SafeDiagnostic 'LiteLLM restart controller failed closed.'
  $script:exitCode = 1
}

exit $script:exitCode
