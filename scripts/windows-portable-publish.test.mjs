// Actual Windows directory-rename contention, not a mocked filesystem.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') { console.log('SKIP Windows directory publication'); process.exit(0); }
const parent = path.resolve('outputs/2026-10-19-film-editing'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'publish-retry-'));
const script = path.join(root, 'exercise.ps1');
fs.writeFileSync(script, '\ufeff' + String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PUBLISH_BUILD_SCRIPT, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Build script did not parse' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Publish-PortableDirectory' }, $true)
if (-not $definition) { throw 'Missing actual publication function' }
. ([scriptblock]::Create($definition.Extent.Text))
$source = Join-Path $env:PUBLISH_TEST_ROOT '.portable-staging-locked'
$target = Join-Path $env:PUBLISH_TEST_ROOT '发布 中文 空格'
New-Item -ItemType Directory -Path $source | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'identity.txt'), 'verified fixture')
$child = Start-Process -FilePath $env:PUBLISH_NODE -ArgumentList @('-e','"setTimeout(()=>{},2500)"') -WorkingDirectory $source -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Milliseconds 300
  $reproduced = $false
  try { Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop }
  catch { $reproduced = $true }
  if (-not $reproduced) { throw 'Old publication path did not reproduce contention' }
  Publish-PortableDirectory $source $target
  $child.WaitForExit()
} finally { if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force } }
if ((Test-Path -LiteralPath $source) -or [IO.File]::ReadAllText((Join-Path $target 'identity.txt')) -ne 'verified fixture') { throw 'Publication lost fixture' }
$second = Join-Path $env:PUBLISH_TEST_ROOT '.portable-staging-second'
New-Item -ItemType Directory -Path $second | Out-Null
$rejected = $false
try { Publish-PortableDirectory $second $target } catch { $rejected = $true }
if (-not $rejected -or -not (Test-Path -LiteralPath $second) -or (Test-Path -LiteralPath (Join-Path $target '.portable-staging-second'))) { throw 'Existing destination was overwritten or nested into' }
$locked = Join-Path $env:PUBLISH_TEST_ROOT '.portable-staging-permanent'
$blockedTarget = Join-Path $env:PUBLISH_TEST_ROOT 'blocked-output'
New-Item -ItemType Directory -Path $locked | Out-Null
$blocker = Start-Process -FilePath $env:PUBLISH_NODE -ArgumentList @('-e','"setTimeout(()=>{},20000)"') -WorkingDirectory $locked -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Milliseconds 300
  $rejected = $false
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try { Publish-PortableDirectory $locked $blockedTarget } catch { $rejected = $true }
  if (-not $rejected -or $timer.Elapsed.TotalSeconds -gt 15 -or (Test-Path -LiteralPath $blockedTarget) -or -not (Test-Path -LiteralPath $locked)) { throw 'Persistent lock was not rejected within the bound' }
} finally { if (-not $blocker.HasExited) { Stop-Process -Id $blocker.Id -Force } }
Write-Output 'PASS actual locked rename recovery and no-overwrite publication'
`.replace(/\r?\n/g, '\r\n'));
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
  env: { ...process.env, PUBLISH_BUILD_SCRIPT: path.resolve('scripts/build-windows-portable.ps1'), PUBLISH_TEST_ROOT: root, PUBLISH_NODE: process.execPath },
  encoding: 'utf8', windowsHide: true, timeout: 30000,
});
fs.writeFileSync(path.join(root, 'result.log'), result.stdout + result.stderr);
assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
console.log(result.stdout.trim());
