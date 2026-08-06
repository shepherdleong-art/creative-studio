param(
  [string]$PythonVersion = '3.12.10',
  [string]$LiteLLMVersion = '1.89.2',
  [string]$PipVersion = '26.1.2',
  [string]$CacheRoot = '',
  [string]$OutputRoot = '',
  # Python digest comes from the release Sigstore bundle; pip comes from PyPI metadata.
  [string]$PythonEmbeddableSha256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3',
  [string]$PipWheelSha256 = '382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab',
  [switch]$ReuseValidatedCache
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

# Build self-checks must be offline-deterministic: force LiteLLM to use its bundled
# model cost map. Otherwise a slow or blocked fetch of the remote cost map prints a
# stderr warning that Windows PowerShell 5.1 promotes to a terminating error.
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'

if ($LiteLLMVersion -ne '1.89.2') {
  throw "The packaged LiteLLM version is pinned to 1.89.2; received $LiteLLMVersion."
}
if ($PythonVersion -notmatch '^3\.12\.10$') {
  throw "The packaged CPython version is pinned to 3.12.10; received $PythonVersion."
}
if ($PipVersion -ne '26.1.2') {
  throw "The build-only pip version is pinned to 26.1.2; received $PipVersion."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
if (-not $CacheRoot) { $CacheRoot = Join-Path $Root '.cache\windows-installer\litellm' }
if (-not $OutputRoot) { $OutputRoot = Join-Path $CacheRoot 'runtime-litellm' }
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$EmbeddablePath = Join-Path $CacheRoot "python-$PythonVersion-embed-amd64.zip"
$EmbeddableUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$PipWheelName = "pip-$PipVersion-py3-none-any.whl"
$PipWheelPath = Join-Path $CacheRoot $PipWheelName
$PipWheelUrl = "https://files.pythonhosted.org/packages/5d/95/6b5cb3461ea5673ba0995989746db58eb18b91b54dbf331e72f569540946/$PipWheelName"
$ManifestPath = Join-Path $OutputRoot 'manifest.json'
$PythonExe = Join-Path $OutputRoot 'python.exe'
$PthPath = Join-Path $OutputRoot 'python312._pth'
$SitePackages = Join-Path $OutputRoot 'Lib\site-packages'

function Download-File {
  param([string]$Uri, [string]$Destination)
  if (Test-Path -LiteralPath $Destination) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading build dependency: $Uri"
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
  } catch {
    throw "Failed to download required build dependency $Uri. No runtime was produced. $($_.Exception.Message)"
  }
  if (-not (Test-Path -LiteralPath $Destination)) { throw "Download did not create $Destination" }
}

function Assert-Sha256 {
  param([string]$Path, [string]$Expected, [string]$Label)
  if (-not $Expected) { return }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.Trim().ToLowerInvariant()) {
    throw "$Label SHA-256 mismatch. Expected $Expected, received $actual."
  }
}

function Get-Manifest {
  if (-not (Test-Path -LiteralPath $ManifestPath)) { return $null }
  try { return (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-EmbeddedImportCheck {
  $code = "import sys, importlib.metadata as metadata; sys.path.insert(0, r'$SitePackages'); import litellm, litellm.proxy.proxy_cli; assert metadata.version('litellm') == '$LiteLLMVersion'"
  & $PythonExe -X utf8 -I -S -c $code 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Invoke-EmbeddedCliCheck {
  # Include the production flags so Click rejects an invalid invocation during the build.
  # LiteLLM 1.89.2 imports proxy_cli from litellm.proxy.__init__ before runpy executes
  # the module, which emits a harmless RuntimeWarning that PowerShell 5.1 promotes.
  & $PythonExe -X utf8 -I -S -W ignore::RuntimeWarning -m litellm.proxy.proxy_cli --host 127.0.0.1 --port 4000 --num_workers 1 --config config.yaml --telemetry false --help 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Test-ValidatedRuntime {
  $manifest = Get-Manifest
  if (-not $manifest -or $manifest.pythonVersion -ne $PythonVersion -or $manifest.litellmVersion -ne $LiteLLMVersion -or $manifest.architecture -ne 'x64') { return $false }
  if (-not $manifest.pythonArtifacts -or -not $manifest.pythonDistributions) { return $false }
  $litellmDistributions = @($manifest.pythonDistributions | Where-Object { $_.name -eq 'litellm' -and $_.version -eq $LiteLLMVersion })
  if ($litellmDistributions.Count -ne 1) { return $false }
  if (-not (Test-Path -LiteralPath $PythonExe) -or -not (Test-Path -LiteralPath $PthPath) -or -not (Test-Path -LiteralPath (Join-Path $SitePackages 'litellm'))) { return $false }
  if (-not (Test-Path -LiteralPath $EmbeddablePath) -or (Get-Sha256 $EmbeddablePath) -ne [string]$manifest.pythonArtifacts.embeddable.sha256) { return $false }
  if (-not (Test-Path -LiteralPath $PipWheelPath) -or (Get-Sha256 $PipWheelPath) -ne [string]$manifest.pythonArtifacts.pipBootstrap.sha256) { return $false }
  return ((Invoke-EmbeddedImportCheck) -and (Invoke-EmbeddedCliCheck))
}

New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
if ($ReuseValidatedCache -and (Test-ValidatedRuntime)) {
  Write-Host "Reusing validated LiteLLM runtime: $OutputRoot" -ForegroundColor Green
  exit 0
}

Download-File -Uri $EmbeddableUrl -Destination $EmbeddablePath
Download-File -Uri $PipWheelUrl -Destination $PipWheelPath
$PythonEmbeddableSha256Actual = Get-Sha256 $EmbeddablePath
$PipWheelSha256Actual = Get-Sha256 $PipWheelPath
Assert-Sha256 -Path $EmbeddablePath -Expected $PythonEmbeddableSha256 -Label 'Python embeddable archive'
Assert-Sha256 -Path $PipWheelPath -Expected $PipWheelSha256 -Label 'pip bootstrap wheel'

if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -LiteralPath $OutputRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutputRoot, $SitePackages | Out-Null
Expand-Archive -LiteralPath $EmbeddablePath -DestinationPath $OutputRoot -Force
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Embeddable Python runtime was not extracted: $PythonExe" }

$pthContent = "python312.zip`r`n.`r`nLib\site-packages`r`nimport site`r`n"
[IO.File]::WriteAllText($PthPath, $pthContent, [Text.UTF8Encoding]::new($false))

Write-Host "Vendoring litellm[proxy]==$LiteLLMVersion into the private runtime..."
$pipCode = "import sys; sys.path.insert(0, r'$PipWheelPath'); from pip._internal.cli.main import main; raise SystemExit(main(sys.argv[1:]))"
& $PythonExe -I -S -c $pipCode install --disable-pip-version-check --no-input --no-compile --only-binary=:all: --target $SitePackages "litellm[proxy]==$LiteLLMVersion"
if ($LASTEXITCODE -ne 0) { throw "pip failed while vendoring litellm[proxy]==$LiteLLMVersion; installer build aborted." }

if (-not (Invoke-EmbeddedImportCheck)) { throw 'Offline LiteLLM import self-check failed; refusing to emit an incomplete runtime.' }
if (-not (Invoke-EmbeddedCliCheck)) { throw 'Embedded LiteLLM CLI self-check failed; refusing to emit an incomplete runtime.' }
$manifestCode = @'
import importlib.metadata as metadata
import json
import sys
from datetime import datetime, timezone

(
    manifest_path,
    python_version,
    litellm_version,
    embeddable_name,
    embeddable_sha256,
    pip_name,
    pip_version,
    pip_sha256,
) = sys.argv[1:]
distributions = [
    {'name': (dist.metadata.get('Name') or dist.name), 'version': dist.version}
    for dist in metadata.distributions()
]
distributions.sort(key=lambda item: (item['name'].lower(), item['version']))
manifest = {
    'schemaVersion': 1,
    'pythonVersion': python_version,
    'litellmVersion': litellm_version,
    'architecture': 'x64',
    'platform': 'win32',
    'runtime': 'python312-embeddable',
    'entrypoint': 'litellm.proxy.proxy_cli',
    'pythonArtifacts': {
        'embeddable': {'name': embeddable_name, 'sha256': embeddable_sha256},
        'pipBootstrap': {'name': pip_name, 'version': pip_version, 'sha256': pip_sha256},
    },
    'pythonDistributions': distributions,
    'builtAtUtc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    'dependencies': {'pip': f'{pip_version}-build-time-only', 'proxyExtra': True},
}
with open(manifest_path, 'w', encoding='utf-8', newline='\n') as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write('\n')
'@
& $PythonExe -I -S -c $manifestCode $ManifestPath $PythonVersion $LiteLLMVersion "python-$PythonVersion-embed-amd64.zip" $PythonEmbeddableSha256Actual $PipWheelName $PipVersion $PipWheelSha256Actual
if ($LASTEXITCODE -ne 0) { throw 'Unable to write the LiteLLM runtime manifest.' }

if (-not (Test-ValidatedRuntime)) { throw 'Final LiteLLM runtime validation failed.' }
Write-Host "LiteLLM runtime ready: $OutputRoot" -ForegroundColor Green
