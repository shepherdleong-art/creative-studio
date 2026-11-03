import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ExecutionJournal } from '../lib/media-core/execution/context.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-diagnostics-'));
const previousEnv = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { registerTaskPrincipal } = await import('../lib/team-service/task-principals.ts');
const {
  getTeamErrorDiagnostic,
  listTeamErrors,
  recordTeamError,
  recordTeamExecutionError,
  reportClientError,
} = await import('../lib/team-service/diagnostics.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
const now = new Date('2026-11-02T03:00:00.000Z');
for (const [id, employeeId, displayName, role] of [
  ['admin', '0000', '管理员', 'admin'], ['alice', '0001', '张三', 'employee'], ['bob', '0002', '李四', 'employee'],
] as const) {
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'active', 'not-used', 0, 1, ?, ?)`).run(id, employeeId, displayName, role, now.toISOString(), now.toISOString());
  registerRootScope(db, { resourceType: 'test_resource', resourceId: `${id}-project`, ownerUserId: id });
}
const identity = { instanceId: 'instance-diagnostics', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-diagnostics' });
const journalRecords: Array<Record<string, unknown>> = [];
const journal = {
  verify: () => ({ valid: true, records: journalRecords }), scan: () => journalRecords,
  appendIntent: (input: Record<string, unknown>) => {
    const record = { ...input, schemaVersion: 1, deploymentId: 'deployment-diagnostics', eventType: 'submit_intent', seq: journalRecords.length + 1, prevHash: null, hash: `i-${journalRecords.length}`, at: now.toISOString() };
    journalRecords.push(record); return record;
  },
  appendReceipt: (input: Record<string, unknown>) => {
    const record = { ...input, schemaVersion: 1, deploymentId: 'deployment-diagnostics', eventType: 'receipt', seq: journalRecords.length + 1, prevHash: null, hash: `r-${journalRecords.length}`, at: now.toISOString() };
    journalRecords.push(record); return record;
  },
} as unknown as ExecutionJournal;
upsertExecutionPool(db, { poolKey: 'shared', kind: 'remote', capacity: 2, enabled: true, mappingSnapshot: { providerId: 'p' }, expectedVersion: 0 });
updateActorPolicy(db, { actorId: 'alice', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0 });
const runtime = createExecutionFacade({
  db, deploymentId: 'deployment-diagnostics', serverReleaseId: 'server-release-13', journal, now: () => now,
  actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  recordError: (error) => { recordTeamExecutionError(db, { ...error, serverReleaseId: 'server-release-13' }); },
});
await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-diagnostics', signal: new AbortController().signal });

try {
  registerTaskPrincipal(db, {
    module: 'images', taskId: 'task-alice', actorUserId: 'alice',
    scope: { resourceType: 'test_resource', resourceId: 'alice-project' }, creationSnapshot: {},
  });
  const enqueued = runtime.facade.enqueue({
    operationKey: 'images/task-alice/submit/r1', actor: { userId: 'alice' },
    scope: { resourceType: 'test_resource', resourceId: 'alice-project' }, module: 'images', taskId: 'task-alice', step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: 'business-alice', number: 1 }, inputSnapshot: { prompt: '原始提示词绝不能进诊断' }, inputHash: 'hash-a', continuationKey: 'images.submit',
    providerSnapshot: { providerId: 'p', requestModel: 'image2-medium' }, configVersion: 'config-v9', clientVersion: '0.7.1', requiredPools: ['shared'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 100 }, pricingSnapshot: { pricingVersion: 'price-v1' } },
  });
  const admitted = runtime.facade.admit({ ...identity, operationId: enqueued.operation.id });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('grant expected');
  const intent = await runtime.facade.markSubmitting({ grant: admitted.grant, requestSnapshot: { prompt: '请求正文也不能进诊断' } });
  await runtime.facade.transmit(intent, async () => ({ terminalState: 'failed', actualCost: null, errorCode: 'upstream_rejected' }));
  await runtime.facade.settle({ attemptId: intent.attemptId, outcome: 'failed', actualCost: null, remoteTerminal: true, errorCode: 'upstream_rejected' });

  const aliceView = { userId: 'alice', role: 'employee' as const };
  const bobView = { userId: 'bob', role: 'employee' as const };
  const adminView = { userId: 'admin', role: 'admin' as const };
  const ownErrors = listTeamErrors(db, aliceView);
  assert.equal(ownErrors.items.length, 1, '服务端执行错误必须在打开 UI 前已记录');
  const executionError = ownErrors.items[0];
  assert.equal(executionError.taskId, 'task-alice');
  assert.equal(executionError.operationId, enqueued.operation.id);
  assert.equal(executionError.attemptId, intent.attemptId);
  assert.equal(executionError.stage, 'remote_submit');
  assert.equal(executionError.code, 'upstream_rejected');
  assert.equal(executionError.scope?.resourceId, 'alice-project');
  assert.equal(executionError.configVersion, 'config-v9');
  assert.equal(executionError.clientVersion, '0.7.1');
  assert.equal(executionError.serverReleaseId, 'server-release-13');
  assert.equal(listTeamErrors(db, bobView).items.length, 0);
  assert.equal(listTeamErrors(db, adminView, { errorId: executionError.errorId }).items[0].actorUserId, 'alice');

  const uploaded = reportClientError(db, aliceView, {
    clientEventId: 'client-upload-1', taskId: 'task-alice', stage: 'upload', code: 'disk_full', statusCode: 507,
    actorUserId: 'bob', operationId: 'forged-operation', attemptId: 'forged-attempt',
    message: '上传失败 https://cos.example.test/file?q-signature=SECRET Authorization: Bearer SECRET C:\\private\\source.png 原始素材文字',
  }, { clientVersion: '0.7.1', serverReleaseId: 'server-release-13' });
  assert.equal(uploaded.actorUserId, 'alice', '客户端不能冒充其他成员');
  assert.equal(uploaded.operationId, enqueued.operation.id, '任务关联由服务端重新解析');
  assert.equal(uploaded.attemptId, intent.attemptId);
  assert.equal(uploaded.stage, 'upload');
  assert.notEqual(uploaded.stage, 'remote_submit');
  assert.equal(uploaded.clientVersion, '0.7.1');
  assert.equal(uploaded.safeMessage.includes('SECRET'), false);
  assert.equal(uploaded.safeMessage.includes('原始素材文字'), false);
  assert.throws(() => reportClientError(db, aliceView, {
    clientEventId: 'client-forged-task', taskId: 'task-bob', stage: 'download', code: 'offline',
  }, { clientVersion: '0.7.1', serverReleaseId: 'server-release-13' }), (error: unknown) => (error as { status?: number }).status === 403);
  const repeated = reportClientError(db, aliceView, {
    clientEventId: 'client-upload-1', taskId: 'task-alice', stage: 'upload', code: 'disk_full',
  }, { clientVersion: '0.7.1', serverReleaseId: 'server-release-13' });
  assert.equal(repeated.errorId, uploaded.errorId, 'clientEventId 必须幂等');

  const updateError = recordTeamError(db, {
    actorUserId: 'alice', module: 'client', stage: 'client_update', code: 'bad_signature',
    safeMessage: '签名验证失败', clientVersion: '0.7.0', serverReleaseId: 'server-release-13',
  });
  assert.equal(updateError.stage, 'client_update');

  const diagnostic = getTeamErrorDiagnostic(db, aliceView, uploaded.errorId);
  const serialized = JSON.stringify(diagnostic);
  for (const forbidden of ['SECRET', '原始素材文字', '原始提示词', '请求正文', 'C:\\private', 'q-signature', 'Authorization']) {
    assert.equal(serialized.includes(forbidden), false, `诊断包不得包含 ${forbidden}`);
  }
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'attemptId', 'clientVersion', 'code', 'configVersion', 'createdAt', 'errorId', 'module',
    'operationId', 'safeMessage', 'schemaVersion', 'scope', 'serverReleaseId', 'stage', 'statusCode', 'taskId',
  ].sort());
  assert.equal(diagnostic.schemaVersion, 1);
  assert.throws(() => getTeamErrorDiagnostic(db, bobView, uploaded.errorId), (error: unknown) => (error as { status?: number }).status === 404);
  assert.equal(getTeamErrorDiagnostic(db, adminView, uploaded.errorId).errorId, uploaded.errorId);
  assert.equal(listTeamErrors(db, adminView).items.length, 3);

  const maliciousMetadata = {
    clientVersion: 'Bearer SECRET',
    serverReleaseId: 'https://cos.example.test/file?q-signature=SECRET',
    configVersion: 'C:\\private\\source.png',
  };
  const malicious = recordTeamError(db, {
    actorUserId: 'alice', module: 'client', stage: 'server_config', code: 'invalid_metadata', ...maliciousMetadata,
  });
  assert.equal(malicious.clientVersion, null);
  assert.equal(malicious.serverReleaseId, null);
  assert.equal(malicious.configVersion, null);
  const maliciousDiagnostic = getTeamErrorDiagnostic(db, aliceView, malicious.errorId);
  const maliciousSerialized = JSON.stringify(maliciousDiagnostic);
  for (const forbidden of ['Bearer', 'SECRET', 'q-signature', 'cos.example.test', 'C:\\private']) {
    assert.equal(maliciousSerialized.includes(forbidden), false, `异常版本元数据不得泄露 ${forbidden}`);
  }

  db.prepare('UPDATE execution_operations SET clientVersion = ?, serverReleaseId = ?, configVersion = ? WHERE id = ?')
    .run(maliciousMetadata.clientVersion, maliciousMetadata.serverReleaseId, maliciousMetadata.configVersion, enqueued.operation.id);
  const associatedMalicious = recordTeamError(db, {
    actorUserId: 'alice', module: 'images', attemptId: intent.attemptId, stage: 'remote_poll', code: 'poll_failed',
  });
  assert.equal(associatedMalicious.clientVersion, null, '执行关联中的异常客户端版本也必须在出口清洗');
  assert.equal(associatedMalicious.serverReleaseId, null);
  assert.equal(associatedMalicious.configVersion, null);
  assert.equal(JSON.stringify(getTeamErrorDiagnostic(db, adminView, associatedMalicious.errorId)).includes('SECRET'), false);

  console.log('PASS: correlated error ids, client ownership, safe diagnostics and stage fidelity');
} finally {
  runtime.closeNewWork();
  db.close();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
