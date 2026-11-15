import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import type { ResourceAccessContext } from '../lib/media-core/access-context.ts';
register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-batch-llm-recovery-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
delete process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE;
const { getDb, closeDb } = await import('../lib/db.ts');
const { ensureBatchSchemaReady } = await import('../lib/batch-production/schema.ts');
const { createBatchProduction } = await import('../lib/batch-production/versions.ts');
const { createAsset } = await import('../lib/batch-production/assets.ts');
const { queueAssetPreparation } = await import('../lib/batch-production/asset-preparation.ts');
const { claimNextTask, recoverInterruptedWork, completeTaskAttempt, retryTask, deferTaskAttempt, settleInterruptedTask, pauseTask, resumeTask } = await import('../lib/batch-production/scheduler.ts');
const { createAnalyzeAssetExecutor } = await import('../lib/batch-production/executors.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool, readActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { clearExecutionModuleRuntime, setExecutionModuleRuntime } = await import('../lib/media-core/execution/module-runtime.ts');
const { completeJson, getAvailableProviders } = await import('../lib/script-providers/index.ts');
const ffmpeg = (await import('ffmpeg-static')).default;
const db = getDb();
const originalFetch = globalThis.fetch;
try {
  assert.equal((await ensureBatchSchemaReady({ db, backupRoot: path.join(root, 'backups') })).state, 'ready');
  getAvailableProviders();
  assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
  const identity = { instanceId: 'batch-llm-recovery', fence: 1 };
  registerExecutionInstance(db, { ...identity, deploymentId: 'batch-llm-recovery' });
  upsertExecutionPool(db, { poolKey: 'llm:remote', kind: 'remote', capacity: 8, enabled: true, mappingSnapshot: { fixture: 'loopback-only' }, expectedVersion: 0 });
  updateActorPolicy(db, { actorId: 'test-user', monthlyLimitMinor: null, personalConcurrency: 8, paused: false, expectedVersion: 0 });
  const journal = createExecutionJournal({ deploymentId: 'batch-llm-recovery', directory: path.join(root, 'storage/execution-journal/batch-llm-recovery') });
  const execution = createExecutionFacade({ db, deploymentId: 'batch-llm-recovery', journal, actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false });
  await execution.lifecycle.start({ ...identity, deploymentId: 'batch-llm-recovery', signal: new AbortController().signal });
  setExecutionModuleRuntime({ facade: execution.facade, ...identity });
  const access: ResourceAccessContext = { kind: 'team', actor: { userId: 'test-user', role: 'admin' }, assertAccess() {}, resolveOwner() { return 'test-user'; }, registerRootScope() {}, registerInheritedScope() {}, registerTaskPrincipal() {} };
  db.prepare("INSERT INTO providers(id,name,baseUrl) VALUES ('fixture','隔离供应商','http://127.0.0.1:9')").run();
  db.prepare("INSERT INTO projects(id,name,providerId,model,prompt) VALUES ('recovery-project','隔离恢复回归','fixture','fixture','synthetic')").run();
  const batchId = createBatchProduction(db, 'recovery-project', '恢复回归');
  const file = path.join(root, 'storage/batch-media/recovery-project/recovery.mp4'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = spawnSync(ffmpeg!, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=24:d=1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', file], { windowsHide: true, encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const fingerprint = 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const location = { kind: 'managed', relativePath: 'storage/batch-media/recovery-project/recovery.mp4' };
  const assetId = createAsset(db, { projectId: 'recovery-project', sourceKind: 'managed', locationJson: location, contentFingerprint: fingerprint, mediaKind: 'video' });
  db.prepare("INSERT INTO batch_asset_sources(id,assetId,sourceKind,locationJson,health,createdAt) VALUES ('source',?,'managed',?,'healthy',?)").run(assetId, JSON.stringify(location), new Date().toISOString());
  db.prepare("UPDATE script_providers SET type='openai-compatible',apiStyle='openai-compatible',baseUrl='http://127.0.0.1:9/v1',apiKey='fixture',model='fixture',enabled=1,supportsVision=1,executionScope='external' WHERE id='qwen'").run();
  const queued = queueAssetPreparation(db, 'recovery-project', batchId, [assetId], undefined, { mode: 'content', providerId: 'qwen', model: 'fixture', executionScope: 'external' });
  const taskId = queued.items[0].taskId!;
  let posts = 0;
  globalThis.fetch = async () => { posts++; throw new TypeError('isolated transport ended after submission'); };
  let prompt = 'same frozen material';
  const executor = createAnalyzeAssetExecutor({ assertProviderReady: async () => {}, analyzeContent: async input => runWithAccessContext(access, async () => {
    await completeJson({ providerId: 'qwen', systemPrompt: 'synthetic', userPrompt: prompt, executionContext: { taskId: input.executionTaskId!, step: 'analyze:1', scope: input.executionScope!, inputRevision: input.inputRevision, businessAttempt: input.businessAttempt } });
    return { summary: 'fixture', sellingPoints: [], semanticTags: [], usableRanges: [{ startUs: 0, endUs: 1000000, qualityScore: 1 }], qualityIssues: [], coverFrameTimesUs: [], scenes: [] };
  }) });
  const first = claimNextTask(db, { workerId: 'old' })!;
  await assert.rejects(executor.execute({ db, claim: first, signal: new AbortController().signal, reportProgress() {} }), /尚未核清/);
  assert.equal(posts, 1);
  const before = db.prepare('SELECT * FROM execution_attempts').all();
  const reservations = db.prepare('SELECT * FROM execution_reservations ORDER BY id').all();
  // Crash between the remote uncertainty receipt and business-task settlement.
  recoverInterruptedWork(db);
  const recovered = claimNextTask(db, { workerId: 'new' })!;
  assert.equal(recovered.task.id, taskId);
  assert.notEqual(recovered.attempt.id, first.attempt.id, 'The dead worker lease must not be revived');
  await assert.rejects(executor.execute({ db, claim: recovered, signal: new AbortController().signal, reportProgress() {} }), /尚未核清/);
  assert.equal(posts, 1, 'Recovering the same uncertain batch analysis must not submit again');
  assert.deepEqual(db.prepare('SELECT * FROM execution_attempts').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM execution_reservations ORDER BY id').all(), reservations);
  for (let i = 0; i < 2; i++) {
    recoverInterruptedWork(db);
    const again = claimNextTask(db, { workerId: 'again-' + i })!;
    assert.notEqual(again.attempt.id, first.attempt.id);
    assert.deepEqual(again.businessAttempt, first.businessAttempt);
    await assert.rejects(executor.execute({ db, claim: again, signal: new AbortController().signal, reportProgress() {} }), /尚未核清/);
    assert.equal(posts, 1);
  }
  const last = db.prepare("SELECT id,claimedBy,attemptNumber FROM batch_task_attempts WHERE taskId=? AND status='running'").get(taskId) as { id: string; claimedBy: string; attemptNumber: number };
  const changedClaim = { ...recovered, attempt: { id: last.id, attemptNumber: last.attemptNumber } };
  prompt = 'changed frozen material';
  await assert.rejects(executor.execute({ db, claim: changedClaim, signal: new AbortController().signal, reportProgress() {} }), { code: 'idempotency_conflict' });
  assert.equal(posts, 1, 'Changed input must not bypass the original uncertain intent');
  prompt = 'same frozen material';
  completeTaskAttempt(db, last.id, { workerId: last.claimedBy, status: 'failed', errorCode: 'llm_execution_unknown' });
  retryTask(db, 'recovery-project', taskId);
  const explicit = claimNextTask(db, { workerId: 'explicit' })!;
  assert.equal(explicit.businessAttempt?.id, explicit.attempt.id);
  assert.notEqual(explicit.businessAttempt?.id, first.businessAttempt?.id);
  await assert.rejects(executor.execute({ db, claim: explicit, signal: new AbortController().signal, reportProgress() {} }), /尚未核清/);
  assert.equal(posts, 2, 'An explicit retry is a separate business attempt');
  completeTaskAttempt(db, explicit.attempt.id, { workerId: 'explicit', status: 'failed' });

  const enqueue = (name: string) => {
    const batch = createBatchProduction(db, 'recovery-project', name);
    return queueAssetPreparation(db, 'recovery-project', batch, [assetId], undefined, { mode: 'content', providerId: 'qwen', model: 'fixture', executionScope: 'external' }).items[0].taskId!;
  };
  globalThis.fetch = async () => { posts++; return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }); };
  const successId = enqueue('success-before-crash');
  const success = claimNextTask(db, { workerId: 'success' })!;
  const run = (claim: NonNullable<ReturnType<typeof claimNextTask>>) => executor.execute({ db, claim, signal: new AbortController().signal, reportProgress() {} });
  await run(success); // Receipt exists; crash before committing business result.
  assert.equal(posts, 3);
  recoverInterruptedWork(db);
  const replay = claimNextTask(db, { workerId: 'replay' })!;
  assert.equal(replay.task.id, successId);
  await run(replay);
  assert.equal(posts, 3, 'Successful receipt must replay without a second submission');
  completeTaskAttempt(db, replay.attempt.id, { workerId: 'replay', status: 'succeeded' });

  const pendingId = enqueue('deferred-and-not-sent');
  const policy = (paused: boolean) => updateActorPolicy(db, { actorId: 'test-user', monthlyLimitMinor: null, personalConcurrency: 8, paused, expectedVersion: readActorPolicy(db, 'test-user').version });
  policy(true);
  const waiting = claimNextTask(db, { workerId: 'waiting' })!;
  await assert.rejects(run(waiting), { code: 'llm_execution_deferred' });
  assert.equal(posts, 3);
  deferTaskAttempt(db, waiting.attempt.id, { workerId: 'waiting' });
  const deferred = claimNextTask(db, { workerId: 'deferred' })!;
  assert.equal(deferred.attempt.id, waiting.attempt.id);
  policy(false);
  const granted = execution.facade.admit(identity);
  assert.equal(granted.kind, 'admitted');
  if (granted.kind !== 'admitted') throw new Error('not_sent grant missing');
  assert.equal(granted.grant.operation.taskId, pendingId);
  assert.equal(db.prepare('SELECT submissionState FROM execution_attempts WHERE id=?').pluck().get(granted.grant.attempt.id), 'not_sent');
  await execution.lifecycle.recover({ ...identity, deploymentId: 'batch-llm-recovery', signal: new AbortController().signal });
  recoverInterruptedWork(db);
  const unsent = claimNextTask(db, { workerId: 'unsent' })!;
  assert.deepEqual(unsent.businessAttempt, waiting.businessAttempt);
  await run(unsent);
  assert.equal(posts, 4, 'A proven not_sent attempt may submit once after recovery');
  pauseTask(db, 'recovery-project', pendingId);
  settleInterruptedTask(db, unsent.attempt.id);
  resumeTask(db, 'recovery-project', pendingId);
  const resumed = claimNextTask(db, { workerId: 'resumed' })!;
  assert.deepEqual(resumed.businessAttempt, waiting.businessAttempt);
  await run(resumed);
  assert.equal(posts, 4, 'Pause/resume must replay the same successful receipt');
  settleInterruptedTask(db, resumed.attempt.id, undefined, 'scheduler_shutdown');
  const shutdown = claimNextTask(db, { workerId: 'shutdown' })!;
  assert.notEqual(shutdown.attempt.id, resumed.attempt.id);
  assert.deepEqual(shutdown.businessAttempt, waiting.businessAttempt);
  await run(shutdown);
  assert.equal(posts, 4, 'Graceful shutdown must preserve business intent');
  completeTaskAttempt(db, shutdown.attempt.id, { workerId: 'shutdown', status: 'succeeded' });

  // Old workers keyed LLM operations to their own attempt. The first worker
  // may have died before creating an operation; the second one's intent wins.
  const legacyRequest = (claim: NonNullable<ReturnType<typeof claimNextTask>>, step = 'analyze:1') => runWithAccessContext(access, () => completeJson({
    providerId: 'qwen', systemPrompt: 'synthetic', userPrompt: prompt,
    executionContext: {
      taskId: claim.task.id, step, scope: { resourceType: 'project', resourceId: 'recovery-project' },
      inputRevision: claim.attempt.id,
      businessAttempt: { id: claim.attempt.id, number: claim.attempt.attemptNumber },
    },
  }));
  for (const outcome of ['unknown', 'succeeded', 'deferred'] as const) {
    const id = enqueue('legacy-upgrade-' + outcome);
    const beforeRemote = claimNextTask(db, { workerId: 'legacy-before-remote' })!;
    assert.equal(beforeRemote.task.id, id);
    recoverInterruptedWork(db);
    const sent = claimNextTask(db, { workerId: 'legacy-sent' })!;
    const previousPosts: number = posts;
    globalThis.fetch = async () => {
      posts++;
      if (outcome === 'unknown') throw new TypeError('legacy remote outcome is uncertain');
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    };
    if (outcome === 'deferred') policy(true);
    if (outcome === 'succeeded') await legacyRequest(sent);
    else await assert.rejects(legacyRequest(sent), outcome === 'unknown' ? /尚未核清/ : { code: 'llm_execution_deferred' });
    const persisted = db.prepare('SELECT * FROM execution_operations WHERE taskId=?').all(id);
    const oldAttempts = db.prepare('SELECT * FROM execution_attempts ORDER BY id').all();
    const oldReservations = db.prepare('SELECT * FROM execution_reservations ORDER BY id').all();
    recoverInterruptedWork(db);
    const upgraded = claimNextTask(db, { workerId: 'upgraded' })!;
    assert.equal(upgraded.businessAttempt?.id, beforeRemote.attempt.id, 'Worker chain anchor alone cannot identify the legacy intent');
    if (outcome === 'deferred') policy(false);
    if (outcome === 'unknown') await assert.rejects(run(upgraded), /尚未核清/);
    else await run(upgraded);
    assert.equal(posts, previousPosts + 1, 'Upgrade must reuse the legacy receipt, uncertainty or pending operation');
    if (outcome !== 'deferred') {
      assert.deepEqual(db.prepare('SELECT * FROM execution_operations WHERE taskId=?').all(id), persisted);
      assert.deepEqual(db.prepare('SELECT * FROM execution_attempts ORDER BY id').all(), oldAttempts);
      assert.deepEqual(db.prepare('SELECT * FROM execution_reservations ORDER BY id').all(), oldReservations);
    } else assert.equal(db.prepare('SELECT COUNT(*) FROM execution_operations WHERE taskId=?').pluck().get(id), 1);
    completeTaskAttempt(db, upgraded.attempt.id, { workerId: 'upgraded', status: outcome === 'unknown' ? 'failed' : 'succeeded' });
  }

  // Different legacy workers could already have split steps across identities.
  // Such history must fail locally before any new remote operation is enqueued.
  const ambiguousId = enqueue('legacy-multiple-intents');
  globalThis.fetch = async () => { posts++; return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }); };
  const legacyFirst = claimNextTask(db, { workerId: 'legacy-first' })!;
  await legacyRequest(legacyFirst);
  recoverInterruptedWork(db);
  const legacySecond = claimNextTask(db, { workerId: 'legacy-second' })!;
  globalThis.fetch = async () => { posts++; throw new TypeError('second legacy step is uncertain'); };
  await assert.rejects(legacyRequest(legacySecond, 'analyze:2'), /尚未核清/);
  recoverInterruptedWork(db);
  const ambiguous = claimNextTask(db, { workerId: 'ambiguous' })!;
  const beforeAmbiguous: number = posts;
  const ambiguousLedger = db.prepare('SELECT * FROM execution_operations WHERE taskId=? ORDER BY id').all(ambiguousId);
  await assert.rejects(run(ambiguous), /多个历史执行意图/);
  assert.equal(posts, beforeAmbiguous, 'Ambiguous upgrade history must not create another paid intent');
  assert.deepEqual(db.prepare('SELECT * FROM execution_operations WHERE taskId=? ORDER BY id').all(ambiguousId), ambiguousLedger);
  completeTaskAttempt(db, ambiguous.attempt.id, { workerId: 'ambiguous', status: 'failed', errorCode: 'conflict' });
  retryTask(db, 'recovery-project', ambiguousId);
  const retriedLegacy = claimNextTask(db, { workerId: 'legacy-explicit-retry' })!;
  globalThis.fetch = async () => { posts++; return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }); };
  await run(retriedLegacy);
  assert.equal(posts, beforeAmbiguous + 1, 'Explicit retry can establish a new intent after a terminal boundary');
  completeTaskAttempt(db, retriedLegacy.attempt.id, { workerId: 'legacy-explicit-retry', status: 'succeeded' });
  for (const field of ['inputRevision', 'businessAttemptNo', 'operationKey'] as const) {
    const id = enqueue('legacy-invalid-' + field);
    const legacy = claimNextTask(db, { workerId: 'legacy-invalid' })!;
    await legacyRequest(legacy);
    // Isolated corrupted-ledger fixture: no production record is repaired or erased.
    db.prepare('UPDATE execution_operations SET ' + field + ' = ? WHERE taskId = ?').run(field === 'businessAttemptNo' ? 99 : 'invalid-identity', id);
    const rows = db.prepare('SELECT * FROM execution_operations WHERE taskId=?').all(id);
    recoverInterruptedWork(db);
    const invalid = claimNextTask(db, { workerId: 'invalid-recovered' })!;
    const beforeInvalid: number = posts;
    await assert.rejects(run(invalid), /历史执行意图身份不一致/);
    assert.equal(posts, beforeInvalid);
    assert.deepEqual(db.prepare('SELECT * FROM execution_operations WHERE taskId=?').all(id), rows);
    completeTaskAttempt(db, invalid.attempt.id, { workerId: 'invalid-recovered', status: 'failed', errorCode: 'conflict' });
  }
  assert.equal(journal.verify({ repairTail: false }).valid, true);
  execution.closeNewWork();
  console.log('PASS: repeated crash/unknown, changed input, explicit retry, success replay, deferred/not_sent, pause/resume, graceful shutdown and legacy upgrade recovery');

  console.log('batch LLM recovery: one provider submission, fresh worker lease, original uncertainty and costs preserved');
} finally {
  globalThis.fetch = originalFetch; clearExecutionModuleRuntime(); closeDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
