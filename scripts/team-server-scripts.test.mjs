import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptRoot = path.join(root, 'scripts', 'team-server');
const scripts = ['generate-config.ps1', 'install.ps1', 'status.ps1', 'stop.ps1', 'preflight.ps1'];

function validConfig(directory) {
  return {
    schemaVersion: 1,
    deploymentId: 'studio-prod',
    releaseId: 'test-release',
    deploymentRoot: path.join(directory, 'new-deployment'),
    dataRoot: path.join(directory, 'new-data'),
    backupRoot: path.join(directory, 'new-backup'),
    oldRoots: [path.join(directory, 'old-workbench')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudio',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: true,
    stopTimeoutSeconds: 240,
  };
}

function invoke(script, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptRoot, script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}

test('bootstrap returns one executable path even when an explicit runtime is selected', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '. $env:BOOTSTRAP_HELPER; $node = Get-TeamBootstrapNode -ConfigPath "missing.json"; if ($node -isnot [string]) { throw "Expected executable path" }; & $node --version; exit $LASTEXITCODE',
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env,
    BOOTSTRAP_HELPER: path.join(scriptRoot, 'common.ps1'), CREATIVE_STUDIO_TEAM_NODE: process.execPath,
  } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^v\d+\./);
});

test('所有团队服务 PS1 为 UTF-8 BOM 且可由 PowerShell 5.1 解析', { skip: process.platform !== 'win32' }, () => {
  for (const name of scripts) {
    const file = path.join(scriptRoot, name);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 缺 BOM`);
    const parsed = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      "$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:SCRIPT_TO_PARSE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}",
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SCRIPT_TO_PARSE: file } });
    assert.equal(parsed.status, 0, `${name}: ${parsed.stdout}${parsed.stderr}`);
  }
});

test('install/status/stop 默认 dry-run，不创建新根、凭据、服务或防火墙', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-scripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = validConfig(directory);
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  for (const name of ['install.ps1', 'status.ps1', 'stop.ps1']) {
    const result = invoke(name, ['-ConfigPath', configPath, '-DeploymentId', 'studio-prod']);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(output.dryRun, true, name);
    assert.equal(output.applyPerformed, false, name);
    assert.equal(output.deploymentId, 'studio-prod', name);
    assert.equal(result.stdout.includes('fixture-control-token'), false);
  }
  assert.equal(fs.existsSync(config.deploymentRoot), false);
  assert.equal(fs.existsSync(config.dataRoot), false);
  assert.equal(fs.existsSync(config.backupRoot), false);
});

test('显式 DeploymentId 不匹配、根重叠和链接路径在 apply 前 fail closed', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-script-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(validConfig(directory)));
  for (const name of ['install.ps1', 'status.ps1', 'stop.ps1']) {
    const result = invoke(name, ['-ConfigPath', configPath, '-DeploymentId', 'other-deployment']);
    assert.notEqual(result.status, 0, name);
    assert.doesNotMatch(result.stdout + result.stderr, /token|secret|password/i);
  }
  const invalid = validConfig(directory);
  invalid.dataRoot = path.join(invalid.oldRoots[0], 'nested');
  fs.writeFileSync(configPath, JSON.stringify(invalid));
  const overlap = invoke('install.ps1', ['-ConfigPath', configPath]);
  assert.notEqual(overlap.status, 0);
  assert.equal(fs.existsSync(invalid.deploymentRoot), false);
});

test('apply 分支只认领精确服务路径，app 先于独立代理停机，网络变更受 Apply 门禁', () => {
  const install = fs.readFileSync(path.join(scriptRoot, 'install.ps1'), 'utf8').replace(/^\uFEFF/, '')
    + fs.readFileSync(path.join(scriptRoot, 'common.ps1'), 'utf8').replace(/^\uFEFF/, '')
    + fs.readFileSync(path.join(scriptRoot, 'generate-config.mjs'), 'utf8');
  const stop = fs.readFileSync(path.join(scriptRoot, 'stop.ps1'), 'utf8').replace(/^\uFEFF/, '');
  for (const required of ['Win32_Service', 'PathName', 'OrdinalIgnoreCase', 'New-NetFirewallRule', 'control-credential.json', 'Get-FileHash', 'serviceLogDirectory', '/api/team/health/ready', 'install-state.json']) {
    assert.ok(install.includes(required), `install 缺 ${required}`);
  }
  assert.match(install, /if \(-not \$Apply\)[\s\S]*exit 0[\s\S]*Set-TeamFirewall -Resolved/);
  assert.doesNotMatch(install, /Stop-Service|taskkill|stop-stack|stop-litellm/);
  assert.match(stop, /service-control\.mjs/);
  assert.ok(stop.indexOf('service-control.mjs') < stop.indexOf("foreach ($role in @('litellm', 'maintenance', 'caddy'))"),
    '应用优雅停机必须先于独立依赖 SCM 停止');
  assert.match(stop, /if \(-not \$Apply\)[\s\S]*exit 0[\s\S]*service-control\.mjs/);
  assert.doesNotMatch(stop, /taskkill\s+\/IM|Get-Process\s+-Name/);
});
