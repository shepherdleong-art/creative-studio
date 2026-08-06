import assert from 'node:assert/strict';
import { accessSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => accessSync(path);

const builderPath = 'scripts/build-litellm-sidecar.ps1';
const buildPath = 'scripts/build-win-installer.ps1';
const startPath = 'installer/windows/start-company-sidecar.ps1';
const stopPath = 'installer/windows/stop-company-sidecar.ps1';
const restartPath = 'installer/windows/restart-company-sidecar.ps1';
const launcherPath = 'installer/windows/launcher.cs';
const allPowerShell = [
  builderPath,
  buildPath,
  startPath,
  stopPath,
  restartPath,
  'installer/windows/start-installed.ps1',
  'installer/windows/stop-installed.ps1',
  'installer/windows/clear-user-data.ps1',
];

for (const path of [...allPowerShell, 'installer/windows/README-INSTALLED.md']) exists(path);
for (const path of allPowerShell) {
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${path} must be UTF-8 BOM encoded`);
}

const builder = read(builderPath);
assert.match(builder, /PythonVersion\s*=\s*'3\.12\.10'/);
assert.match(builder, /LiteLLMVersion\s*=\s*'1\.89\.2'/);
assert.match(builder, /python\.org\/ftp\/python/);
assert.match(builder, /4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3/);
assert.match(builder, /PipVersion\s*=\s*'26\.1\.2'/);
assert.match(builder, /382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab/);
assert.match(builder, /files\.pythonhosted\.org/);
assert.match(builder, /python312\._pth/);
assert.match(builder, /litellm\[proxy\]==\$LiteLLMVersion/);
assert.match(builder, /litellm\.proxy\.proxy_cli/);
assert.match(builder, /Test-ValidatedRuntime/);
assert.match(builder, /manifest\.json/);
assert.match(builder, /Get-Sha256/);
assert.match(builder, /pythonArtifacts/);
assert.match(builder, /sha256/);
assert.match(builder, /pythonDistributions/);
assert.match(builder, /importlib\.metadata/);
assert.match(builder, /litellmDistributions\.Count -ne 1/);
assert.match(builder, /metadata\.version\('litellm'\)/);
assert.match(builder, /-m litellm\.proxy\.proxy_cli .*--help/);
assert.match(builder, /no runtime was produced|installer build aborted/i);

const build = read(buildPath);
assert.match(build, /LiteLLMVersion\s*=\s*'1\.89\.2'/);
assert.match(build, /build-litellm-sidecar\.ps1/);
assert.match(build, /SkipLiteLLMSidecarBuild/);
assert.match(build, /runtime-litellm/);
assert.match(build, /PythonEmbeddableSha256/);
assert.match(build, /PipWheelSha256/);
assert.match(build, /NodeRuntimeSha256/);
assert.match(build, /6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33/);
assert.match(build, /Node\.js runtime SHA-256 mismatch/);
assert.match(build, /forbiddenConfigurationFiles/);
assert.match(build, /\*\.provision/);
assert.match(build, /company-profile\*\.json/);
for (const forbidden of ['config.yaml', 'litellm-config.yaml', 'data\\provisioning', 'provisioning', 'runtime.env', '.env.local']) {
  assert.match(build, new RegExp(forbidden.replaceAll('\\', '\\\\').replace('.', '\\.')));
}
assert.match(build, /README-INSTALLED\.md/);
assert.match(build, /restart-company-sidecar\.ps1/);

const start = read(startPath);
const sidecarArgumentsBlock = start.slice(start.indexOf('$sidecarArguments = @('), start.indexOf('$quotedConfigPath'));
assert.doesNotMatch(sidecarArgumentsBlock, /SIDECAR_REQUEST_ID/);
assert.match(start, /config\.yaml/);
assert.match(start, /runtime-litellm\\python\.exe/);
assert.match(start, /data\\provisioning\\runtime\.env/);
assert.match(start, /data\\provisioning\\state\.json/);
assert.match(start, /127\.0\.0\.1/);
assert.match(start, /litellm\.proxy\.proxy_cli/);
assert.match(start, /\$ProxyPortNumber\s*=\s*4000/);
assert.match(start, /\$sidecarArguments\s*=\s*@\(/);
assert.match(start, /['"]-X['"]\s*,\s*['"]utf8['"]/);
assert.match(start, /['"]-m['"]\s*,\s*['"]litellm\.proxy\.proxy_cli['"]/);
assert.match(start, /['"]--host['"]\s*,\s*['"]127\.0\.0\.1['"]/);
assert.match(start, /['"]--port['"]\s*,\s*(?:['"]4000['"]|\[string\]\$ProxyPortNumber)/);
assert.match(start, /['"]--num_workers['"]\s*,\s*['"]1['"]/);
assert.match(start, /['"]--telemetry['"]\s*,\s*['"]false['"]/);
assert.doesNotMatch(start, /--debug/);
assert.doesNotMatch(start, /CREATIVE_STUDIO_PROXY_PORT|-ProxyPort\b/);
assert.match(start, /health\/liveliness/);
assert.match(start, /sidecarKind\s*=\s*'company-litellm'/);
assert.match(start, /UTF8Encoding\]::new\(\$false\)/);
assert.match(start, /AllowedRuntimeEnvKeys/);
assert.match(start, /CREATIVE_STUDIO_GATEWAY_API_KEY/);
assert.match(start, /COMPANY_GATEWAY_API_KEY/);
assert.match(start, /GATEWAY_API_KEY/);
assert.match(start, /CREATIVE_STUDIO_COS_SECRET_KEY/);
assert.match(start, /ConvertFrom-Json/);
assert.match(start, /Get-BytesSha256Hex/);
assert.match(start, /requestId\s*=\s*\$SidecarRequestId/);
assert.match(start, /SidecarRequestId/);
assert.match(start, /CREATIVE_STUDIO_SIDECAR_REQUEST_ID/);
assert.match(start, /CanonicalRequestIdPattern|-cmatch/);
assert.match(start, /configHash/);
assert.match(start, /Read-ValidatedProvisioningState/);
assert.match(start, /provisionStateHash/, 'stack identity must include the exact provisioning state hash');
assert.match(start, /Get-BytesSha256Hex[\s\S]*provisionStateBytes/, 'provision state hash must be derived from the exact state.json bytes');
assert.match(start, /Test-StackMatchesState[\s\S]*provisionStateHash/, 'reuse must require both config and provisioning state hashes');
assert.match(start, /Test-ProxyListenerOwnedByProcess/);
assert.match(start, /RuntimeEnvValueMaxChars/);
assert.match(start, /RuntimeEnvMaxBytes/);
assert.match(start, /company-sidecar-start\.lock/);
assert.match(start, /FileShare\]::None/);
assert.match(start, /schemaVersion\s*=\s*2/);
assert.match(start, /schemaTypeValid|schemaValueValid/);
for (const code of ['runtime_missing', 'provision_invalid', 'port_in_use', 'process_exited', 'health_timeout', 'start_failed']) {
  assert.match(start, new RegExp(code));
}
assert.match(start, /RedirectStandardOutput/);
assert.match(start, /RedirectStandardError/);
assert.match(start, /Start-Process/);
assert.doesNotMatch(start, /BeginOutputReadLine|BeginErrorReadLine|add_OutputDataReceived|add_ErrorDataReceived/);
assert.match(start, /Test-OwnedLiteLLMProcess/);
assert.match(start, /yyyy-MM-ddTHH:mm:ss/);
assert.doesNotMatch(start, /CREATIVE_STUDIO_COS_SECRET_KEY\s*=\s*[^\r\n]/i);

const restart = read(restartPath);
assert.match(restart, /start-company-sidecar\.ps1/);
assert.match(restart, /-File \$StartScript/);
assert.match(restart, /-ForceRestart/);
assert.doesNotMatch(restart, /SIDECAR_REQUEST_ID/);
assert.doesNotMatch(restart, /-File \$StopScript/);
assert.doesNotMatch(restart, /company-sidecar-start\.lock|Acquire-StartLock|SkipStartLock/);
assert.doesNotMatch(restart, /Stop-Process/);
assert.doesNotMatch(restart, /CREATIVE_STUDIO_PROXY_PORT|-ProxyPort\b/);

const stop = read(stopPath);
assert.match(restart, /\[CmdletBinding\(\)\]\s*param\(/);
assert.match(stop, /\[CmdletBinding\(\)\]\s*param\(/);
assert.match(stop, /Win32_Process/);
assert.match(stop, /ExecutablePath/);
assert.match(stop, /litellm\.proxy\.proxy_cli/);
assert.match(stop, /--config/);
assert.match(stop, /--host/);
assert.match(stop, /127\.0\.0\.1/);
assert.doesNotMatch(stop, /IndexOf\(/);
assert.doesNotMatch(stop, /Contains\([^\n]+StringComparison/);
assert.doesNotMatch(stop, /Get-Process\s+python/i);
assert.doesNotMatch(stop, /Get-NetTCPConnection/);

const installedStart = read('installer/windows/start-installed.ps1');
assert.match(installedStart, /\$sidecarArguments\s*=.*-File `"\$sidecarStartScript`".*-Root `"\$Root`"/);
assert.match(installedStart, /-ArgumentList \$sidecarArguments/);
assert.doesNotMatch(installedStart, /SIDECAR_REQUEST_ID/);
assert.match(installedStart, /CREATIVE_STUDIO_DATA_ROOT/);
assert.match(installedStart, /CREATIVE_STUDIO_MANAGED_DEPLOYMENT/);
assert.doesNotMatch(installedStart, /-ProxyPort\b|CREATIVE_STUDIO_PROXY_PORT/);

const launcher = read(launcherPath);
const sidecarStart = launcher.indexOf('StartCompanySidecar(storageBase)');
const portCheck = launcher.indexOf('IsPortListening(port)');
assert.ok(sidecarStart >= 0 && portCheck > sidecarStart, 'sidecar must be launched before the app port check');
assert.match(launcher, /start-company-sidecar\.ps1/);
assert.match(launcher, /Process\.Start\(psi\)/);
assert.match(launcher, /CreateNoWindow\s*=\s*true/);
assert.match(launcher, /bool isInstalled/);
assert.match(launcher, /out bool isInstalled/);
assert.match(launcher, /if \(isInstalled\)\s*\{\s*StartCompanySidecar\(storageBase\);/s);
assert.match(launcher, /CREATIVE_STUDIO_MANAGED_DEPLOYMENT/);
assert.doesNotMatch(launcher, /CREATIVE_STUDIO_PROXY_PORT|-ProxyPort\b/);
assert.doesNotMatch(launcher, /optional|offline|best[- ]effort/i);
assert.doesNotMatch(launcher, /WaitForExit/);

// Strict Task4 regression contract. These assertions intentionally fail on
// the pre-review implementation and are kept executable as the implementation
// is tightened below.
assert.match(start, /AddSeconds\(60\)/, 'start lock must cover a complete sidecar health budget');
assert.match(start, /Wait-ForHealthy[\s\S]*?deadline\s*=\s*\[DateTime\]::UtcNow\.AddSeconds/, 'health wait must use a wall-clock deadline');
assert.doesNotMatch(start, /if \(\$null -eq \$script:lockStream\)\s*\{\s*Fail-Sidecar/, 'lock contention must not overwrite the holder status');
assert.match(start, /FileShare\]::None/);
assert.doesNotMatch(start, /catch\s*\{\s*Move-Item\s+-LiteralPath\s+\$tempPath[^\n]*-Force/, 'existing status replacement must not fall back to destructive Move-Item');
assert.match(start, /File\]::Replace[\s\S]*throw/, 'Replace failure must fail closed after cleaning the temp file');
assert.match(start, /-MaximumRedirection\s+0/, 'health check must reject redirects');
assert.match(start, /company-sidecar-start\.lock/);
assert.match(start, /Acquire-StartLock/);
assert.match(start, /lockStream/);
assert.doesNotMatch(restart, /company-sidecar-start\.lock|Acquire-StartLock/);
assert.match(stop, /GetProcessById/);
assert.match(start, /GetProcessById/);
assert.doesNotMatch(stop, /Stop-Process/);
assert.doesNotMatch(start, /Stop-Process/);
assert.match(stop, /\.Kill\(\)/);
assert.match(start, /\.Kill\(\)/);
assert.match(stop, /Test-TokenPair|Test-Pair/);
assert.doesNotMatch(stop, /IndexOf\(/);
assert.match(start, /schemaTypeValid[\s\S]*schemaVersion\s+-is\s+\[int\]/i);
assert.match(start, /config.*512\s*\*\s*1024|512KB/i);
assert.match(start, /managedProviders/);
assert.match(start, /\[Array\]/);
assert.match(start, /\{0,63\}/);
assert.match(start, /-ceq\s+'company-litellm'/);
assert.match(start, /portIsNumber[\s\S]*proxyPort[\s\S]*-isnot\s+\[string\]/i);
assert.match(restart, /-ForceRestart/);
assert.ok(restart.indexOf('-File $StartScript') >= 0, 'restart must invoke start');
assert.match(start, /Acquire-StartLock/);
assert.match(start, /ForceRestart/);
assert.doesNotMatch(start, /SkipStartLock/);
assert.doesNotMatch(stop, /SkipStartLock/);
assert.match(start, /\[CmdletBinding\(\)\]\s*param\(/);
assert.match(start, /configHash/);
assert.match(start, /Write-Stack[\s\S]*configHash/);
assert.match(start, /configHash[^\n]*OrdinalIgnoreCase/);
assert.match(start, /\[switch\]\$ForceRestart/, 'start must expose an explicit force-restart mode');
assert.match(start, /WaitForExit\(5000\)[\s\S]*HasExited/, 'kill success must require an exited process');
assert.match(start, /File\]::Replace[\s\S]*catch \{ throw 'Atomic status replacement failed\.' \}[\s\S]*File\]::Delete[\s\S]*catch \{ \}/, 'backup cleanup failure must not turn a successful replace into failure');

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function createProvisionFixture(root, stateOverrides = {}, configBytes = Buffer.from('model_list:\n  - model_name: "价格 € / 中文"\n', 'utf8')) {
  const provisioning = path.join(root, 'data', 'provisioning');
  const runtime = path.join(root, 'runtime-litellm');
  mkdirSync(provisioning, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const configPath = path.join(root, 'config.yaml');
  writeFileSync(configPath, configBytes);
  const hash = createHash('sha256').update(configBytes).digest('hex');
  const state = {
    schemaVersion: 2,
    profileName: '测试公司统一配置',
    importedAt: '2026-08-06T00:00:00.000Z',
    configHash: hash,
    managedProviders: {
      image: ['company-image'],
      script: ['company-script'],
      video: ['company-video'],
      tts: ['doubao-seed-tts-2'],
    },
    ...stateOverrides,
  };
  writeJson(path.join(provisioning, 'state.json'), state);
  const runtimeLines = [
    'CREATIVE_STUDIO_GATEWAY_API_KEY="dummy-gateway-key"',
    'COMPANY_GATEWAY_API_KEY="dummy-gateway-key"',
    'GATEWAY_API_KEY="dummy-gateway-key"',
    'CREATIVE_STUDIO_COS_SECRET_ID="dummy-cos-id"',
    'CREATIVE_STUDIO_COS_SECRET_KEY="dummy-cos-key"',
    'CREATIVE_STUDIO_COS_DOMAIN="example.invalid"',
  ];
  writeFileSync(path.join(provisioning, 'runtime.env'), `${runtimeLines.join('\n')}\n`, 'utf8');
  const windowsSystem = process.env.SystemRoot || 'C:\\Windows';
  copyFileSync(path.join(windowsSystem, 'System32', 'cmd.exe'), path.join(runtime, 'python.exe'));
}

if (process.platform === 'win32' && existsSync('installer/windows/start-company-sidecar.ps1')) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.resolve(startPath);
  const root = mkdtempSync(path.join(tmpdir(), 'creative-sidecar-contract-'));
  try {
    createProvisionFixture(root);
    const valid = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { encoding: 'utf8', timeout: 20_000 });
    if (valid.error?.code === 'EPERM') {
      console.warn('PowerShell child process blocked by the current sandbox; rerun litellm-sidecar.test.mjs in an external Windows sandbox.');
    } else {
    assert.notEqual(valid.status, 0, 'dummy runtime must fail without reaching a real model');
    const statusPath = path.join(root, 'storage', 'run', 'company-sidecar-status.json');
    const validStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(validStatus.status, 'failed');
    assert.notEqual(validStatus.code, 'provision_invalid', 'valid UTF-8 v2 state must pass provisioning validation');
    const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.equal(validStatus.schemaVersion, 2);
    assert.deepEqual(Object.keys(validStatus).sort(), ['code', 'reason', 'requestId', 'schemaVersion', 'status', 'updatedAt'].sort());
    assert.match(validStatus.requestId, requestIdPattern);
    const inheritedRequestId = '123e4567-e89b-42d3-a456-426614174000';
    const inherited = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { env: { ...process.env, CREATIVE_STUDIO_SIDECAR_REQUEST_ID: inheritedRequestId }, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(inherited.status, 0);
    const inheritedStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(inheritedStatus.schemaVersion, 2);
    assert.equal(inheritedStatus.requestId, inheritedRequestId);
    const invalidRequestId = 'not-a-canonical-request-id';
    const invalidInherited = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { env: { ...process.env, CREATIVE_STUDIO_SIDECAR_REQUEST_ID: invalidRequestId }, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(invalidInherited.status, 0);
    const invalidStatus = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(invalidStatus.schemaVersion, 2);
    assert.match(invalidStatus.requestId, requestIdPattern);
    assert.notEqual(invalidStatus.requestId, invalidRequestId);

    // PowerShell must reject the old public lock-bypass switch before the
    // controller can touch a sentinel stack/status file.
    const sentinelStack = {
      sidecarKind: 'company-litellm',
      runtimeRelativePath: 'runtime-litellm\\python.exe',
      configRelativePath: 'config.yaml',
      proxyPort: 4000,
      litellmPid: 2147483647,
    };
    const stackPath = path.join(root, 'storage', 'run', 'stack.json');
    writeJson(stackPath, sentinelStack);
    const sentinelStackBytes = readFileSync(stackPath);
    const sentinelStatusBytes = Buffer.from('{"schemaVersion":1,"status":"sentinel","code":"sentinel","reason":"sentinel","updatedAt":"2026-08-06T00:00:00.000Z"}\n', 'utf8');
    writeFileSync(statusPath, sentinelStatusBytes);
    const nakedStart = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root, '-SkipStartLock'], { encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(nakedStart.status, 0, 'naked -SkipStartLock must be rejected by parameter binding');
    assert.deepEqual(readFileSync(stackPath), sentinelStackBytes, 'rejected start bypass must not touch stack bytes');
    assert.deepEqual(readFileSync(statusPath), sentinelStatusBytes, 'rejected start bypass must not touch status bytes');
    const nakedStop = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(stopPath), '-Root', root, '-SkipStartLock'], { encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(nakedStop.status, 0, 'stop must reject a naked -SkipStartLock too');
    assert.deepEqual(readFileSync(stackPath), sentinelStackBytes, 'rejected stop bypass must not touch stack bytes');
    assert.deepEqual(readFileSync(statusPath), sentinelStatusBytes, 'rejected stop bypass must not touch status bytes');

    const cases = [
      ['schema string', { schemaVersion: '2' }],
      ['profile whitespace', { profileName: ' bad' }],
      ['profile control', { profileName: 'bad\u0001' }],
      ['profile too long', { profileName: 'x'.repeat(129) }],
      ['scalar image', { managedProviders: { image: 'company-image', script: ['company-script'], video: ['company-video'], tts: ['doubao-seed-tts-2'] } }],
      ['duplicate video', { managedProviders: { image: ['company-image'], script: ['company-script'], video: ['company-video', 'company-video'], tts: ['doubao-seed-tts-2'] } }],
      ['uppercase id', { managedProviders: { image: ['Company-image'], script: ['company-script'], video: ['company-video'], tts: ['doubao-seed-tts-2'] } }],
      ['long id', { managedProviders: { image: ['x'.repeat(65)], script: ['company-script'], video: ['company-video'], tts: ['doubao-seed-tts-2'] } }],
      ['tts case', { managedProviders: { image: ['company-image'], script: ['company-script'], video: ['company-video'], tts: ['Doubao-seed-tts-2'] } }],
    ];
    for (const [label, overrides] of cases) {
      rmSync(path.join(root, 'storage'), { recursive: true, force: true });
      createProvisionFixture(root, overrides);
      const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { encoding: 'utf8', timeout: 20_000 });
      assert.notEqual(result.status, 0, `${label} must fail closed`);
      const status = JSON.parse(readFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8'));
      assert.equal(status.code, 'provision_invalid', `${label} must publish provision_invalid`);
    }

    const oversizedConfig = Buffer.alloc(512 * 1024 + 1, 0x41);
    rmSync(path.join(root, 'storage'), { recursive: true, force: true });
    createProvisionFixture(root, {}, oversizedConfig);
    const oversized = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Root', root], { encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(oversized.status, 0);
    const oversizedStatus = JSON.parse(readFileSync(path.join(root, 'storage', 'run', 'company-sidecar-status.json'), 'utf8'));
    assert.equal(oversizedStatus.code, 'provision_invalid');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('litellm-sidecar tests passed');
