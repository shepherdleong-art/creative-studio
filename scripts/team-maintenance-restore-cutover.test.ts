import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-cutover-'));
const source = path.join(fixture, 'source');
const restored = path.join(fixture, 'restored');
const retained = path.join(fixture, 'protected-old-root');
const service = path.join(fixture, 'service');
fs.mkdirSync(source, { recursive: true });
fs.mkdirSync(restored, { recursive: true });
fs.mkdirSync(service, { recursive: true });
const { cutoverTeamRestore, readTeamRestoreActivity } = await import('../lib/team-service/maintenance/restore-cutover.ts');

try {
  assert.equal(fs.existsSync(path.join(source, 'marker')), false);
  fs.writeFileSync(path.join(source, 'marker'), 'newer-business-data');
  fs.writeFileSync(path.join(restored, 'marker'), 'selected-restore-point');
  fs.mkdirSync(path.join(restored, 'storage', 'maintenance'), { recursive: true });
  fs.writeFileSync(path.join(restored, 'storage', 'maintenance', 'restore-hold.json'), JSON.stringify({
    schemaVersion: 1, kind: 'team-restore-hold', backupId: 'backup-a', createdAt: new Date().toISOString(),
    scheduling: false, automaticRetries: false, reason: 'restore_reconciliation_required',
  }));
  const activity = await cutoverTeamRestore({
    serviceRoot: service, activeDataRoot: source, restoredDataRoot: restored,
    protectedDataRoot: retained,
    deploymentId: 'deployment-13', operationId: 'restore-operation-13', backupId: 'backup-a',
  });
  assert.equal(activity.activeDataRoot, restored);
  assert.equal(activity.protectedDataRoots[0], retained);
  assert.equal(activity.protectedDataRoots[0].includes(source), false, '页面仅接收受管副本路径，活动身份由受管指针维护');
  assert.equal(fs.readFileSync(path.join(retained, 'marker'), 'utf8'), 'newer-business-data');
  assert.equal(fs.readFileSync(path.join(restored, 'marker'), 'utf8'), 'selected-restore-point');
  assert.equal(fs.existsSync(source), false);
  assert.equal((await readTeamRestoreActivity(service)).state, 'switched');

  fs.mkdirSync(source, { recursive: true });
  const failedRestored = path.join(fixture, 'failed-operation', 'restored');
  fs.cpSync(restored, failedRestored, { recursive: true });
  fs.writeFileSync(path.join(source, 'marker'), 'newer-business-data');
  await assert.rejects(() => cutoverTeamRestore({
    serviceRoot: path.join(fixture, 'failed-service'), activeDataRoot: source, restoredDataRoot: failedRestored,
    protectedDataRoot: path.join(fixture, 'failed-operation', 'protected-old-root'),
    deploymentId: 'deployment-13', operationId: 'restore-operation-failed', backupId: 'backup-a',
    activate: async () => { throw new Error('injected activation failure'); },
  }), /activation failure/);
  const failed = await readTeamRestoreActivity(path.join(fixture, 'failed-service'));
  assert.equal(failed.activeDataRoot, source, '激活失败必须保留原活动根');
  assert.equal(failed.state, 'failed');
  assert.equal(fs.readFileSync(path.join(source, 'marker'), 'utf8'), 'newer-business-data');
  assert.equal(failed.recovery.preRestoreBackupId, 'backup-a');
  console.log('team maintenance controlled restore cutover tests passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
