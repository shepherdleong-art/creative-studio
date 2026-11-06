import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schemaUpgradeRuntimePaths } from '../lib/schema-upgrade/runtime.ts';
import { checkTeamServiceReadiness } from '../lib/team-service/readiness.ts';
import { checkExecutionReadiness } from '../lib/media-core/execution/readiness.ts';
import { runMaintenanceWorker } from '../lib/team-service/maintenance/worker.ts';
import { MaintenanceJobStore } from '../lib/team-service/maintenance/jobs.ts';
import { TEAM_RELEASE_STAGES } from '../lib/team-service/maintenance/release.ts';
import { teamMaintenanceStatePath } from '../lib/team-service/maintenance/state.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-execution-'));
const backupRoot = path.join(root, 'backup');
const dataRoot = path.join(root, 'data');
const deploymentRoot = path.join(root, 'deployment');
const deploymentId = 'isolated-release';
const configPath = path.join(deploymentRoot, 'config', 'maintenance-deployment.json');
const candidateId = 'a'.repeat(64);

fs.mkdirSync(path.dirname(path.join(dataRoot, 'data', 'workbench.db')), { recursive: true });
const db = new Database(path.join(dataRoot, 'data', 'workbench.db'));
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ backupRoot, deploymentId }));
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
try {
  db.pragma('foreign_keys = ON');
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) })).available, true);
  db.prepare("UPDATE team_service_state SET maintenance = 0, reason = '' WHERE id = 1").run();
  const store = new MaintenanceJobStore({ backupRoot, deploymentId });
  const submitted = store.submit({
    action: 'release.execute', target: { kind: 'release', candidateId },
    principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
    idempotencyKey: 'confirmed-release-001',
  });
  const calls: string[] = [];
  const completedStages: string[] = [];
  const adapters = {
    async preflight() { calls.push('preflight'); },
    async enterMaintenance() { calls.push('maintenance'); db.prepare('UPDATE team_service_state SET maintenance = 1 WHERE id = 1').run(); },
    async drainInflight() { calls.push('drain'); return { pendingTasks: 0, unknownAttemptIds: ['attempt-unknown'] }; },
    async captureExecution() { calls.push('capture'); return { evidenceSha256: 'c'.repeat(64), operationCount: 1 }; },
    async stopOldInstance() { calls.push('stop'); return { deploymentId, instanceId: 'owned-instance', stopped: true, residualPids: [] }; },
    async createPreUpgradeBackup() { calls.push('backup'); return { backupId: 'verified-before-switch', verified: true }; },
    async switchRelease() { calls.push('switch'); },
    async startMaintenance() { calls.push('start-maintenance'); },
    async migrate() { calls.push('migrate'); },
    async selfCheck() { calls.push('self-check'); return { available: true, automaticRetries: 0 }; },
    async resume() { calls.push('resume'); db.prepare('UPDATE team_service_state SET maintenance = 0 WHERE id = 1').run(); },
  };
  try {
    await runMaintenanceWorker({
      configPath, once: true,
      makeBackup: async () => { throw new Error('not a backup'); },
      executeRelease: async ({ job, onStage }) => {
        assert.equal(job.id, submitted.job.id);
        assert.deepEqual(job.target, { kind: 'release', candidateId });
        assert.equal(job.requestedBy.displayName, '真实管理员');
        const { runTeamRelease } = await import('../lib/team-service/maintenance/release.ts');
        const result = await runTeamRelease({
          operationId: job.id, deploymentId, backupRoot, stateDirectory: path.dirname(teamMaintenanceStatePath(backupRoot, deploymentId, job.id)),
          fromRelease: { releaseId: 'old-release', packageSha256: 'b'.repeat(64) },
          toRelease: { releaseId: 'new-release', packageSha256: 'c'.repeat(64) }, adapters,
        });
        for (const stage of result.completedStages) {
          completedStages.push(stage);
          onStage(stage);
        }
        return result as unknown as Record<string, unknown>;
      },
    });
    const job = store.get(submitted.job.id).job;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.stage, 'completed');
    assert.equal(job.result?.currentStage, 'done');
    assert.equal(job.result?.preUpgradeBackupId, 'verified-before-switch');
    assert.deepEqual(job.result?.unknownAttemptIds, ['attempt-unknown']);
    assert.deepEqual(completedStages, [...TEAM_RELEASE_STAGES]);
    assert.ok(store.audit(job.id).some((event) => event.event === 'migrate'));
    const persisted = JSON.parse(fs.readFileSync(teamMaintenanceStatePath(backupRoot, deploymentId, job.id), 'utf8'));
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.maintenance, false);
    const conflict = store.submit({
      action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'after-release-00001',
    });
    assert.ok(conflict.job.id);
    await runMaintenanceWorker({ configPath, once: true, makeBackup: async () => ({ backupId: 'later-backup', type: 'manual', verifiedAt: new Date().toISOString(), totalBytes: 0 }) });
    console.log('team release worker stage and persistence tests passed');

    const interrupted = store.submit({
      action: 'release.execute', target: { kind: 'release', candidateId: 'd'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'worker-interruption-001',
    });
    const interruptedState = {
      schemaVersion: 1, operationId: interrupted.job.id, deploymentId, inputHash: 'different',
      status: 'running', maintenance: true, currentStage: 'migrate', completedStages: [],
      fromRelease: { releaseId: 'old-release', packageSha256: 'b'.repeat(64) },
      toRelease: { releaseId: 'new-release', packageSha256: 'c'.repeat(64) }, unknownAttemptIds: [], updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(teamMaintenanceStatePath(backupRoot, deploymentId, interrupted.job.id)), { recursive: true });
    fs.writeFileSync(teamMaintenanceStatePath(backupRoot, deploymentId, interrupted.job.id), JSON.stringify(interruptedState));
    store.claimNext({ workerId: 'first-worker' });
    let recoveryRuns = 0;
    await runMaintenanceWorker({
      configPath, once: true,
      makeBackup: async () => { throw new Error('not a backup'); },
      executeRelease: async ({ job, workerId }) => {
        recoveryRuns += 1;
        assert.equal(job.id, interrupted.job.id);
        assert.notEqual(workerId, 'first-worker');
        return { status: 'completed', maintenance: false };
      },
    });
    assert.equal(recoveryRuns, 1);
    assert.equal(store.get(interrupted.job.id).job.status, 'succeeded');
    console.log('team release worker interruption resumes the same durable job');

    const failed = store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'e'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' }, idempotencyKey: 'failure-original-001' });
    const failedJobId = failed.job.id;
    const failureAdapters = {
      ...adapters,
      async selfCheck() { calls.push('failed-self-check'); return { available: false, automaticRetries: 0 }; },
    };
    await assert.rejects(() => runMaintenanceWorker({
      configPath, jobId: failedJobId, once: true,
      makeBackup: async () => { throw new Error('not a backup'); },
      executeRelease: async ({ job, onStage }) => {
        assert.equal(job.id, failedJobId);
        const { runTeamRelease } = await import('../lib/team-service/maintenance/release.ts');
        const result = await runTeamRelease({
          operationId: job.id, deploymentId, backupRoot,
          stateDirectory: path.dirname(teamMaintenanceStatePath(backupRoot, deploymentId, job.id)),
          fromRelease: { releaseId: 'old-release', packageSha256: 'b'.repeat(64) },
          toRelease: { releaseId: 'new-release', packageSha256: 'c'.repeat(64) },
          adapters: failureAdapters, onStage: (stage) => onStage(stage),
        });
        return result as unknown as Record<string, unknown>;
      },
    }), /维护态自检未通过/, '真实自检失败必须进入受控失败路径');
    const failureResult = store.get(failedJobId).job.result as Record<string, unknown>;
    assert.equal(failureResult.currentStage, 'self_check');
    assert.equal((failureResult.actualRelease as { releaseId: string }).releaseId, 'new-release');
    assert.equal((failureResult.recovery as { automaticRollbackAllowed: boolean }).automaticRollbackAllowed, false);
    const retried = store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'e'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'failure-retry-0001', retryRelease: true });
    assert.equal(retried.job.id, failedJobId);
    assert.equal(retried.job.status, 'queued');
    assert.equal(retried.job.result?.currentStage, failureResult.currentStage, '续跑不得丢失失败阶段与实际版本恢复证据');
    assert.deepEqual(retried.job.result?.actualRelease, failureResult.actualRelease);
    assert.equal(store.audit(failedJobId).find((event) => event.event === 'retry_requested')?.details?.previousResult !== undefined, true, '续跑审计保留前次结果证据');
    assert.equal(store.audit(failedJobId).some((event) => event.event === 'retry_requested'), true);
    assert.equal(store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'e'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'failure-retry-0001', retryRelease: true }).job.id, failedJobId);
    assert.equal(store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'e'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'failure-retry-0001', retryRelease: true }).job.id, failedJobId);
    console.log('failed release retry preserves job identity and history');
    await runMaintenanceWorker({ configPath, jobId: failedJobId, once: true,
      makeBackup: async () => { throw new Error('not a backup'); } });
    const recoveredFailure = store.get(failedJobId).job;
    assert.equal(recoveredFailure.status, 'failed');
    assert.deepEqual(recoveredFailure.result, failureResult, '崩溃恢复也不得丢弃失败升级证据');
    const retryConflictFixture = store.submit({ action: 'backup.create', target: { kind: 'backup', backupType: 'manual' },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' }, idempotencyKey: 'retry-conflict-fixture' });
    assert.throws(() => store.submit({ action: 'release.execute', target: { kind: 'release', candidateId: 'e'.repeat(64) },
      principal: { userId: 'real-admin', employeeId: '00042', displayName: '真实管理员', role: 'admin' },
      idempotencyKey: 'failure-retry-conflict', retryRelease: true }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'maintenance_conflict');
    assert.equal(store.get(failedJobId).job.status, 'failed');
    store.claimNext({ workerId: 'conflict-worker', jobId: retryConflictFixture.job.id });
    store.complete({ jobId: retryConflictFixture.job.id, workerId: 'conflict-worker', result: { backupId: 'conflict-fixture-done' } });
  } finally { store.close(); }
} finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
