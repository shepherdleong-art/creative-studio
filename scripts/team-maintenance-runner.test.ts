import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { writeReleaseManifest } from './team-server/distribution.mjs';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-runner-'));
const deploymentRoot = path.join(fixture, 'deployment');
const dataRoot = path.join(fixture, 'data');
const backupRoot = path.join(fixture, 'backup');
const releaseRoot = path.join(deploymentRoot, 'releases', 'release-1');
const deploymentId = 'deployment-runner';
const configPath = path.join(fixture, 'deployment.json');
const runner = path.resolve('scripts/team-server/maintenance.mjs');
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const databases = new Set<Database.Database>();

function write(relative: string, content: string): string {
  const file = path.join(releaseRoot, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeFixtureRelease(): void {
  write('app/server.js', '// fixture\n');
  write('runtime/process-tree.mjs', '// fixture\n');
  const node = write('runtimes/node/node.exe', 'fixture node');
  const caddy = write('tools/caddy/caddy.exe', 'fixture caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'fixture winsw');
  const lock = JSON.parse(fs.readFileSync(path.resolve('scripts/team-server/distribution-lock.json'), 'utf8')) as {
    fixture: boolean; media: unknown[];
    node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
  };
  lock.fixture = true;
  lock.media = [];
  lock.node.binarySha256 = sha256(node);
  lock.caddy.binarySha256 = sha256(caddy);
  lock.winsw.sha256 = sha256(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync(path.resolve('scripts/packaging/forbidden-paths.json'), 'utf8'));
  writeReleaseManifest(releaseRoot, { releaseId: 'release-1', appVersion: '0.7.1', sourceCommit: 'fixture', fixture: true });
}

function invoke(...args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', windowsHide: true, timeout: 120_000,
    env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: dataRoot },
  });
}

try {
  makeFixtureRelease();
  const config = {
    schemaVersion: 1,
    deploymentId,
    releaseId: 'release-1',
    deploymentRoot,
    dataRoot,
    backupRoot,
    oldRoots: [path.join(fixture, 'old')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudioRunner',
    serviceAccount: 'NT AUTHORITY\\NetworkService',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: false,
    stopTimeoutSeconds: 240,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
  const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES ('admin', 'admin', 'Admin', 'admin', 'active', 'fixture', 0, 1, ?, ?)`).run(at, at);
  const journalDirectory = path.join(dataRoot, 'storage', 'execution-journal', deploymentId);
  fs.mkdirSync(journalDirectory, { recursive: true });

  const first = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-1', '--allow-fixture-release');
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  assert.equal(JSON.parse(first.stdout.trim()).status, 'success');
  const dailyJobPath = path.join(backupRoot, 'daily-job.json');
  let dailyJob = JSON.parse(fs.readFileSync(dailyJobPath, 'utf8'));
  assert.equal(dailyJob.status, 'success');
  assert.equal(dailyJob.backupId, 'daily-1');
  assert.ok(dailyJob.durationMs >= 0);
  assert.ok(dailyJob.totalBytes > 0);
  assert.ok(dailyJob.availableBytes > 0);
  assert.equal(dailyJob.latestRecoveryEvidence, null);
  assert.notDeepEqual([...fs.readFileSync(dailyJobPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const restoreRoot = path.join(fixture, 'restored');
  const restored = invoke('restore', '--config', configPath, '--backup-type', 'daily', '--backup-id', 'daily-1',
    '--restore-root', restoreRoot, '--allow-fixture-release');
  assert.equal(restored.status, 0, `${restored.stdout}${restored.stderr}`);
  const restoreResult = JSON.parse(restored.stdout.trim());
  assert.equal(restoreResult.status, 'reconciled');
  assert.equal(restoreResult.scheduling, false);
  assert.equal(restoreResult.automaticRetries, 0);
  assert.equal(fs.existsSync(path.join(restoreRoot, 'storage', 'maintenance', 'restore-hold.json')), true);

  const second = invoke('backup', '--config', configPath, '--type', 'daily', '--backup-id', 'daily-2', '--allow-fixture-release');
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  dailyJob = JSON.parse(fs.readFileSync(dailyJobPath, 'utf8'));
  assert.equal(dailyJob.backupId, 'daily-2');
  assert.equal(dailyJob.latestRecoveryEvidence.backupId, 'daily-1');
  assert.equal(dailyJob.latestRecoveryEvidence.evidenceStatus, 'complete');
  assert.doesNotMatch(first.stdout + first.stderr + restored.stdout + restored.stderr + second.stdout + second.stderr,
    /fixtureSecret|apiKey|Bearer\s+/i);
  console.log('team maintenance runner daily job and restore tests passed');
} finally {
  for (const db of databases) if (db.open) db.close();
  fs.rmSync(fixture, { recursive: true, force: true });
}
