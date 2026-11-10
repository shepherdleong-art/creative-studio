import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ExecutionGrant, ExecutionJournal } from '../lib/media-core/execution/context.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-unified-usage-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { initUsageSchema } = await import('../lib/usage-schema.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { queryTeamUsage, queryTeamUsageAnalytics, queryTeamUnifiedUsage } = await import('../lib/team-service/usage.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal(initUsageSchema(db).available, true);
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    status TEXT,
    inputImageId TEXT,
    model TEXT,
    providerId TEXT,
    unifiedModel TEXT,
    unifiedTaskId TEXT,
    usageSnapshotJson TEXT
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    status TEXT,
    sourceImageId TEXT,
    model TEXT,
    usageSnapshotJson TEXT
  );
  CREATE TABLE image_assets (id TEXT PRIMARY KEY, filename TEXT, usage TEXT);
`);
db.prepare("INSERT INTO projects VALUES ('project-a', '统一模型测试项目')").run();
db.prepare("INSERT INTO image_assets VALUES ('image-a', '场景.png', 'scene_seed')").run();

const now = '2026-11-02T02:00:00.000Z';
for (const [id, employeeId, displayName, role] of [
  ['admin', '0000', '管理员', 'admin'],
  ['alice', '0001', '张三', 'employee'],
  ['bob', '0002', '李四', 'employee'],
] as const) {
  db.prepare(`INSERT INTO team_users (
    id, employeeId, displayName, role, status, passwordHash, mustChangePassword,
    sessionVersion, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, 'active', 'not-used', 0, 1, ?, ?)`)
    .run(id, employeeId, displayName, role, now, now);
  updateActorPolicy(db, {
    actorId: id, monthlyLimitMinor: null, personalConcurrency: 5,
    paused: false, expectedVersion: 0,
  });
}

upsertExecutionPool(db, {
  poolKey: 'unified-pool', kind: 'remote', capacity: 20, enabled: true,
  mappingSnapshot: { providerId: 'unified-provider' }, expectedVersion: 0,
});
const identity = { instanceId: 'unified-usage-test', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'unified-usage-test' });
const journal: ExecutionJournal = {
  verify: () => ({ valid: true, records: [] }),
  scan: () => [],
  appendIntent: (input) => ({
    ...input, schemaVersion: 1, deploymentId: 'unified-usage-test', eventType: 'submit_intent',
    seq: 1, prevHash: null, hash: 'intent', at: now,
  }),
  appendReceipt: (input) => ({
    ...input, schemaVersion: 1, deploymentId: 'unified-usage-test', eventType: 'receipt',
    seq: 2, prevHash: null, hash: 'receipt', at: now,
  }),
};
const runtime = createExecutionFacade({
  db, deploymentId: 'unified-usage-test', journal,
  actorAllowed: () => true, scopeAllowed: () => true, maintenance: () => false,
  now: () => new Date(now),
});
await runtime.lifecycle.start({
  ...identity, deploymentId: 'unified-usage-test', signal: new AbortController().signal,
});

function addMediaTask(input: {
  id: string;
  jobId: string;
  actorId: string;
  status: string;
  createdAt?: string;
  unifiedModel?: string;
  channelModels?: Array<{ channelKey: string; providerId: string; model: string; priority: number }>;
}): void {
  const createdAt = input.createdAt ?? now;
  const channels = input.channelModels ?? [
    {
      channelKey: 'qiniu', providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
      model: 'qiniuyun/gpt-image-2-medium', priority: 0,
    },
    {
      channelKey: 'tencent', providerId: 'company-gateway-image2-medium',
      model: 'image2-medium', priority: 1,
    },
  ];
  db.prepare(`INSERT INTO execution_media_tasks (
    id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
    inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
    status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
    resultJson, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', 'project-a', 'image', ?, ?, 'rules-v1',
    ?, '{}', '{}', 'project_scene', 'project-a', '{}', ?, NULL, ?, NULL, NULL, NULL,
    NULL, ?, ?)`).run(
    input.id, `image:${input.jobId}`, input.actorId, input.jobId,
    input.unifiedModel ?? 'image2', `hash-${input.id}`,
    input.status, channels[0]?.channelKey ?? null, createdAt, createdAt,
  );
  for (const channel of channels) {
    db.prepare(`INSERT INTO execution_media_channels (
      id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
      state, executionRevision, operationId, remoteId, evidenceJson, nextEligibleAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'providers', ?, ?, ?, 'candidate', 0, NULL, NULL, NULL, NULL, ?, ?)`)
      .run(
        `${input.id}:${channel.channelKey}`, input.id, channel.channelKey,
        channel.providerId, channel.model, channel.priority, createdAt, createdAt,
      );
  }
  db.prepare(`INSERT INTO jobs (
    id, projectId, status, inputImageId, model, providerId, unifiedModel, unifiedTaskId, usageSnapshotJson
  ) VALUES (?, 'project-a', ?, 'image-a', 'image2', 'unified-image2', ?, ?, NULL)`)
    .run(input.jobId, input.status, input.unifiedModel ?? 'image2', input.id);
}

async function attempt(input: {
  mediaTaskId: string;
  jobId: string;
  actorId: string;
  channelKey: string;
  revision: number;
  providerId: string;
  model: string;
  reserveMinor: number;
  outcome: 'succeeded' | 'failed' | 'not_created';
  actualMinor: number | null;
  createdAt?: string;
}): Promise<ExecutionGrant> {
  const quote = {
    kind: 'priced' as const,
    reserve: { currency: 'CNY' as const, minor: input.reserveMinor },
    pricingSnapshot: {
      coreModelKey: input.model,
      pricingVersion: 'price-test-v1',
      provider: {
        providerTable: 'providers',
        providerId: input.providerId,
        providerName: `${input.channelKey} 通道`,
        providerType: 'gateway-task-image',
        configuredModel: input.model,
        requestModel: input.model,
      },
    },
  };
  const enqueued = runtime.facade.enqueue({
    operationKey: `image/${input.jobId}/submit/r${input.revision}`,
    actor: { userId: input.actorId },
    scope: { resourceType: 'project', resourceId: 'project-a' },
    module: 'image', taskId: input.jobId, step: 'submit', inputRevision: `r${input.revision}`,
    businessAttempt: { id: `${input.jobId}:${input.channelKey}`, number: input.revision },
    inputSnapshot: { channel: input.channelKey }, inputHash: `hash-${input.jobId}-${input.channelKey}`,
    continuationKey: 'image.submit',
    providerSnapshot: {
      providerId: input.providerId, providerName: `${input.channelKey} 通道`,
      type: 'gateway-task-image', model: input.model, baseUrl: `https://${input.channelKey}.test`,
      unifiedModel: 'image2',
    },
    configVersion: `config-${input.channelKey}`,
    requiredPools: ['unified-pool'], quote,
    mediaTaskId: input.mediaTaskId, channelKey: input.channelKey,
  });
  const admitted = runtime.facade.admit({ ...identity, operationId: enqueued.operation.id });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('expected admitted grant');
  const intent = await runtime.facade.markSubmitting({
    grant: admitted.grant,
    requestSnapshot: { channel: input.channelKey },
  });
  const remoteId = `${input.channelKey}-${input.jobId}-${input.revision}`;
  await runtime.facade.transmit(intent, async () => ({
    remoteId, terminalState: input.outcome,
    actualCost: input.actualMinor === null ? null : { currency: 'CNY', minor: input.actualMinor },
  }));
  await runtime.facade.settle({
    attemptId: intent.attemptId,
    outcome: input.outcome,
    actualCost: input.actualMinor === null ? null : { currency: 'CNY', minor: input.actualMinor },
    remoteTerminal: true,
  });
  db.prepare(`UPDATE execution_media_channels
    SET state = ?, executionRevision = ?, remoteId = ?, updatedAt = ?
    WHERE id = ?`).run(
    input.outcome === 'not_created' ? 'not_created' : input.outcome === 'failed' ? 'failed' : 'succeeded',
    input.revision, remoteId, now, `${input.mediaTaskId}:${input.channelKey}`,
  );
  return admitted.grant;
}

try {
  addMediaTask({
    id: 'media-fallback', jobId: 'job-fallback', actorId: 'alice', status: 'succeeded',
  });
  await attempt({
    mediaTaskId: 'media-fallback', jobId: 'job-fallback', actorId: 'alice',
    channelKey: 'qiniu', revision: 1,
    providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
    model: 'qiniuyun/gpt-image-2-medium', reserveMinor: 25,
    outcome: 'not_created', actualMinor: null,
  });
  await attempt({
    mediaTaskId: 'media-fallback', jobId: 'job-fallback', actorId: 'alice',
    channelKey: 'tencent', revision: 2,
    providerId: 'company-gateway-image2-medium',
    model: 'image2-medium', reserveMinor: 158,
    outcome: 'succeeded', actualMinor: 158,
  });

  addMediaTask({
    id: 'media-mixed', jobId: 'job-mixed', actorId: 'alice', status: 'succeeded',
  });
  await attempt({
    mediaTaskId: 'media-mixed', jobId: 'job-mixed', actorId: 'alice',
    channelKey: 'qiniu', revision: 1,
    providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
    model: 'qiniuyun/gpt-image-2-medium', reserveMinor: 25,
    outcome: 'failed', actualMinor: null,
  });
  await attempt({
    mediaTaskId: 'media-mixed', jobId: 'job-mixed', actorId: 'alice',
    channelKey: 'tencent', revision: 2,
    providerId: 'company-gateway-image2-medium',
    model: 'image2-medium', reserveMinor: 158,
    outcome: 'succeeded', actualMinor: 158,
  });

  addMediaTask({
    id: 'media-failed', jobId: 'job-failed', actorId: 'alice', status: 'failed',
  });
  await attempt({
    mediaTaskId: 'media-failed', jobId: 'job-failed', actorId: 'alice',
    channelKey: 'qiniu', revision: 1,
    providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
    model: 'qiniuyun/gpt-image-2-medium', reserveMinor: 25,
    outcome: 'failed', actualMinor: null,
  });
  await attempt({
    mediaTaskId: 'media-failed', jobId: 'job-failed', actorId: 'alice',
    channelKey: 'tencent', revision: 2,
    providerId: 'company-gateway-image2-medium',
    model: 'image2-medium', reserveMinor: 158,
    outcome: 'failed', actualMinor: null,
  });

  db.prepare(`INSERT INTO jobs (
    id, projectId, status, inputImageId, model, providerId, unifiedModel, unifiedTaskId, usageSnapshotJson
  ) VALUES ('job-legacy', 'project-a', 'succeeded', 'image-a', 'qiniuyun/gpt-image-2-medium',
    'company-gateway-qiniuyun-gpt-image-2-medium', NULL, NULL, NULL)`).run();
  const legacyOp = runtime.facade.enqueue({
    operationKey: 'image/job-legacy/submit/0',
    actor: { userId: 'alice' }, scope: { resourceType: 'project', resourceId: 'project-a' },
    module: 'image', taskId: 'job-legacy', step: 'submit', inputRevision: '0',
    businessAttempt: { id: 'legacy-business', number: 1 },
    inputSnapshot: {}, inputHash: 'legacy-hash', continuationKey: 'image.submit',
    providerSnapshot: {
      providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
      type: 'gateway-task-image', model: 'qiniuyun/gpt-image-2-medium',
    },
    requiredPools: ['unified-pool'],
    quote: {
      kind: 'priced', reserve: { currency: 'CNY', minor: 25 },
      pricingSnapshot: { coreModelKey: 'qiniuyun/gpt-image-2-medium' },
    },
  }).operation;
  const legacyGrant = runtime.facade.admit({ ...identity, operationId: legacyOp.id });
  assert.equal(legacyGrant.kind, 'admitted');
  if (legacyGrant.kind !== 'admitted') throw new Error('expected legacy grant');
  const legacyIntent = await runtime.facade.markSubmitting({
    grant: legacyGrant.grant, requestSnapshot: { legacy: true },
  });
  await runtime.facade.transmit(legacyIntent, async () => ({
    remoteId: 'legacy-remote', terminalState: 'succeeded',
    actualCost: { currency: 'CNY', minor: 25 },
  }));
  await runtime.facade.settle({
    attemptId: legacyIntent.attemptId, outcome: 'succeeded',
    actualCost: { currency: 'CNY', minor: 25 }, remoteTerminal: true,
  });

  const range = { from: '2026-11-01T16:00:00.000Z', to: '2026-11-03T16:00:00.000Z' };
  const adminView = { userId: 'admin', role: 'admin' as const };
  const aliceView = { userId: 'alice', role: 'employee' as const };
  const bobView = { userId: 'bob', role: 'employee' as const };

  const alice = queryTeamUnifiedUsage(db, aliceView, range);
  assert.equal(alice.tasks.length, 3, 'two channel attempts remain one work task');
  const fallback = alice.tasks.find((task) => task.taskId === 'job-fallback');
  assert.ok(fallback);
  assert.equal(fallback.model, 'Image 2');
  assert.equal(fallback.unifiedModel, 'image2');
  assert.equal(fallback.generationTaskCount, 1);
  assert.equal(fallback.channelCallCount, 2);
  assert.equal(fallback.submissionCount, 2);
  assert.equal(fallback.usedChannelCount, 2);
  assert.equal(fallback.chargedMinor, 158);
  assert.equal(fallback.settledMinor, 158);
  assert.equal(fallback.releasedCount, 1);
  assert.equal(fallback.costStatus, 'settled');
  assert.equal(fallback.scopeName, '统一模型测试项目');
  assert.equal('channels' in fallback, false, '员工任务投影不得包含真实通道明细');

  const mixed = alice.tasks.find((task) => task.taskId === 'job-mixed');
  assert.equal(mixed?.chargedMinor, 183);
  assert.equal(mixed?.settledMinor, 158);
  assert.equal(mixed?.uncertainMinor, 25);
  assert.equal(mixed?.uncertainCount, 1);
  assert.equal(mixed?.costStatus, 'mixed');

  const failed = alice.tasks.find((task) => task.taskId === 'job-failed');
  assert.equal(failed?.chargedMinor, 183);
  assert.equal(failed?.costStatus, 'uncertain');
  assert.equal(failed?.settledMinor, 0);

  assert.equal(alice.legacyAttempts.length, 1);
  assert.equal(alice.legacyAttempts[0]?.taskId, 'job-legacy');
  assert.equal(alice.counts.generationTasks, 3);
  assert.equal(alice.counts.channelCalls, 6);
  assert.equal(alice.counts.legacyAttempts, 1);
  assert.equal(alice.counts.unmappedAttempts, 0);

  const admin = queryTeamUnifiedUsage(db, adminView, range);
  const adminFallback = admin.tasks.find((task) => task.taskId === 'job-fallback');
  assert.deepEqual(adminFallback?.channels?.map((channel) => channel.channelKey), ['qiniu', 'tencent']);
  assert.equal(adminFallback?.channels?.[0]?.attempts[0]?.providerModel, 'qiniuyun/gpt-image-2-medium');
  assert.equal(adminFallback?.channels?.[0]?.attempts[0]?.costStatus, 'released');
  assert.equal(adminFallback?.channels?.[1]?.attempts[0]?.actualMinor, 158);
  assert.equal(JSON.stringify(admin).includes('apiKey'), false);
  assert.equal(JSON.stringify(admin).includes('baseUrl'), false);

  assert.equal(queryTeamUnifiedUsage(db, bobView, range).tasks.length, 0);
  assert.throws(
    () => queryTeamUnifiedUsage(db, bobView, { ...range, actorUserId: 'alice' }),
    (error: unknown) => (error as { status?: number }).status === 403,
  );
  assert.equal(queryTeamUnifiedUsage(db, aliceView, { ...range, model: 'Image 2' }).tasks.length, 3);
  assert.equal(queryTeamUnifiedUsage(db, aliceView, { ...range, model: 'image2' }).tasks.length, 3);
  assert.equal(queryTeamUnifiedUsage(db, aliceView, {
    from: '2026-11-03T16:00:00.000Z', to: '2026-11-04T16:00:00.000Z',
  }).tasks.length, 0);

  const usage = queryTeamUsage(db, aliceView, range);
  assert.equal(usage.items.find((item) => item.taskId === 'job-fallback')?.model, 'Image 2',
    '员工通道调用也以统一模型显示');
  const adminUsage = queryTeamUsage(db, adminView, range);
  assert.deepEqual(
    adminUsage.items.filter((item) => item.taskId === 'job-fallback').map((item) => item.model).sort(),
    ['image2-medium', 'qiniuyun/gpt-image-2-medium'],
    '管理员保留真实通道调用模型',
  );

  const analytics = queryTeamUsageAnalytics(db, aliceView, range);
  const unified = analytics.models.find((model) => model.model === 'Image 2');
  assert.ok(unified);
  assert.equal(unified.taskCount, 3);
  assert.equal(unified.callCount, 6);
  assert.equal(unified.chargedMinor, 524);
  assert.equal(analytics.trend.reduce((sum, point) => sum + point.chargedMinor, 0), 549,
    'trend includes the explicitly separate legacy attempt');
  assert.equal(analytics.taskCount, 4, 'three unified work tasks plus one explicitly separate legacy task');
  assert.equal(analytics.attemptCount, 7);
  assert.equal(analytics.modelOptions.includes('Image 2'), true);
  const unifiedOnly = queryTeamUsageAnalytics(db, aliceView, { ...range, model: 'Image 2' });
  assert.equal(unifiedOnly.taskCount, 3);
  assert.equal(unifiedOnly.attemptCount, 6);
  assert.deepEqual(unifiedOnly.models.map((model) => model.model), ['Image 2']);
  assert.equal(unifiedOnly.trend.reduce((sum, point) => sum + point.chargedMinor, 0), 524);

  const tasks = listTeamTasks(db, aliceView).items;
  const mapped = tasks.find((item) => item.taskId === 'job-fallback');
  assert.ok(mapped);
  assert.equal(mapped.unifiedTaskId, 'media-fallback');
  assert.equal(mapped.unifiedTaskCostMinor, 158);
  assert.equal(mapped.unifiedTaskCostStatus, 'settled');
  assert.equal(mapped.unifiedTaskAttemptCount, 2);
  assert.equal(mapped.unifiedTaskChannelCount, 2);
  assert.ok(mapped.modelCalls.every((call) => call.model === 'Image 2' && call.providerName === 'Image 2'),
    '员工任务详情不得展开真实通道路由');
  const adminMappedCalls = listTeamTasks(db, adminView).items
    .filter((item) => item.taskId === 'job-fallback')
    .flatMap((item) => item.modelCalls);
  assert.ok(adminMappedCalls.some((call) => call.model === 'qiniuyun/gpt-image-2-medium')
    && adminMappedCalls.some((call) => call.model === 'image2-medium'),
    '管理员任务详情保留真实通道尝试');

  const lateAttempt = admin.tasks.find((task) => task.taskId === 'job-failed')
    ?.channels?.[0]?.attempts[0];
  assert.ok(lateAttempt);
  db.prepare(`UPDATE execution_attempts
    SET actualMinor = 30, costState = 'settled', updatedAt = ?
    WHERE id = ?`).run(now, lateAttempt.attemptId);
  db.prepare(`UPDATE execution_reservations
    SET state = 'settled', actualMinor = 30, costState = 'settled', settledAt = ?
    WHERE attemptId = ? AND kind = 'cost'`).run(now, lateAttempt.attemptId);
  const afterLateSettlement = queryTeamUnifiedUsage(db, adminView, range)
    .tasks.find((task) => task.taskId === 'job-failed');
  assert.equal(afterLateSettlement?.settledMinor, 30);
  assert.equal(afterLateSettlement?.chargedMinor, 188);
  assert.equal(afterLateSettlement?.costStatus, 'mixed');

  addMediaTask({
    id: 'media-before-attempt', jobId: 'job-before-attempt', actorId: 'alice', status: 'routing',
  });
  const withPendingTask = queryTeamUnifiedUsage(db, aliceView, range);
  assert.equal(
    withPendingTask.tasks.some((task) => task.mediaTaskId === 'media-before-attempt'),
    true,
    'a unified task waiting before its first attempt must still appear in the task report',
  );
  assert.equal(withPendingTask.tasks.find((task) => task.mediaTaskId === 'media-before-attempt')?.costStatus, 'unpriced');

  const orphanOperation = runtime.facade.enqueue({
    operationKey: 'image/job-orphan/submit/r1',
    actor: { userId: 'alice' },
    scope: { resourceType: 'project', resourceId: 'project-a' },
    module: 'image', taskId: 'job-orphan', step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: 'job-orphan:r1', number: 1 },
    inputSnapshot: { orphan: true }, inputHash: 'job-orphan',
    continuationKey: 'image.submit',
    providerSnapshot: { providerId: 'company-gateway-image2-medium', model: 'image2-medium', unifiedModel: 'image2' },
    requiredPools: ['unified-pool'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 158 }, pricingSnapshot: { coreModelKey: 'image2-medium' } },
    mediaTaskId: 'missing-parent',
    channelKey: 'tencent',
  }).operation;
  const orphanGrant = runtime.facade.admit({ ...identity, operationId: orphanOperation.id });
  assert.equal(orphanGrant.kind, 'admitted');
  if (orphanGrant.kind !== 'admitted') throw new Error('expected orphan grant');
  const orphanIntent = await runtime.facade.markSubmitting({
    grant: orphanGrant.grant, requestSnapshot: { orphan: true },
  });
  await runtime.facade.transmit(orphanIntent, async () => ({
    remoteId: 'orphan-remote', terminalState: 'succeeded',
    actualCost: { currency: 'CNY', minor: 158 },
  }));
  await runtime.facade.settle({
    attemptId: orphanIntent.attemptId, outcome: 'succeeded',
    actualCost: { currency: 'CNY', minor: 158 }, remoteTerminal: true,
  });
  const withOrphan = queryTeamUnifiedUsage(db, aliceView, range);
  assert.equal(withOrphan.unmappedAttempts.some((item) => item.taskId === 'job-orphan'), true);
  assert.equal(withOrphan.legacyAttempts.some((item) => item.taskId === 'job-orphan'), false);
  assert.equal(withOrphan.counts.unmappedAttempts, 1);

  console.log('team unified usage tests passed');
} finally {
  runtime.closeNewWork();
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
