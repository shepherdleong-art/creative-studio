param(
  [string]$Root = '',
  [string]$ProxyPort = $(if ($env:CREATIVE_STUDIO_PROXY_PORT) { $env:CREATIVE_STUDIO_PROXY_PORT } else { '4000' })
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = [IO.Path]::GetFullPath($Root)
$proxyPortNumber = 0
if (-not [int]::TryParse($ProxyPort, [ref]$proxyPortNumber) -or $proxyPortNumber -lt 1 -or $proxyPortNumber -gt 65535) {
  throw "CREATIVE_STUDIO_PROXY_PORT must be an integer between 1 and 65535."
}

$ConfigPath = [IO.Path]::GetFullPath((Join-Path $Root 'config.yaml'))
$PythonExe = [IO.Path]::GetFullPath((Join-Path $Root 'runtime-litellm\python.exe'))
$RuntimeEnvPath = Join-Path $Root 'data\provisioning\runtime.env'
$ProvisioningStatePath = Join-Path $Root 'data\provisioning\state.json'
$LogDir = Join-Path $Root 'storage\logs'
$RunDir = Join-Path $Root 'storage\run'
$StdoutLog = Join-Path $LogDir 'litellm.out.log'
$StderrLog = Join-Path $LogDir 'litellm.err.log'
$StackPath = Join-Path $RunDir 'stack.json'
$StopScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\stop-company-sidecar.ps1'))
$RuntimeEnvMaxBytes = 128 * 1024
$RuntimeEnvValueMaxChars = 2048
$AllowedRuntimeEnvKeys = @(
  'CREATIVE_STUDIO_GATEWAY_API_KEY',
  'COMPANY_GATEWAY_API_KEY',
  'GATEWAY_API_KEY',
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
  'CREATIVE_STUDIO_COS_SIGN_HOST',
  'CREATIVE_STUDIO_COS_PREFIX',
  'CREATIVE_STUDIO_COS_URL_TTL_SEC'
)

function Write-SafeDiagnostic {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Add-Content -LiteralPath $StderrLog -Value "[$([DateTime]::Now.ToString('s'))] $Message" -Encoding UTF8
  } catch { }
}

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
  $executable = ''
  try { $executable = [IO.Path]::GetFullPath([string]$ProcessRecord.ExecutablePath) } catch { return $false }
  if (-not $executable.Equals($PythonExe, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $commandLine = [string]$ProcessRecord.CommandLine
  return $commandLine.IndexOf('litellm.proxy.proxy_cli', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf('--config', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf($ConfigPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $commandLine.IndexOf('--host 127.0.0.1', [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-PortOpen {
  try {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $proxyPortNumber)
    $client.Dispose()
    return $true
  } catch { return $false }
}

function Test-ProxyListenerOwnedByProcess {
  param([int]$ProcessId)
  try {
    $connection = Get-NetTCPConnection -LocalPort $proxyPortNumber -State Listen -ErrorAction Stop |
      Where-Object { [int]$_.OwningProcess -eq $ProcessId } |
      Select-Object -First 1
    return $null -ne $connection
  } catch {
    return $false
  }
}

function Read-RuntimeEnv {
  $values = @{}
  if (-not (Test-Path -LiteralPath $RuntimeEnvPath)) { return $values }
  $bytes = [IO.File]::ReadAllBytes($RuntimeEnvPath)
  if ($bytes.Length -gt $RuntimeEnvMaxBytes) {
    Write-SafeDiagnostic 'LiteLLM runtime.env is too large; no runtime variables were loaded.'
    return $values
  }
  try {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
  } catch {
    Write-SafeDiagnostic 'LiteLLM runtime.env is not valid UTF-8; no runtime variables were loaded.'
    return $values
  }
  foreach ($line in ($text -split "`r?`n")) {
    if (-not $line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
    if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { continue }
    $name = $Matches[1]
    if ($AllowedRuntimeEnvKeys -notcontains $name) { continue }
    $rawValue = $Matches[2]
    try {
      $value = $rawValue | ConvertFrom-Json -ErrorAction Stop
    } catch {
      continue
    }
    if ($value -isnot [string] -or $value.Length -gt $RuntimeEnvValueMaxChars) { continue }
    if ($value -match '[\x00-\x1F\x7F]') { continue }
    $values[$name] = [string]$value
  }
  return $values
}

function Test-ProvisionedConfigState {
  if (-not (Test-Path -LiteralPath $RuntimeEnvPath) -or -not (Test-Path -LiteralPath $ProvisioningStatePath)) {
    return $false
  }
  try {
    $stateBytes = [IO.File]::ReadAllBytes($ProvisioningStatePath)
    if ($stateBytes.Length -le 0 -or $stateBytes.Length -gt 16384) { return $false }
    $stateText = [Text.UTF8Encoding]::new($false, $true).GetString($stateBytes)
    $state = $stateText | ConvertFrom-Json -ErrorAction Stop
    $expectedHash = [string]$state.configHash
    if ([int]$state.schemaVersion -ne 1 -or $expectedHash -notmatch '^[a-fA-F0-9]{64}$') { return $false }
    $actualHash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash
    return $actualHash.Equals($expectedHash, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Write-Stack {
  param(
    [int]$ProcessId,
    [string]$StartedAt = ''
  )
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  $appPortValue = 3000
  $parsedAppPort = 0
  if ($env:CREATIVE_STUDIO_PORT -and [int]::TryParse($env:CREATIVE_STUDIO_PORT, [ref]$parsedAppPort) -and $parsedAppPort -ge 1 -and $parsedAppPort -le 65535) {
    $appPortValue = $parsedAppPort
  }
  if ($StartedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$') {
    $StartedAt = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
  }
  $state = [ordered]@{
    appPort = $appPortValue
    proxyPort = $proxyPortNumber
    litellmPid = $ProcessId
    startedAt = $StartedAt
    stopScript = $StopScript
    sidecarKind = 'company-litellm'
    runtimeRelativePath = 'runtime-litellm\python.exe'
    configRelativePath = 'config.yaml'
  }
  [IO.File]::WriteAllText($StackPath, ($state | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

function Remove-OwnedStack {
  $stack = Read-Stack
  if ($stack -and [string]$stack.sidecarKind -eq 'company-litellm') {
    Remove-Item -LiteralPath $StackPath -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path -LiteralPath $ConfigPath)) { exit 0 }
if (-not (Test-Path -LiteralPath $PythonExe)) {
  Write-SafeDiagnostic 'LiteLLM configuration exists but the bundled runtime is missing; the workbench will continue without the company sidecar.'
  exit 0
}
if (-not (Test-ProvisionedConfigState)) {
  Write-SafeDiagnostic 'LiteLLM provisioning state is missing or does not match config.yaml; the company sidecar was not started.'
  exit 0
}

$stack = Read-Stack
if ($stack -and [string]$stack.sidecarKind -eq 'company-litellm') {
  $existing = Get-ProcessRecord -ProcessId ([int]$stack.litellmPid)
  if (Test-OwnedLiteLLMProcess -ProcessRecord $existing) {
    Write-Stack -ProcessId ([int]$stack.litellmPid) -StartedAt ([string]$stack.startedAt)
    exit 0
  }
  Remove-OwnedStack
}

if (Test-PortOpen) {
  $listener = $null
  try {
    $connection = Get-NetTCPConnection -LocalPort $proxyPortNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { $listener = Get-ProcessRecord -ProcessId ([int]$connection.OwningProcess) }
  } catch { }
  if (Test-OwnedLiteLLMProcess -ProcessRecord $listener) {
    Write-Stack -ProcessId ([int]$listener.ProcessId)
    exit 0
  }
  Write-SafeDiagnostic "LiteLLM proxy port $proxyPortNumber is already occupied by another process; it was not stopped."
  exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null
$runtimeEnv = Read-RuntimeEnv
$environmentKeysToControl = @($AllowedRuntimeEnvKeys)
$previousEnvironment = @{}
foreach ($name in $environmentKeysToControl) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($runtimeEnv.ContainsKey($name)) {
    [Environment]::SetEnvironmentVariable($name, [string]$runtimeEnv[$name], 'Process')
  } else {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
}

$sidecarArguments = "-m litellm.proxy.proxy_cli --host 127.0.0.1 --port $proxyPortNumber --num_workers 1 --config `"$ConfigPath`" --telemetry false"
$process = $null
# Keep the proxy on the bundled model cost map: on networks where the remote cost-map
# URL is unreachable the fetch stalls startup and can exceed the health-check window.
$previousCostMapEnv = [Environment]::GetEnvironmentVariable('LITELLM_LOCAL_MODEL_COST_MAP', 'Process')
[Environment]::SetEnvironmentVariable('LITELLM_LOCAL_MODEL_COST_MAP', 'True', 'Process')
try {
  $process = Start-Process -FilePath $PythonExe -ArgumentList $sidecarArguments -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
} finally {
  [Environment]::SetEnvironmentVariable('LITELLM_LOCAL_MODEL_COST_MAP', $previousCostMapEnv, 'Process')
  foreach ($name in $environmentKeysToControl) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}
if (-not $process) { throw 'Unable to start the bundled LiteLLM runtime.' }
Write-Stack -ProcessId $process.Id

$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Seconds 1
  if ($process.HasExited) { break }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$proxyPortNumber/health/liveliness" -UseBasicParsing -TimeoutSec 2
    if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300 -and (Test-ProxyListenerOwnedByProcess -ProcessId $process.Id)) {
      $healthy = $true
      break
    }
  } catch { }
}

if (-not $healthy) {
  Write-SafeDiagnostic 'LiteLLM sidecar did not become healthy; the workbench will continue without it.'
  $record = Get-ProcessRecord -ProcessId $process.Id
  if (Test-OwnedLiteLLMProcess -ProcessRecord $record) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-OwnedStack
}
