import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptRoot = path.join(root, 'scripts', 'team-server');
const scripts = ['backup.ps1', 'restore.ps1', 'release.ps1'];

function config(directory) {
  return {
    schemaVersion: 1,
    deploymentId: 'studio-maintenance',
    releaseId: 'old-release',
    deploymentRoot: path.join(directory, 'deployment'),
    dataRoot: path.join(directory, 'data'),
    backupRoot: path.join(directory, 'backup'),
    oldRoots: [path.join(directory, 'old')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudioMaintenance',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: false,
    stopTimeoutSeconds: 240,
  };
}

function invoke(script, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptRoot, script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}

test('backup/restore/release PS1 均有 BOM 且通过 PowerShell 5.1 解析', { skip: process.platform !== 'win32' }, () => {
  for (const name of scripts) {
    const file = path.join(scriptRoot, name);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], name);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      "$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:SCRIPT_TO_PARSE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}",
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SCRIPT_TO_PARSE: file } });
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
});

test('维护脚本默认 dry-run，不创建部署、数据、备份或恢复根', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-scripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = config(directory);
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(value));
  const restoreRoot = path.join(directory, 'restore');
  const calls = [
    ['backup.ps1', ['-ConfigPath', configPath, '-DeploymentId', value.deploymentId, '-Type', 'daily']],
    ['restore.ps1', ['-ConfigPath', configPath, '-DeploymentId', value.deploymentId, '-BackupId', 'backup-1', '-BackupType', 'manual', '-RestoreRoot', restoreRoot]],
    ['release.ps1', ['-ConfigPath', configPath, '-DeploymentId', value.deploymentId, '-NewReleaseId', 'new-release', '-OperationId', 'release-1']],
    ['release.ps1', ['-ConfigPath', configPath, '-DeploymentId', value.deploymentId, '-NewReleaseId', 'old-release', '-OperationId', 'rollback-1', '-Mode', 'compatible-rollback']],
    ['release.ps1', ['-ConfigPath', configPath, '-DeploymentId', value.deploymentId, '-NewReleaseId', 'old-release', '-OperationId', 'rollback-2', '-Mode', 'restore-rollback', '-BackupId', 'backup-1', '-BackupType', 'pre-upgrade', '-RestoreRoot', restoreRoot]],
  ];
  for (const [name, args] of calls) {
    const result = invoke(name, args);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(output.dryRun, true, name);
    assert.equal(output.applyPerformed, false, name);
    assert.equal(output.deploymentId, value.deploymentId);
    assert.doesNotMatch(result.stdout + result.stderr, /token|secret|password|api.?key/i);
  }
  for (const target of [value.deploymentRoot, value.dataRoot, value.backupRoot, restoreRoot]) {
    assert.equal(fs.existsSync(target), false, target);
  }
});

test('打包后的维护入口从 current release 定位真实 runner', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-runner-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deploymentRoot = path.join(directory, 'deployment');
  const serviceRoot = path.join(deploymentRoot, 'service');
  const oldRunner = path.join(deploymentRoot, 'releases', 'old-release', 'app', 'scripts', 'team-server', 'maintenance.mjs');
  const newRunner = path.join(deploymentRoot, 'releases', 'new-release', 'app', 'scripts', 'team-server', 'maintenance.mjs');
  for (const runner of [oldRunner, newRunner]) {
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, '// fixture\n');
  }
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, 'current-release.json'), JSON.stringify({ releaseId: 'new-release' }));
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    '. $env:TEAM_COMMON; $resolved = $env:TEAM_RESOLVED | ConvertFrom-Json; Get-TeamMaintenanceRunner -Resolved $resolved',
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: {
      ...process.env,
      TEAM_COMMON: path.join(scriptRoot, 'common.ps1'),
      TEAM_RESOLVED: JSON.stringify({
        deploymentRoot, serviceRoot,
        releaseRoot: path.join(deploymentRoot, 'releases', 'old-release'),
      }),
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), newRunner);
});

test('Apply 只调用维护 runner，PS 不复制 SQL 或 manifest 算法', () => {
  for (const name of scripts) {
    const source = fs.readFileSync(path.join(scriptRoot, name), 'utf8');
    assert.match(source, /Get-TeamMaintenanceRunner/);
    assert.match(source, /if \(-not \$Apply\)/);
    assert.doesNotMatch(source, /better-sqlite3|CREATE TABLE|PRAGMA|sha256|Get-FileHash/i);
  }
});
