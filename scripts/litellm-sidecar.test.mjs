import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => accessSync(path);

const builderPath = 'scripts/build-litellm-sidecar.ps1';
const buildPath = 'scripts/build-win-installer.ps1';
const startPath = 'installer/windows/start-company-sidecar.ps1';
const stopPath = 'installer/windows/stop-company-sidecar.ps1';
const launcherPath = 'installer/windows/launcher.cs';
const allPowerShell = [
  builderPath,
  buildPath,
  startPath,
  stopPath,
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

const start = read(startPath);
assert.match(start, /config\.yaml/);
assert.match(start, /runtime-litellm\\python\.exe/);
assert.match(start, /data\\provisioning\\runtime\.env/);
assert.match(start, /data\\provisioning\\state\.json/);
assert.match(start, /127\.0\.0\.1/);
assert.match(start, /litellm\.proxy\.proxy_cli/);
assert.match(start, /--telemetry false/);
assert.match(start, /--num_workers 1/);
assert.doesNotMatch(start, /--debug/);
assert.match(start, /health\/liveliness/);
assert.match(start, /sidecarKind\s*=\s*'company-litellm'/);
assert.match(start, /UTF8Encoding\]::new\(\$false\)/);
assert.match(start, /AllowedRuntimeEnvKeys/);
assert.match(start, /CREATIVE_STUDIO_GATEWAY_API_KEY/);
assert.match(start, /COMPANY_GATEWAY_API_KEY/);
assert.match(start, /GATEWAY_API_KEY/);
assert.match(start, /CREATIVE_STUDIO_COS_SECRET_KEY/);
assert.match(start, /ConvertFrom-Json/);
assert.match(start, /Get-FileHash/);
assert.match(start, /configHash/);
assert.match(start, /Test-ProvisionedConfigState/);
assert.match(start, /Test-ProxyListenerOwnedByProcess/);
assert.match(start, /RuntimeEnvValueMaxChars/);
assert.match(start, /RuntimeEnvMaxBytes/);
assert.match(start, /RedirectStandardOutput/);
assert.match(start, /RedirectStandardError/);
assert.match(start, /Start-Process/);
assert.doesNotMatch(start, /BeginOutputReadLine|BeginErrorReadLine|add_OutputDataReceived|add_ErrorDataReceived/);
assert.match(start, /IndexOf\('litellm\.proxy\.proxy_cli'/);
assert.match(start, /yyyy-MM-ddTHH:mm:ss/);
assert.doesNotMatch(start, /UtcNow\.ToString\('o'\)/);
assert.doesNotMatch(start, /CREATIVE_STUDIO_COS_SECRET_KEY\s*=\s*[^\r\n]/i);

const stop = read(stopPath);
assert.match(stop, /Win32_Process/);
assert.match(stop, /ExecutablePath/);
assert.match(stop, /litellm\.proxy\.proxy_cli/);
assert.match(stop, /--config/);
assert.match(stop, /--host 127\.0\.0\.1/);
assert.match(stop, /IndexOf\('litellm\.proxy\.proxy_cli'/);
assert.doesNotMatch(stop, /Contains\([^\n]+StringComparison/);
assert.doesNotMatch(stop, /Get-Process\s+python/i);
assert.doesNotMatch(stop, /Get-NetTCPConnection/);

const installedStart = read('installer/windows/start-installed.ps1');
assert.match(installedStart, /\$sidecarArguments\s*=.*-File `"\$sidecarStartScript`".*-Root `"\$Root`"/);
assert.match(installedStart, /-ArgumentList \$sidecarArguments/);

const launcher = read(launcherPath);
const sidecarStart = launcher.indexOf('StartCompanySidecar(storageBase)');
const portCheck = launcher.indexOf('IsPortListening(port)');
assert.ok(sidecarStart >= 0 && portCheck > sidecarStart, 'sidecar must be launched before the app port check');
assert.match(launcher, /start-company-sidecar\.ps1/);
assert.match(launcher, /Process\.Start\(psi\)/);
assert.match(launcher, /CreateNoWindow\s*=\s*true/);
assert.doesNotMatch(launcher, /WaitForExit/);

console.log('litellm-sidecar tests passed');
