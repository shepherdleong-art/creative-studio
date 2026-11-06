import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-jobs-'));
const backupRoot = path.join(fixture, 'backups');
const businessDatabase = path.join(fixture, 'data-root', 'data', 'workbench.db');
const {
  MaintenanceControlError,
  MaintenanceJobStore,
  maintenanceStorePaths,
} = await import('../lib/team-service/maintenance/jobs.ts');

try {
  const store = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-10' });
  const principal = {
    userId: 'real-admin-id', employeeId: '00042', displayName: '网页管理员', role: 'admin' as const,
  };
  const submitted = store.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal, idempotencyKey: 'browser-retry-0001', now: new Date('2026-11-06T04:00:00.000Z'),
  });
  assert.equal(submitted.job.status, 'queued');
  assert.equal(submitted.job.requestedBy.userId, 'real-admin-id');
  assert.equal(submitted.job.requestedBy.displayName, '网页管理员');
  assert.equal(submitted.created, true);

  const duplicate = store.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal, idempotencyKey: 'browser-retry-0001', now: new Date('2026-11-06T04:01:00.000Z'),
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, submitted.job.id);
  assert.equal(duplicate.job.createdAt, submitted.job.createdAt);

  assert.throws(() => store.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal, idempotencyKey: 'another-click', now: new Date('2026-11-06T04:02:00.000Z'),
  }), (error: unknown) => error instanceof MaintenanceControlError && error.code === 'maintenance_conflict');
  assert.equal(store.list().jobs.length, 1);

  const claimed = store.claimNext({ workerId: 'worker-a', now: new Date('2026-11-06T04:03:00.000Z') });
  assert.equal(claimed?.job.id, submitted.job.id);
  assert.equal(claimed?.job.status, 'running');
  assert.equal(claimed?.job.progress, null, '不可测备份阶段不得伪造百分比');
  store.updateStage({ jobId: submitted.job.id, workerId: 'worker-a', stage: 'copying_media', now: new Date('2026-11-06T04:03:01.000Z') });
  assert.throws(() => store.complete({
    jobId: submitted.job.id, workerId: 'wrong-worker', result: { backupId: 'manual-1', type: 'manual', verifiedAt: '2026-11-06T04:04:00.000Z', totalBytes: 100 },
  }), (error: unknown) => error instanceof MaintenanceControlError && error.code === 'worker_lease_lost');

  const completed = store.complete({
    jobId: submitted.job.id, workerId: 'worker-a', now: new Date('2026-11-06T04:04:00.000Z'),
    result: { backupId: 'manual-1', type: 'manual', verifiedAt: '2026-11-06T04:04:00.000Z', totalBytes: 100 },
  });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result?.backupId, 'manual-1');
  assert.equal(store.get(submitted.job.id).job.status, 'succeeded');

  const reopened = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-10' });
  assert.deepEqual(reopened.get(submitted.job.id).job, completed);
  assert.equal(reopened.audit(submitted.job.id).some((record) => record.event === 'submitted'), true);
  assert.equal(reopened.audit(submitted.job.id).at(-1)?.event, 'succeeded');
  assert.equal(reopened.audit(submitted.job.id)[0]?.actor.userId, 'real-admin-id');
  assert.equal(fs.existsSync(businessDatabase), false, '维护作业不得写入业务数据库');
  assert.equal(fs.existsSync(maintenanceStorePaths(backupRoot).database), true);
  const interrupted = reopened.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal, idempotencyKey: 'interrupted-job', now: new Date('2026-11-06T04:05:00.000Z'),
  });
  const claimedByA = reopened.claimNext({ workerId: 'worker-a', now: new Date('2026-11-06T04:05:01.000Z') });
  assert.equal(claimedByA?.job.id, interrupted.job.id);
  const otherWorker = new MaintenanceJobStore({ backupRoot, deploymentId: 'deployment-10' });
  assert.throws(() => otherWorker.claimNext({ workerId: 'worker-b', now: new Date('2026-11-06T04:05:02.000Z') }),
    (error: unknown) => error instanceof MaintenanceControlError && error.code === 'maintenance_conflict');
  const recovered = reopened.reconcile({ workerId: 'worker-b', now: new Date('2026-11-06T04:07:00.000Z') });
  assert.deepEqual(recovered.needsReviewJobIds, [interrupted.job.id]);
  assert.equal(reopened.get(interrupted.job.id).job.status, 'needs_review');
  assert.equal(reopened.get(interrupted.job.id).job.error?.code, 'execution_unknown');
  assert.equal(otherWorker.claimNext({ workerId: 'worker-b', now: new Date('2026-11-06T04:07:01.000Z') }), null);
  assert.throws(() => reopened.submit({
    action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
    principal, idempotencyKey: 'must-not-restart', now: new Date('2026-11-06T04:08:00.000Z'),
  }), (error: unknown) => error instanceof MaintenanceControlError && error.code === 'maintenance_review_required');
  assert.equal(reopened.audit(interrupted.job.id).at(-1)?.event, 'needs_review');
  assert.equal(reopened.audit(interrupted.job.id).at(-1)?.event, 'needs_review');
  assert.equal(reopened.get(interrupted.job.id).job.result, null);
  assert.equal(reopened.get(interrupted.job.id).job.progress, null);
  fs.appendFileSync(path.join(backupRoot, 'maintenance-control', 'audit.jsonl'), '{not-json}\n');
  assert.equal(reopened.get(submitted.job.id).job.integrity, 'audit_corrupt');
  assert.match(reopened.get(submitted.job.id).job.message ?? '', /核查/);
  assert.equal(reopened.get(submitted.job.id).job.status, 'succeeded', '保留数据库原状态，不擅自改写');
  reopened.close();
  otherWorker.close();
  store.close();
  console.log('team maintenance persistent jobs tests passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
