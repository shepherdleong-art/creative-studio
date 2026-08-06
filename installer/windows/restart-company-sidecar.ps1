param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$Root = [IO.Path]::GetFullPath($Root)
$ProxyPort = 4000
$PythonExe = [IO.Path]::GetFullPath((Join-Path $Root 'runtime-litellm\python.exe'))
$ConfigPath = [IO.Path]::GetFullPath((Join-Path $Root 'config.yaml'))
$StackPath = Join-Path $Root 'storage\run\stack.json'
$RunDir = Join-Path $Root 'storage\run'
$StartLockPath = Join-Path $RunDir 'company-sidecar-start.lock'
$StopScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\stop-company-sidecar.ps1'))
$StartScript = [IO.Path]::GetFullPath((Join-Path $Root 'scripts\start-company-sidecar.ps1'))
$LogPath = Join-Path $Root 'storage\logs\litellm.err.log'
$StackMaxBytes = 16 * 1024
$script:lockStream = $null
$script:exitCode = 0

function Write-SafeDiagnostic {
  param([string]$Message)
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
    Add-Content -LiteralPath $LogPath -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
  } catch { }
}

function Read-Stack {
  if (-not (Test-Path -LiteralPath $StackPath)) { return $null }
  try {
    $bytes = [IO.File]::ReadAllBytes($StackPath)
    if ($bytes.Length -le 0 -or $bytes.Length -gt $StackMaxBytes) { return $null }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { return $null }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    return ($text | ConvertFrom-Json -ErrorAction Stop)
  } catch { return $null }
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
      if ($found -or $index + 1 -ge $Tokens.Count) { return $false }
      $candidate = [string]$Tokens[$index + 1]
      $matchesExpected = if ($Normalize) {
        [string]::Equals((Normalize-WindowsPath $candidate), (Normalize-WindowsPath $Expected), [StringComparison]::OrdinalIgnoreCase)
      } else {
        [string]::Equals($candidate, $Expected, [StringComparison]::Ordinal)
      }
      if (-not $matchesExpected) { return $false }
      $found = $true
    }
  }
  return $found
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
    $portIsNumber -and [double]$port -eq $ProxyPort -and [double]$port -eq [Math]::Truncate([double]$port))
}

function Get-StackProcessId {
  param($Stack)
  if (-not $Stack) { return 0 }
  $value = $Stack.litellmPid
  if ($value -isnot [ValueType] -or $value -is [bool] -or $value -is [string]) { return 0 }
  try {
    $number = [double]$value
    if ($number -ne [Math]::Truncate($number) -or $number -le 0 -or $number -gt 2147483647) { return 0 }
    return [int]$number
  } catch { return 0 }
}

function Test-OwnedLiteLLMProcess {
  param($ProcessRecord)
  if (-not $ProcessRecord) { return $false }
  if ((Normalize-WindowsPath ([string]$ProcessRecord.ExecutablePath)) -ne (Normalize-WindowsPath $PythonExe)) { return $false }
  $tokens = Get-CommandTokens -CommandLine ([string]$ProcessRecord.CommandLine)
  return (Test-TokenPair -Tokens $tokens -Flag '-m' -Expected 'litellm.proxy.proxy_cli') -and
    (Test-TokenPair -Tokens $tokens -Flag '--config' -Expected $ConfigPath -Normalize $true) -and
    (Test-TokenPair -Tokens $tokens -Flag '--host' -Expected '127.0.0.1') -and
    (Test-TokenPair -Tokens $tokens -Flag '--port' -Expected '4000')
}

function Test-PinnedOwnedProcess {
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
    return -not $pinned.HasExited
  } catch {
    return $false
  } finally {
    try { $pinned.Dispose() } catch { }
  }
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

$shouldStart = $false
try {
  New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
  $script:lockStream = Acquire-StartLock
  if ($null -eq $script:lockStream) {
    Write-SafeDiagnostic 'Timed out waiting for the LiteLLM start lock; no stop or start action was taken.'
    $script:exitCode = 1
  } else {
    $stack = Read-Stack
    $canStop = $false
    if (Test-ControlledStack -Stack $stack) {
      $processId = Get-StackProcessId -Stack $stack
      if ($processId -gt 0) {
        $record = Get-ProcessRecord -ProcessId $processId
        $canStop = $record -and (Test-OwnedLiteLLMProcess -ProcessRecord $record) -and (Test-PinnedOwnedProcess -ProcessId $processId)
      }
    }
    if ($canStop -and (Test-Path -LiteralPath $StopScript)) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StopScript -Root $Root -SkipStartLock
      if ($LASTEXITCODE -ne 0) { Write-SafeDiagnostic 'Controlled sidecar stop returned a non-zero status; start will revalidate ownership.' }
    }
    $shouldStart = $true
  }
} catch {
  Write-SafeDiagnostic 'LiteLLM restart controller failed closed.'
  $script:exitCode = 1
} finally {
  if ($null -ne $script:lockStream) { try { $script:lockStream.Dispose() } catch { } }
}

if ($script:exitCode -ne 0 -or -not $shouldStart) { exit 1 }
if (-not (Test-Path -LiteralPath $StartScript)) { exit 1 }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $StartScript -Root $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
exit 0
