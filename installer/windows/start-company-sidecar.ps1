[CmdletBinding()]
param(
  [string]$Root = '',
  [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = [IO.Path]::GetFullPath($Root)

$CanonicalRequestIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$inheritedRequestId = [Environment]::GetEnvironmentVariable('CREATIVE_STUDIO_SIDECAR_REQUEST_ID', 'Process')
if ($inheritedRequestId -is [string] -and $inheritedRequestId -cmatch $CanonicalRequestIdPattern) {
  $SidecarRequestId = $inheritedRequestId
} else {
  $SidecarRequestId = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
}

$ProxyPortNumber = 4000
$ConfigPath = [IO.Path]::GetFullPath((Join-Path $Root 'config.yaml'))
$PythonExe = [IO.Path]::GetFullPath((Join-Path $Root 'runtime-litellm\python.exe'))
$RuntimeEnvPath = Join-Path $Root 'data\provisioning\runtime.env'
$ProvisioningStatePath = Join-Path $Root 'data\provisioning\state.json'
$LogDir = Join-Path $Root 'storage\logs'
$RunDir = Join-Path $Root 'storage\run'
$StdoutLog = Join-Path $LogDir 'litellm.out.log'
$StderrLog = Join-Path $LogDir 'litellm.err.log'
$StackPath = Join-Path $RunDir 'stack.json'
$StatusPath = Join-Path $RunDir 'company-sidecar-status.json'
$StartLockPath = Join-Path $RunDir 'company-sidecar-start.lock'
$StopScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\stop-company-sidecar.ps1'))
$RuntimeEnvMaxBytes = 128 * 1024
$RuntimeEnvValueMaxChars = 2048
$StatusMaxBytes = 16 * 1024
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
$RequiredRuntimeEnvKeys = @(
  'CREATIVE_STUDIO_GATEWAY_API_KEY',
  'COMPANY_GATEWAY_API_KEY',
  'GATEWAY_API_KEY',
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN'
)
$script:terminalCode = $null
$script:lockStream = $null

function Write-SafeDiagnostic {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Add-Content -LiteralPath $StderrLog -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
  } catch { }
}

function Get-BytesSha256Hex {
  param([byte[]]$Bytes)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Write-AtomicUtf8Json {
  param([string]$Path, [object]$Value)
  $tempPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
  $backupPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).bak"
  $stream = $null
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $utf8 = [Text.UTF8Encoding]::new($false)
    $bytes = $utf8.GetBytes((($Value | ConvertTo-Json -Depth 8 -Compress) + "`n"))
    $stream = [IO.File]::Open($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    if ([IO.File]::Exists($Path)) {
      try {
        [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
      } catch { throw 'Atomic status replacement failed.' }
      try {
        if ([IO.File]::Exists($backupPath)) { [IO.File]::Delete($backupPath) }
      } catch { }
    } else {
      [IO.File]::Move($tempPath, $Path)
    }
    $tempPath = $null
  } finally {
    if ($null -ne $stream) { try { $stream.Dispose() } catch { } }
    if ($tempPath -and (Test-Path -LiteralPath $tempPath)) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
    if ($backupPath -and (Test-Path -LiteralPath $backupPath)) { Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue }
  }
}

function Write-SidecarStatus {
  param([string]$Status, [string]$Code)
  $record = [ordered]@{
    schemaVersion = 2
    requestId = $SidecarRequestId
    status = $Status
    code = $Code
    reason = $Code
    updatedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
  }
  Write-AtomicUtf8Json -Path $StatusPath -Value $record
}

function Read-Utf8Json {
  param([string]$Path, [int]$MaxBytes)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $MaxBytes) { return $null }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { return $null }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    return ($text | ConvertFrom-Json -ErrorAction Stop)
  } catch { return $null }
}

function Read-Stack {
  return Read-Utf8Json -Path $StackPath -MaxBytes $StatusMaxBytes
}

function Get-ProcessRecord {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Get-PinnedProcess {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $null }
  $process = $null
  try {
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    $null = $process.Handle
    return $process
  } catch {
    if ($null -ne $process) { try { $process.Dispose() } catch { } }
    return $null
  }
}

function Normalize-WindowsPath {
  param([string]$Value)
  try { return ([IO.Path]::GetFullPath($Value)).TrimEnd('\').ToLowerInvariant() } catch { return '' }
}

function Get-CommandTokens {
  param([string]$CommandLine)
  $tokens = @()
  foreach ($match in [regex]::Matches($CommandLine, '"([^"]*)"|([^\s]+)')) {
    if ($match.Groups[1].Success) { $tokens += $match.Groups[1].Value } else { $tokens += $match.Groups[2].Value }
  }
  return $tokens
}

function Test-TokenPair {
  param([string[]]$Tokens, [string]$Flag, [string]$Expected, [bool]$Normalize = $false)
  $found = $false
  for ($index = 0; $index -lt $Tokens.Count; $index++) {
    $token = [string]$Tokens[$index]
    if ([string]::Equals($token, $Flag, [StringComparison]::Ordinal)) {
      if ($found) { return $false }
      if ($index + 1 -ge $Tokens.Count) { return $false }
      $candidate = [string]$Tokens[$index + 1]
      $matchesExpected = $false
      if ($Normalize) {
        $matchesExpected = [string]::Equals((Normalize-WindowsPath $candidate), (Normalize-WindowsPath $Expected), [StringComparison]::OrdinalIgnoreCase)
      } else {
        $matchesExpected = [string]::Equals($candidate, $Expected, [StringComparison]::Ordinal)
      }
      if (-not $matchesExpected) { return $false }
      $found = $true
    }
  }
  return $found
}

function Test-OwnedLiteLLMProcess {
  param($ProcessRecord)
  if (-not $ProcessRecord) { return $false }
  $executable = Normalize-WindowsPath ([string]$ProcessRecord.ExecutablePath)
  if (-not $executable -or $executable -ne (Normalize-WindowsPath $PythonExe)) { return $false }
  $tokens = Get-CommandTokens -CommandLine ([string]$ProcessRecord.CommandLine)
  return (Test-TokenPair -Tokens $tokens -Flag '-m' -Expected 'litellm.proxy.proxy_cli') -and
    (Test-TokenPair -Tokens $tokens -Flag '--config' -Expected $ConfigPath -Normalize $true) -and
    (Test-TokenPair -Tokens $tokens -Flag '--host' -Expected '127.0.0.1') -and
    (Test-TokenPair -Tokens $tokens -Flag '--port' -Expected '4000')
}

function Get-ListenerRecords {
  try { return @(Get-NetTCPConnection -LocalPort $ProxyPortNumber -State Listen -ErrorAction Stop) } catch { return @() }
}

function Test-ProxyPortInUse {
  return ((Get-ListenerRecords).Count -gt 0)
}

function Test-ProxyListenerOwnedByProcess {
  param([int]$ProcessId)
  $listeners = @(Get-ListenerRecords)
  if ($listeners.Count -ne 1) { return $false }
  $listener = $listeners[0]
  return ([string]$listener.LocalAddress -ceq '127.0.0.1' -and [int]$listener.OwningProcess -eq $ProcessId)
}

function Read-ValidatedRuntimeEnv {
  if (-not (Test-Path -LiteralPath $RuntimeEnvPath)) { return $null }
  try {
    $bytes = [IO.File]::ReadAllBytes($RuntimeEnvPath)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $RuntimeEnvMaxBytes) { return $null }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { return $null }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    $values = @{}
    foreach ($line in ($text -split "`r?`n")) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
      if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { return $null }
      $name = $Matches[1]
      if ($AllowedRuntimeEnvKeys -cnotcontains $name -or $values.ContainsKey($name)) { return $null }
      $value = $Matches[2] | ConvertFrom-Json -ErrorAction Stop
      if ($value -isnot [string] -or $value.Length -gt $RuntimeEnvValueMaxChars -or $value -match '[\x00-\x1F\x7F]') { return $null }
      $values[$name] = [string]$value
    }
    foreach ($required in $RequiredRuntimeEnvKeys) {
      if (-not $values.ContainsKey($required) -or [string]::IsNullOrWhiteSpace([string]$values[$required])) { return $null }
    }
    return $values
  } catch {
    Write-SafeDiagnostic 'LiteLLM runtime.env failed strict UTF-8 or JSON validation.'
    return $null
  }
}

function Test-ExactProperties {
  param($Value, [string[]]$Expected)
  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Expected.Count) { return $false }
  foreach ($name in $Expected) {
    $found = $false
    foreach ($actualName in $actual) {
      if ([string]::Equals([string]$actualName, $name, [StringComparison]::Ordinal)) { $found = $true; break }
    }
    if (-not $found) { return $false }
  }
  return $true
}

function Test-StrictStringArray {
  param($Value, [int]$Minimum, [int]$Maximum)
  if ($Value -isnot [Array] -or $Value.Count -lt $Minimum -or $Value.Count -gt $Maximum) { return $false }
  $idPattern = [regex]::new('^[a-z0-9](?:[a-z0-9._-]{0,63})$', [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  for ($index = 0; $index -lt $Value.Count; $index++) {
    $item = $Value[$index]
    if ($item -isnot [string] -or -not $idPattern.IsMatch([string]$item)) { return $false }
    for ($other = 0; $other -lt $index; $other++) {
      if ([string]::Equals([string]$Value[$other], [string]$item, [StringComparison]::Ordinal)) { return $false }
    }
  }
  return $true
}

function Test-ProviderIds {
  param($Providers)
  if (-not (Test-ExactProperties -Value $Providers -Expected @('image', 'script', 'video', 'tts'))) { return $false }
  if (-not (Test-StrictStringArray -Value $Providers.image -Minimum 1 -Maximum 1)) { return $false }
  if (-not (Test-StrictStringArray -Value $Providers.script -Minimum 1 -Maximum 1)) { return $false }
  if (-not (Test-StrictStringArray -Value $Providers.video -Minimum 1 -Maximum 8)) { return $false }
  $ttsValid = $Providers.tts -is [Array] -and $Providers.tts.Count -eq 1 -and [string]::Equals([string]$Providers.tts[0], 'doubao-seed-tts-2', [StringComparison]::Ordinal)
  if (-not $ttsValid) { return $false }
  return $true
}

function Read-ValidatedProvisioningState {
  if (-not (Test-Path -LiteralPath $ConfigPath) -or -not (Test-Path -LiteralPath $ProvisioningStatePath)) { return $null }
  try {
    $configBytes = [IO.File]::ReadAllBytes($ConfigPath)
    if ($configBytes.Length -le 0 -or $configBytes.Length -gt (512 * 1024)) { return $null }
    $configText = [Text.UTF8Encoding]::new($false, $true).GetString($configBytes)
    $provisionStateBytes = [IO.File]::ReadAllBytes($ProvisioningStatePath)
    if ($provisionStateBytes.Length -le 0 -or $provisionStateBytes.Length -gt (128 * 1024)) { return $null }
    if ($provisionStateBytes.Length -ge 3 -and $provisionStateBytes[0] -eq 0xef -and $provisionStateBytes[1] -eq 0xbb -and $provisionStateBytes[2] -eq 0xbf) { return $null }
    $provisionStateText = [Text.UTF8Encoding]::new($false, $true).GetString($provisionStateBytes)
    $provisionStateHash = Get-BytesSha256Hex -Bytes $provisionStateBytes
    $state = $provisionStateText | ConvertFrom-Json -ErrorAction Stop
    if (-not (Test-ExactProperties -Value $state -Expected @('schemaVersion', 'profileName', 'importedAt', 'configHash', 'managedProviders'))) { return $null }
    $schemaTypeValid = $state.schemaVersion -isnot [string] -and $state.schemaVersion -isnot [bool]
    $schemaTypeValid = $schemaTypeValid -and ($state.schemaVersion -is [int] -or $state.schemaVersion -is [long] -or $state.schemaVersion -is [double] -or $state.schemaVersion -is [decimal])
    $schemaValueValid = $schemaTypeValid -and [double]$state.schemaVersion -eq 2 -and [double]$state.schemaVersion -eq [Math]::Truncate([double]$state.schemaVersion)
    if (-not $schemaValueValid) { return $null }
    $profileName = $state.profileName
    $profileValid = $profileName -is [string] -and $profileName.Length -ge 1 -and $profileName.Length -le 128 -and $profileName.Trim() -ceq $profileName -and -not [regex]::IsMatch($profileName, '[\x00-\x1F\x7F]')
    if (-not $profileValid) { return $null }
    $importedAtText = $state.importedAt
    if ($importedAtText -isnot [string]) { return $null }
    $importedAt = [DateTime]::MinValue
    if (-not [DateTime]::TryParseExact($importedAtText, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$importedAt)) { return $null }
    if ($importedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) -cne $importedAtText) { return $null }
    $configHash = $state.configHash
    if ($configHash -isnot [string] -or -not [regex]::IsMatch($configHash, '^[a-f0-9]{64}$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)) { return $null }
    if (-not (Test-ProviderIds -Providers $state.managedProviders)) { return $null }
    $actualHash = Get-BytesSha256Hex -Bytes $configBytes
    if (-not [string]::Equals($actualHash, $configHash, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $state | Add-Member -NotePropertyName provisionStateHash -NotePropertyValue ([string]$provisionStateHash) -Force
    return $state
  } catch {
    Write-SafeDiagnostic 'LiteLLM provisioning state is not a valid schema v2 UTF-8 document.'
    return $null
  }
}

function Test-ControlledStack {
  param($Stack)
  if (-not $Stack) { return $false }
  $runtimeRelativePath = ([string]$Stack.runtimeRelativePath).Replace('/', '\')
  $configRelativePath = ([string]$Stack.configRelativePath).Replace('/', '\')
  $port = $Stack.proxyPort
  $portIsNumber = $port -is [ValueType] -and $port -isnot [bool] -and $port -isnot [string]
  return ([string]$Stack.sidecarKind -ceq 'company-litellm' -and
    $runtimeRelativePath -ceq 'runtime-litellm\python.exe' -and
    $configRelativePath -ceq 'config.yaml' -and
    $portIsNumber -and [double]$port -eq $ProxyPortNumber -and [double]$port -eq [Math]::Truncate([double]$port))
}

function Test-StackMatchesState {
  param($Stack, $State)
  if (-not (Test-ControlledStack -Stack $Stack) -or $null -eq $State) { return $false }
  if ($Stack.configHash -isnot [string] -or $Stack.provisionStateHash -isnot [string]) { return $false }
  return [string]::Equals($Stack.configHash, [string]$State.configHash, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($Stack.provisionStateHash, [string]$State.provisionStateHash, [StringComparison]::OrdinalIgnoreCase)
}

function Write-Stack {
  param([int]$ProcessId, [string]$ConfigHash, [string]$ProvisionStateHash, [string]$StartedAt = '')
  if ($StartedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$') {
    $StartedAt = [DateTime]::Now.ToString('yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
  }
  $appPort = 3000
  $parsedPort = 0
  if ($env:CREATIVE_STUDIO_PORT -and [int]::TryParse($env:CREATIVE_STUDIO_PORT, [ref]$parsedPort) -and $parsedPort -ge 1 -and $parsedPort -le 65535) { $appPort = $parsedPort }
  $stack = [ordered]@{
    appPort = $appPort
    proxyPort = $ProxyPortNumber
    litellmPid = $ProcessId
    startedAt = $StartedAt
    stopScript = $StopScript
    sidecarKind = 'company-litellm'
    runtimeRelativePath = 'runtime-litellm\python.exe'
    configRelativePath = 'config.yaml'
    configHash = $ConfigHash
    provisionStateHash = $ProvisionStateHash
  }
  Write-AtomicUtf8Json -Path $StackPath -Value $stack
}

function Remove-ControlledStack {
  $stack = Read-Stack
  if (Test-ControlledStack -Stack $stack) { Remove-Item -LiteralPath $StackPath -Force -ErrorAction SilentlyContinue }
}

function Acquire-StartLock {
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      return [IO.File]::Open($StartLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      Start-Sleep -Milliseconds 250
    } catch {
      return $null
    }
  }
  return $null
}

function Wait-ForHealthy {
  param([int]$ProcessId, [int]$TimeoutSeconds = 30)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $record = Get-ProcessRecord -ProcessId $ProcessId
    if (-not $record) { return 'process_exited' }
    if (-not (Test-OwnedLiteLLMProcess -ProcessRecord $record)) { return 'ownership_changed' }
    if (Test-ProxyListenerOwnedByProcess -ProcessId $ProcessId) {
      try {
        $remainingSeconds = [Math]::Max(1, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
        $requestTimeout = [int][Math]::Min(2, $remainingSeconds)
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:4000/health/liveliness" -UseBasicParsing -TimeoutSec $requestTimeout -MaximumRedirection 0
        if ([int]$response.StatusCode -eq 200) {
          $finalRecord = Get-ProcessRecord -ProcessId $ProcessId
          if ($finalRecord -and (Test-OwnedLiteLLMProcess -ProcessRecord $finalRecord) -and (Test-ProxyListenerOwnedByProcess -ProcessId $ProcessId)) { return 'ready' }
        }
      } catch { }
    }
    $remainingMilliseconds = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMilliseconds -le 0) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min(1000, [Math]::Max(1, $remainingMilliseconds)))
  }
  return 'health_timeout'
}

function Stop-OwnedProcess {
  param([int]$ProcessId)
  $pinned = Get-PinnedProcess -ProcessId $ProcessId
  if ($null -eq $pinned) { return $false }
  try {
    if ($pinned.HasExited) { return $false }
    $record = Get-ProcessRecord -ProcessId $ProcessId
    if (-not (Test-OwnedLiteLLMProcess -ProcessRecord $record)) { return $false }
    if ($pinned.HasExited) { return $false }
    $recordAgain = Get-ProcessRecord -ProcessId $ProcessId
    if (-not (Test-OwnedLiteLLMProcess -ProcessRecord $recordAgain)) { return $false }
    if ($pinned.HasExited) { return $false }
    $null = $pinned.Kill()
    $waited = [bool]$pinned.WaitForExit(5000)
    if (-not $waited -and -not $pinned.HasExited) { return $false }
    return $true
  } catch {
    return $false
  } finally {
    try { $pinned.Dispose() } catch { }
  }
}

function Fail-Sidecar {
  param([string]$Code, [string]$Diagnostic)
  $script:terminalCode = $Code
  try { Write-SidecarStatus -Status 'failed' -Code $Code } catch { }
  Write-SafeDiagnostic $Diagnostic
  throw "LiteLLM sidecar failed: $Code"
}

$process = $null
try {
  New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null
  $script:lockStream = Acquire-StartLock
  if ($null -eq $script:lockStream) {
    Write-SafeDiagnostic 'Timed out waiting for the LiteLLM start lock; the active controller state was left untouched.'
    $script:terminalCode = 'lock_timeout'
    $script:exitCode = 1
  } else {

  $state = Read-ValidatedProvisioningState
  if (-not (Test-Path -LiteralPath $PythonExe)) { Fail-Sidecar -Code 'runtime_missing' -Diagnostic 'The bundled LiteLLM runtime is missing.' }
  if ($null -eq $state) { Fail-Sidecar -Code 'provision_invalid' -Diagnostic 'Provisioning state/config hash validation failed; LiteLLM was not started.' }
  $runtimeEnv = Read-ValidatedRuntimeEnv
  if ($null -eq $runtimeEnv) { Fail-Sidecar -Code 'provision_invalid' -Diagnostic 'Runtime environment validation failed; LiteLLM was not started.' }

  Write-SidecarStatus -Status 'starting' -Code 'starting'
  $existingStack = Read-Stack
  $ready = $false
  if (Test-ControlledStack -Stack $existingStack) {
    $existingPid = 0
    $pidValue = $existingStack.litellmPid
    $pidIsNumber = $pidValue -is [ValueType] -and $pidValue -isnot [bool] -and $pidValue -isnot [string]
    if ($pidIsNumber -and [double]$pidValue -eq [Math]::Truncate([double]$pidValue) -and [double]$pidValue -gt 0 -and [double]$pidValue -le 2147483647) { $existingPid = [int]$pidValue }
    $existingRecord = Get-ProcessRecord -ProcessId $existingPid
    if (-not $ForceRestart -and $existingRecord -and (Test-OwnedLiteLLMProcess -ProcessRecord $existingRecord) -and (Test-StackMatchesState -Stack $existingStack -State $state)) {
      $existingResult = Wait-ForHealthy -ProcessId $existingPid -TimeoutSeconds 30
      if ($existingResult -eq 'ready') {
        Write-Stack -ProcessId $existingPid -ConfigHash ([string]$state.configHash) -ProvisionStateHash ([string]$state.provisionStateHash) -StartedAt ([string]$existingStack.startedAt)
        Write-SidecarStatus -Status 'ready' -Code 'ready'
        $ready = $true
      } elseif ($existingResult -eq 'health_timeout') {
        if (Stop-OwnedProcess -ProcessId $existingPid) {
          Remove-ControlledStack
          Fail-Sidecar -Code 'health_timeout' -Diagnostic 'A controlled LiteLLM process did not reach health 200 before the timeout.'
        }
        Fail-Sidecar -Code 'start_failed' -Diagnostic 'A controlled LiteLLM process could not be safely stopped after the health timeout.'
      } elseif ($existingResult -eq 'ownership_changed') {
        Fail-Sidecar -Code 'start_failed' -Diagnostic 'A controlled LiteLLM process changed identity while health was being checked.'
      } else {
        Remove-ControlledStack
      }
    } elseif ($existingRecord -and (Test-OwnedLiteLLMProcess -ProcessRecord $existingRecord)) {
      # A legacy stack or config hash mismatch may point at a valid bundled
      # process, but it must not be reused against a different YAML snapshot.
      if (Stop-OwnedProcess -ProcessId $existingPid) {
        Remove-ControlledStack
      } else {
        Fail-Sidecar -Code 'start_failed' -Diagnostic 'A controlled LiteLLM process could not be safely stopped before applying the current config.'
      }
    } else {
      Remove-ControlledStack
    }
  }

  if (-not $ready) {
    if (Test-ProxyPortInUse) { Fail-Sidecar -Code 'port_in_use' -Diagnostic 'Port 4000 is occupied by a process not proven to belong to this installation.' }

    $sidecarArguments = @(
      '-X', 'utf8',
      '-m', 'litellm.proxy.proxy_cli',
      '--host', '127.0.0.1',
      '--port', [string]$ProxyPortNumber,
      '--num_workers', '1',
      '--config', $ConfigPath,
      '--telemetry', 'false'
    )
    $quotedConfigPath = [char]34 + $ConfigPath + [char]34
    $startArguments = @($sidecarArguments | ForEach-Object { if ([string]$_ -eq $ConfigPath) { $quotedConfigPath } else { [string]$_ } })
    $controlledNames = @($AllowedRuntimeEnvKeys + 'PYTHONUTF8', 'PYTHONIOENCODING', 'LITELLM_LOCAL_MODEL_COST_MAP', 'CREATIVE_STUDIO_SIDECAR_REQUEST_ID')
    $previousEnvironment = @{}
    foreach ($name in $controlledNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
      foreach ($name in $AllowedRuntimeEnvKeys) { [Environment]::SetEnvironmentVariable($name, ([string]$runtimeEnv[$name]), 'Process') }
      [Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'Process')
     [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', 'utf-8', 'Process')
     [Environment]::SetEnvironmentVariable('LITELLM_LOCAL_MODEL_COST_MAP', 'True', 'Process')
     [Environment]::SetEnvironmentVariable('CREATIVE_STUDIO_SIDECAR_REQUEST_ID', $SidecarRequestId, 'Process')
      $process = Start-Process -FilePath $PythonExe -ArgumentList $startArguments -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -PassThru
    } finally {
      foreach ($name in $controlledNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    }
    if ($null -eq $process) { Fail-Sidecar -Code 'start_failed' -Diagnostic 'Start-Process did not return a LiteLLM process.' }
    Write-Stack -ProcessId $process.Id -ConfigHash ([string]$state.configHash) -ProvisionStateHash ([string]$state.provisionStateHash)
    $result = Wait-ForHealthy -ProcessId $process.Id -TimeoutSeconds 30
    if ($result -eq 'ready') {
      Write-SidecarStatus -Status 'ready' -Code 'ready'
      $ready = $true
    } elseif ($result -eq 'process_exited') {
      Remove-ControlledStack
      Fail-Sidecar -Code 'process_exited' -Diagnostic 'The bundled LiteLLM process exited before health 200.'
    } elseif ($result -eq 'ownership_changed') {
      Fail-Sidecar -Code 'start_failed' -Diagnostic 'The bundled LiteLLM process changed identity before health 200.'
    } else {
      if (Stop-OwnedProcess -ProcessId $process.Id) {
        Remove-ControlledStack
        Fail-Sidecar -Code 'health_timeout' -Diagnostic 'The bundled LiteLLM process did not reach health 200 before the timeout.'
      }
      Fail-Sidecar -Code 'start_failed' -Diagnostic 'The bundled LiteLLM process could not be safely stopped after the health timeout.'
    }
  }
  if ($ready) { $script:terminalCode = 'ready'; $script:exitCode = 0 }
  }
} catch {
  if ($null -ne $process) {
    try { Stop-OwnedProcess -ProcessId ([int]$process.Id) } catch { }
    Remove-ControlledStack
  }
  if ($null -eq $script:terminalCode) {
    $script:terminalCode = 'start_failed'
    try { Write-SidecarStatus -Status 'failed' -Code 'start_failed' } catch { }
  }
  Write-SafeDiagnostic ('LiteLLM sidecar controller failed with code ' + $script:terminalCode + '.')
  $script:exitCode = 1
} finally {
  if ($null -ne $script:lockStream) { try { $script:lockStream.Dispose() } catch { } }
}

if ($null -eq $script:exitCode) { $script:exitCode = 1 }
exit $script:exitCode
