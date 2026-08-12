param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
$Executable = Join-Path $Root 'CreativeStudio.exe'
$ResolvedExecutable = [System.IO.Path]::GetFullPath($Executable)

Write-Host '正在停止产品素材工作台…'
$DataRoots = @()
if ($env:CREATIVE_STUDIO_DATA_ROOT) { $DataRoots += $env:CREATIVE_STUDIO_DATA_ROOT }
$DataRoots += $Root
if ($env:APPDATA) { $DataRoots += (Join-Path $env:APPDATA 'CreativeStudio') }
$ServiceOrigin = $null
$ExpectedInstanceId = $null
foreach ($dataRoot in ($DataRoots | Select-Object -Unique)) {
  $candidate = Join-Path $dataRoot 'storage\run\electron-service.json'
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  try {
    $state = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8 | ConvertFrom-Json
    $rawOrigin = [string]$state.origin
    $rawInstanceId = [string]$state.instanceId
    $originMatch = [regex]::Match($rawOrigin, '^http://127\.0\.0\.1:([1-9][0-9]{0,4})$')
    if ($state.version -eq 1 -and $originMatch.Success -and $rawInstanceId -match '^[A-Za-z0-9-]{1,128}$') {
      $port = 0
      if ([int]::TryParse($originMatch.Groups[1].Value, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
        $ServiceOrigin = "http://127.0.0.1:$port"
        $ExpectedInstanceId = $rawInstanceId
        break
      }
    }
  } catch {
    # Ignore malformed or stale state and try the next controlled data root.
  }
}

function Get-MatchedProcesses {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='CreativeStudio.exe'" -ErrorAction SilentlyContinue)
  return @($processes | Where-Object {
    $processExecutable = $null
    if ($_.ExecutablePath) {
      try { $processExecutable = [System.IO.Path]::GetFullPath([string]$_.ExecutablePath) } catch { $processExecutable = $null }
    }
    $processExecutable -and $processExecutable -ieq $ResolvedExecutable
  })
}

$matchedProcesses = @(Get-MatchedProcesses)
$matched = $matchedProcesses.Count -gt 0
$gracefulRequested = $false
function Test-ServiceInstance {
  if (-not $ServiceOrigin -or -not $ExpectedInstanceId) { return $false }
  try {
    $health = Invoke-WebRequest -Method Get -Uri "$ServiceOrigin/api/desktop/health" -TimeoutSec 2 -UseBasicParsing
    $payload = $health.Content | ConvertFrom-Json
    return ([string]$payload.instanceId -eq $ExpectedInstanceId)
  } catch {
    return $false
  }
}

if ($matched -and (Test-ServiceInstance)) {
  # Mark the request before sending it: /api/shutdown exits its Node process,
  # so the HTTP response can legitimately be missing after the server accepts it.
  $gracefulRequested = $true
  try {
    Invoke-WebRequest -Method Post -Uri "$ServiceOrigin/api/shutdown" -TimeoutSec 15 -UseBasicParsing | Out-Null
  } catch {
    # Continue polling the verified service; do not immediately force-kill it.
  }
}

if ($gracefulRequested) {
  $deadline = (Get-Date).AddSeconds(18)
  $serviceStopped = $false
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-MatchedProcesses)
    if ($remaining.Count -eq 0) { break }
    if (-not (Test-ServiceInstance)) {
      # The Electron shell can remain alive after its child Node service exits;
      # a failed health check here proves the graceful child shutdown completed.
      $serviceStopped = $true
      break
    }
  } while ((Get-Date) -lt $deadline)
  $matchedProcesses = $remaining
}

if ($matchedProcesses.Count -gt 0) {
  foreach ($process in $matchedProcesses) {
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
  }
}

if ($matched) {
  if ($gracefulRequested -and $matchedProcesses.Count -eq 0) {
    Write-Host '产品素材工作台已完成优雅停机。' -ForegroundColor Green
  } else {
    Write-Host '产品素材工作台及其私有服务进程树已强制停止。' -ForegroundColor Yellow
  }
} else {
  Write-Host '未找到当前安装目录对应的运行实例。' -ForegroundColor Yellow
}
