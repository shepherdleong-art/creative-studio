import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MaintenanceJobStore } from '../lib/team-service/maintenance/jobs.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-worker-process-'));
const backupRoot = path.join(root, 'backup');
const deploymentRoot = path.join(root, 'deployment');
const deploymentId = 'isolated-process';
const config = path.join(deploymentRoot, 'config', 'maintenance-deployment.json');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, JSON.stringify({ backupRoot, deploymentId }));
const store = new MaintenanceJobStore({ backupRoot, deploymentId });
try {
  const submitted = store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'a'.repeat(64) },
    principal: { userId: 'admin', employeeId: '00042', displayName: '管理员', role: 'admin' }, idempotencyKey: 'external-interruption' });
  const marker = path.join(root, 'started');
  const child = spawn(process.execPath, ['scripts/team-release-worker-interruption.mjs', config, 'stop', marker], { stdio: 'ignore', windowsHide: true });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.readFileSync(marker, 'utf8'), submitted.job.id);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      const stopped = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      assert.equal(stopped.status, 0, '测试必须结束自己启动的隔离 worker');
    } else child.kill('SIGKILL');
    await exited;
  }
  const before = store.get(submitted.job.id).job;
  assert.equal(before.status, 'running');
  const resumed = spawn(process.execPath, ['scripts/team-release-worker-interruption.mjs', config, 'finish'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = ''; resumed.stderr.on('data', (data) => { stderr += String(data); });
  const code = await new Promise((resolve) => resumed.once('exit', resolve));
  assert.equal(code, 0, stderr);
  const after = store.get(submitted.job.id).job;
  assert.equal(after.status, 'succeeded');
  assert.equal(after.result.sameJobId, submitted.job.id);
  assert.ok(store.audit(submitted.job.id).some((record) => record.event === 'resumed'));
  assert.ok(store.audit(submitted.job.id).every((record) => record.actor.displayName === '管理员'));
  console.log('external maintenance worker resumes the same job after process termination');
} finally {
  store.close(); fs.rmSync(root, { recursive: true, force: true });
}
