import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-maintenance-restore-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;
const deploymentId = 'deployment-restore';
const sourceRoot = path.join(fixtureRoot, 'source');
const storageRoot = path.join(sourceRoot, 'storage');
const backupRoot = path.join(fixtureRoot, 'backups');
fs.mkdirSync(path.join(sourceRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'media'), { recursive: true });
fs.writeFileSync(path.join(storageRoot, 'media', 'movie.bin'), 'real-media-fixture');
const configPath = path.join(fixtureRoot, 'protected.json');
fs.writeFileSync(configPath, '{"fixture":true}');

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerReadyTeamFile } = await import('../lib/team-service/files/registry.ts');
const { createTeamBackup } = await import('../lib/team-service/maintenance/backup.ts');
const { restoreTeamBackup, readTeamRestoreHold, releaseTeamRestoreHold } = await import('../lib/team-service/maintenance/restore.ts');
const { createTeamExecutionRuntime, createTeamServiceBootstrap } = await import('../lib/team-service/bootstrap.ts');
const { getTeamRuntimeState, resetTeamRuntimeStateForTests } = await import('../lib/team-service/runtime/state.ts');

const db = new Database(path.join(sourceRoot, 'data', 'workbench.db'));
const databases = new Set<Database.Database>([db]);
db.pragma('foreign_keys = ON');
const admin = { userId: 'admin', role: 'admin' as const };
const identity = { instanceId: 'source-instance', fence: 1 };
let remotePosts = 0;

function operation(taskId: string): EnqueueInput {
  return {
    operationKey: `images/${taskId}/submit/r1`, actor: { userId: 'admin' },
    scope: { resourceType: 'project', resourceId: 'project-1' },
    module: 'images', taskId, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${taskId}-business`, number: 1 },
    inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
    continuationKey: 'images.submit', providerSnapshot: { providerId: 'provider-a', model: 'model-a' },
    requiredPools: ['shared'], quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 100 }, pricingSnapshot: { version: 1 } },
  };
}

try {
  assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(sourceRoot) })).available, true);
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(sourceRoot) })).available, true);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
  ) VALUES ('admin', 'admin', 'Admin', 'admin', 'active', 'fixture', 0, 1, ?, ?)`).run(at, at);
  db.prepare(`INSERT INTO team_resource_scopes (
    resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt
  ) VALUES ('project', 'project-1', 'admin', 'project', 'project-1', ?, ?)`).run(at, at);
  const media = registerReadyTeamFile(db, {
    storageRoot, absolutePath: path.join(storageRoot, 'media', 'movie.bin'), mimeType: 'application/octet-stream',
    ownerUserId: 'admin', references: [{ resourceType: 'project', resourceId: 'project-1' }],
  });
  registerExecutionInstance(db, { ...identity, deploymentId });
  upsertExecutionPool(db, {
    poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true,
    mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
  });
  updateActorPolicy(db, { actorId: 'admin', monthlyLimitMinor: 500, personalConcurrency: 2, paused: false, expectedVersion: 0 });
  const journal = createExecutionJournal({
    deploymentId, directory: path.join(sourceRoot, 'storage', 'execution-journal', deploymentId),
  });
  const runtime = createExecutionFacade({
    db, deploymentId, journal, actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  });
  await runtime.lifecycle.start({ ...identity, deploymentId, signal: new AbortController().signal });

  runtime.facade.enqueue(operation('receipt-after'));
  const receiptAdmission = runtime.facade.admit({ ...identity, leaseMs: 0 });
  assert.equal(receiptAdmission.kind, 'admitted');
  if (receiptAdmission.kind !== 'admitted') throw new Error('receipt grant expected');
  const receiptIntent = await runtime.facade.markSubmitting({
    grant: receiptAdmission.grant, requestSnapshot: { fixture: 'receipt' },
  });
  runtime.facade.enqueue(operation('unknown-after'));
  const unknownAdmission = runtime.facade.admit({ ...identity, leaseMs: 0 });
  assert.equal(unknownAdmission.kind, 'admitted');
  if (unknownAdmission.kind !== 'admitted') throw new Error('unknown grant expected');
  await runtime.facade.markSubmitting({ grant: unknownAdmission.grant, requestSnapshot: { fixture: 'unknown' } });

  const backup = await createTeamBackup({
    db, principal: admin, dataRoot: sourceRoot, storageRoot, backupRoot, deploymentId, type: 'pre-upgrade',
    release: { releaseId: 'release-1', packageSha256: 'e'.repeat(64) },
    config: { version: 'config-1', filePath: configPath }, backupId: 'restore-source',
  });
  assert.equal(backup.manifest.journal.watermarkSeq, 2);
  await runtime.facade.transmit(receiptIntent, async () => {
    remotePosts += 1;
    return { remoteId: 'remote-receipt', terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 120 } };
  });
  assert.equal(remotePosts, 1);
  const sourceIntent = journal.scan().find((record) => record.eventType === 'submit_intent');
  assert.ok(sourceIntent);
  const terminalOrphan = {
    ...sourceIntent,
    operationId: 'orphan-operation-terminal', attemptId: 'orphan-attempt-terminal', permitId: 'orphan-permit-terminal',
    requestHash: 'orphan-request-terminal', transportSeq: 1,
  };
  journal.appendIntent(terminalOrphan);
  journal.appendReceipt({
    ...terminalOrphan, terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 30 },
    reconciliationSource: 'journal',
  });
  const originalJournal = fs.readFileSync(path.join(journal.directory, '000001.jsonl'), 'utf8');
  const originalDatabaseHash = (await import('node:crypto')).createHash('sha256')
    .update(fs.readFileSync(path.join(sourceRoot, 'data', 'workbench.db'))).digest('hex');

  const restoreRoot = path.join(fixtureRoot, 'restored');
  const restored = await restoreTeamBackup({
    backupDirectory: backup.directory, restoreRoot, deploymentId, expectedReleaseId: 'release-1',
    currentDb: db, currentJournalDirectory: journal.directory,
  });
  assert.equal(restored.scheduling, false);
  assert.equal(restored.automaticRetries, 0);
  assert.equal(restored.remoteCalls, 0);
  assert.equal(restored.evidenceStatus, 'complete');
  assert.equal(restored.journalWatermark, 2);
  assert.equal(restored.postWatermarkRecords, 3);
  assert.ok(restored.recoveredReceiptAttemptIds.includes(receiptAdmission.grant.attempt.id));
  assert.equal(restored.orphanAttemptIds.includes('orphan-attempt-terminal'), false,
    '已有终态回执的 journal 孤儿必须核清，不得永久 hold');
  assert.ok(restored.unknownAttemptIds.includes(unknownAdmission.grant.attempt.id));
  assert.equal(remotePosts, 1, '隔离恢复不得重新 POST');
  assert.equal(fs.readFileSync(path.join(journal.directory, '000001.jsonl'), 'utf8'), originalJournal);
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'storage', 'media', 'movie.bin'), 'utf8'), 'real-media-fixture');
  assert.equal(fs.readFileSync(path.join(restoreRoot, 'config', 'deployment.json'), 'utf8'), '{"fixture":true}');
  assert.equal(fs.readFileSync(path.join(storageRoot, 'media', 'movie.bin'), 'utf8'), 'real-media-fixture');
  const hold = await readTeamRestoreHold(restoreRoot);
  assert.equal(hold.scheduling, false);
  assert.equal(hold.automaticRetries, false);
  assert.equal(hold.backupId, 'restore-source');
  await assert.rejects(() => releaseTeamRestoreHold({ dataRoot: restoreRoot, operatorConfirmed: true }), /unknown|核查/);
  await assert.rejects(() => restoreTeamBackup({
    backupDirectory: backup.directory, restoreRoot, deploymentId, expectedReleaseId: 'release-1',
  }), /全新|存在/);

  const restoredDb = new Database(path.join(restoreRoot, 'data', 'workbench.db'));
  databases.add(restoredDb);
  restoredDb.pragma('foreign_keys = ON');
  const recoveredAttempt = restoredDb.prepare('SELECT * FROM execution_attempts WHERE id = ?')
    .get(receiptAdmission.grant.attempt.id) as Record<string, unknown>;
  assert.equal(recoveredAttempt.submissionState, 'terminal');
  assert.equal(recoveredAttempt.remoteId, 'remote-receipt');
  assert.equal(recoveredAttempt.actualMinor, 120);
  const unknownOperation = restoredDb.prepare('SELECT status FROM execution_operations WHERE id = ?')
    .pluck().get(unknownAdmission.grant.operation.id);
  assert.equal(unknownOperation, 'unknown');

  resetTeamRuntimeStateForTests();
  const businessEvents: string[] = [];
  const restoredExecution = createTeamExecutionRuntime({
    config: {
      mode: 'server', dataRoot: restoreRoot, hostname: '127.0.0.1', port: 3399,
      deploymentId, trustedOrigin: 'https://studio.example.test',
    },
    db: restoredDb,
  });
  const bootstrap = createTeamServiceBootstrap({
    config: {
      mode: 'server', dataRoot: restoreRoot, hostname: '127.0.0.1', port: 3399,
      deploymentId, trustedOrigin: 'https://studio.example.test',
    },
    identity: { instanceId: 'restored-instance', fence: 99 }, db: restoredDb,
    ...schemaUpgradeRuntimePaths(restoreRoot), execution: restoredExecution,
    modules: [{
      name: 'business-fixture', ensureSchemaReady() {}, registerRecovery() { businessEvents.push('register'); },
      recover() { businessEvents.push('recover'); }, start() { businessEvents.push('start'); },
    }],
  });
  await bootstrap.ensureSchemaReady();
  await bootstrap.registerRecovery();
  await bootstrap.recover();
  await bootstrap.start();
  assert.deepEqual(businessEvents, ['register'], 'restore hold 必须先于业务 recover/start 生效');
  assert.equal(getTeamRuntimeState().ready, false);
  assert.equal(getTeamRuntimeState().maintenance, true);
  assert.equal(getTeamRuntimeState().phase, 'restore_hold');
  assert.throws(() => restoredExecution.facade.enqueue(operation('forbidden-after-restore')), /readiness|就绪/);
  assert.equal(remotePosts, 1);

  const missingEvidenceRoot = path.join(fixtureRoot, 'restored-missing-evidence');
  const missing = await restoreTeamBackup({
    backupDirectory: backup.directory, restoreRoot: missingEvidenceRoot, deploymentId,
    expectedReleaseId: 'release-1', currentJournalDirectory: path.join(fixtureRoot, 'missing-journal'),
  });
  assert.equal(missing.evidenceStatus, 'unavailable');
  assert.equal(missing.scheduling, false);
  assert.equal(missing.automaticRetries, 0);
  assert.ok(missing.unknownAttemptIds.includes(receiptAdmission.grant.attempt.id));
  assert.ok(missing.unknownAttemptIds.includes(unknownAdmission.grant.attempt.id));
  assert.equal(remotePosts, 1);
  await assert.rejects(() => releaseTeamRestoreHold({ dataRoot: missingEvidenceRoot, operatorConfirmed: true }),
    /unknown|证据|核查/, '缺证据 restore 重核后仍必须保持 hold');

  const restoredJournal = createExecutionJournal({
    deploymentId, directory: path.join(restoreRoot, 'storage', 'execution-journal', deploymentId),
  });
  const lateUnknownIntent = restoredJournal.scan().find((record) =>
    record.eventType === 'submit_intent' && record.attemptId === unknownAdmission.grant.attempt.id);
  assert.ok(lateUnknownIntent);
  restoredJournal.appendReceipt({
    ...lateUnknownIntent, terminalState: 'not_created', actualCost: null,
    errorCode: 'operator_confirmed_not_created', reconciliationSource: 'operator',
  });
  assert.deepEqual(await releaseTeamRestoreHold({ dataRoot: restoreRoot, operatorConfirmed: true }), { released: true });
  const recheckedReport = JSON.parse(fs.readFileSync(
    path.join(restoreRoot, 'storage', 'maintenance', 'reconciliation.json'), 'utf8',
  )) as { status: string; unknownAttemptIds: string[]; orphanAttemptIds: string[]; automaticRetries: number; remoteCalls: number };
  assert.equal(recheckedReport.status, 'reconciled');
  assert.deepEqual(recheckedReport.unknownAttemptIds, []);
  assert.deepEqual(recheckedReport.orphanAttemptIds, []);
  assert.equal(recheckedReport.automaticRetries, 0);
  assert.equal(recheckedReport.remoteCalls, 0);
  assert.equal(remotePosts, 1, '显式重核只能对账，不得自动重提或发起真实调用');

  const currentDatabaseHash = (await import('node:crypto')).createHash('sha256')
    .update(fs.readFileSync(path.join(sourceRoot, 'data', 'workbench.db'))).digest('hex');
  assert.equal(currentDatabaseHash, originalDatabaseHash, '恢复演练不得修改旧库主文件');
  assert.ok(media.id);
  console.log('team maintenance isolated restore and hold tests passed');
} finally {
  for (const database of databases) if (database.open) database.close();
  resetTeamRuntimeStateForTests();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
