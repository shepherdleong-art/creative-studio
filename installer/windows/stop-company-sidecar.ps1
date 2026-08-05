param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = [IO.Path]::GetFullPath($Root)
$PythonExe = [IO.Path]::GetFullPath((Join-Path $Root 'runtime-litellm\python.exe'))
$ConfigPath = [IO.Path]::GetFullPath((Join-Path $Root 'config.yaml'))
$StackPath = Join-Path $Root 'storage\run\stack.json'

function Read-Stack {
  if (-not (Test-Path -LiteralPath $StackPath)) { return $null }
  try { return Get-Content -LiteralPath $StackPath -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-ProcessRecord {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-OwnedLiteLLMProcess {
  param($ProcessRecord)
  if (-not $ProcessRecord) { return $false }
  try {
    $executable = [IO.Path]::GetFullPath([string]$ProcessRecord.ExecutablePath)
  } catch { return $false }
  if (-not $executable.Equals($PythonExe, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $commandLine = [string]$ProcessRecord.CommandLine
  return $commandLine.IndexOf('litellm.proxy.proxy_cli', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf('--config', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf('--host 127.0.0.1', [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$stack = Read-Stack
if (-not $stack -or [string]$stack.sidecarKind -ne 'company-litellm') { exit 0 }
$processId = 0
[void][int]::TryParse([string]$stack.litellmPid, [ref]$processId)
$record = Get-ProcessRecord -ProcessId $processId
if (Test-OwnedLiteLLMProcess -ProcessRecord $record) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-ProcessRecord -ProcessId $processId)) { break }
  }
  Write-Host "Stopped Creative Studio LiteLLM sidecar PID: $processId" -ForegroundColor Green
  Remove-Item -LiteralPath $StackPath -Force -ErrorAction SilentlyContinue
} elseif ($record) {
  Write-Host 'LiteLLM state did not match the bundled runtime and config; it was left untouched.' -ForegroundColor Yellow
} else {
  Remove-Item -LiteralPath $StackPath -Force -ErrorAction SilentlyContinue
}
