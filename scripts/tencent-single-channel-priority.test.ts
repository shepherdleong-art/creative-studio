import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput } from '../lib/media-core/execution/context.ts';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-tencent-priority-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = fixtureRoot;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const {
  MEDIA_PRIORITY_AGING_MS,
  readMediaAdmissionPriority,
} = await import('../lib/media-core/unified-media/admission-priority.ts');
const { UNIFIED_IMAGE_CHANNELS } = await import('../lib/media-core/unified-media/catalog.ts');

const identity = { instanceId: 'tencent-priority-instance', fence: 1 };
const deploymentId = 'tencent-priority-deployment';
const journal = {
  verify: () => ({ valid: true, records: [] }),
  appendIntent: () => { throw new Error('not used'); },
  appendReceipt: () => { throw new Error('not used'); },
  scan: () => [],
};
const databases = new Set<Database.Database>();
const cleanups: Array<() => void> = [];
const qiniu = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
const tencent = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'tencent')!;

async function setup(name: string) {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const db = new Database(path.join(root, 'data', 'workbench.db'));
  databases.add(db);
  db.pragma('foreign_keys = ON');
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true);
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL
    );
    INSERT INTO providers VALUES
      ('${qiniu.providerId}', '七牛 Image 2', 'https://qiniu.priority.test', 'qiniu-key', '${qiniu.model}', 'gateway-task-image', 1),
      ('${tencent.providerId}', '腾讯 Image 2', 'https://tencent.priority.test', 'tencent-key', '${tencent.model}', 'gateway-task-image', 1);
  `);
  registerExecutionInstance(db, { ...identity, deploymentId });
  upsertExecutionPool(db, {
    poolKey: 'tencent',
    kind: 'remote',
    capacity: 2,
    enabled: true,
    mappingSnapshot: { providerId: tencent.providerId },
    expectedVersion: 0,
  });
  let now = new Date('2026-11-11T00:00:00.000Z');
  const runtime = createExecutionFacade({
    db,
    deploymentId,
    journal,
    now: () => now,
    actorAllowed: () => true,
    scopeAllowed: () => true,
    maintenance: () => false,
  });
  await runtime.lifecycle.start({
    ...identity,
    deploymentId,
    signal: new AbortController().signal,
  });
  cleanups.push(() => runtime.closeNewWork());
  return {
    db,
    execution: runtime.facade,
    setNow: (value: Date) => { now = value; },
    now: () => now,
  };
}

function setPolicy(db: Database.Database, actorId: string, version = 0): void {
  updateActorPolicy(db, {
    actorId,
    monthlyLimitMinor: null,
    personalConcurrency: 10,
    concurrencyMode: 'fixed',
    paused: false,
    expectedVersion: version,
  });
}

function setPoolCapacity(db: Database.Database, capacity: number, version: number): void {
  upsertExecutionPool(db, {
    poolKey: 'tencent',
    kind: 'remote',
    capacity,
    enabled: true,
    mappingSnapshot: { providerId: tencent.providerId },
    expectedVersion: version,
  });
}

function createTask(
  db: Database.Database,
  input: {
    taskId: string;
    actorId: string;
    kind: 'overflow' | 'single';
    qiniuState?: string;
  },
): string {
  const mediaTaskId = `media-${input.taskId}`;
  const at = new Date('2026-11-11T00:00:00.000Z').toISOString();
  db.prepare(`
    INSERT INTO execution_media_tasks (
      id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
      inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
      status, currentChannelKey, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', ?, 'image', ?, 'image2', 'priority-test/1',
      ?, '{}', '{}', 'project_scene', ?, '{}', 'routing', 'tencent', ?, ?)
  `).run(
    mediaTaskId, input.taskId, input.actorId, `project-${input.taskId}`,
    input.taskId, input.taskId, `project-${input.taskId}`, at, at,
  );
  const addChannel = db.prepare(`
    INSERT INTO execution_media_channels (
      id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
      state, executionRevision, evidenceJson, nextEligibleAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'providers', ?, ?, ?, ?, 1, NULL, NULL, ?, ?)
  `);
  if (input.kind === 'overflow') {
    addChannel.run(
      `channel-${input.taskId}-qiniu`, mediaTaskId, qiniu.channelKey,
      qiniu.providerId, qiniu.model, qiniu.priority,
      input.qiniuState ?? 'overflowed', at, at,
    );
  } else {
    addChannel.run(
      `channel-${input.taskId}-qiniu`, mediaTaskId, qiniu.channelKey,
      qiniu.providerId, qiniu.model, qiniu.priority,
      input.qiniuState ?? 'failed', at, at,
    );
  }
  addChannel.run(
    `channel-${input.taskId}-tencent`, mediaTaskId, tencent.channelKey,
    tencent.providerId, tencent.model, tencent.priority, 'selected', at, at,
  );
  return mediaTaskId;
}

function enqueue(
  execution: ReturnType<typeof createExecutionFacade>['facade'],
  input: { taskId: string; actorId: string; mediaTaskId: string },
) {
  const operation: EnqueueInput = {
    operationKey: `image/${input.taskId}/submit/r1`,
    actor: { userId: input.actorId },
    scope: { resourceType: 'project', resourceId: `project-${input.taskId}` },
    module: 'image',
    taskId: input.taskId,
    step: 'submit',
    inputRevision: 'r1',
    businessAttempt: { id: `${input.taskId}:r1`, number: 1 },
    inputSnapshot: { taskId: input.taskId },
    inputHash: `hash-${input.taskId}`,
    continuationKey: 'legacy-image.submit',
    providerSnapshot: {
      providerId: tencent.providerId,
      model: tencent.model,
      unifiedModel: 'image2',
    },
    requiredPools: ['tencent'],
    quote: { kind: 'priced', reserve: { currency: 'CNY', minor: 158 }, pricingSnapshot: { version: 1 } },
    mediaTaskId: input.mediaTaskId,
    channelKey: 'tencent',
  };
  return execution.enqueue(operation);
}

try {
  {
    const { db, execution } = await setup('same-member');
    setPolicy(db, 'member');
    enqueue(execution, {
      taskId: 'overflow',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'overflow', actorId: 'member', kind: 'overflow' }),
    });
    enqueue(execution, {
      taskId: 'single',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'single', actorId: 'member', kind: 'single' }),
    });
    const first = execution.admit(identity);
    assert.equal(first.kind, 'admitted');
    if (first.kind !== 'admitted') throw new Error('first grant expected');
    assert.equal(first.grant.operation.taskId, 'single', 'single-channel Tencent work wins within the same fair actor');
    const second = execution.admit(identity);
    assert.equal(second.kind, 'admitted');
    if (second.kind !== 'admitted') throw new Error('second grant expected');
    assert.equal(second.grant.operation.taskId, 'overflow');
    const rows = db.prepare(`
      SELECT taskId, admissionPriority, admissionCandidateCount, admissionTraceJson
        FROM execution_operations ORDER BY readySeq
    `).all() as Array<{
      taskId: string; admissionPriority: number; admissionCandidateCount: number; admissionTraceJson: string;
    }>;
    assert.deepEqual(rows.map((row) => [row.taskId, row.admissionPriority, row.admissionCandidateCount]), [
      ['overflow', 1, 2], ['single', 0, 1],
    ]);
    assert.equal(JSON.parse(rows[0].admissionTraceJson).priorityClass, 'overflow');
    assert.equal(JSON.parse(rows[1].admissionTraceJson).priorityClass, 'single_channel');
  }

  {
    const { db, execution, setNow } = await setup('aging');
    setPolicy(db, 'member');
    const start = Date.now();
    setNow(new Date(start - MEDIA_PRIORITY_AGING_MS - 1_000));
    enqueue(execution, {
      taskId: 'old-overflow',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'old-overflow', actorId: 'member', kind: 'overflow' }),
    });
    setNow(new Date(start));
    enqueue(execution, {
      taskId: 'new-single',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'new-single', actorId: 'member', kind: 'single' }),
    });
    const first = execution.admit(identity);
    assert.equal(first.kind, 'admitted');
    if (first.kind !== 'admitted') throw new Error('aged grant expected');
    assert.equal(first.grant.operation.taskId, 'old-overflow', 'aged overflow work is promoted after the anti-starvation window');
    const trace = JSON.parse(db.prepare(`SELECT admissionTraceJson FROM execution_operations WHERE taskId='old-overflow'`).pluck().get() as string);
    assert.equal(trace.aged, true);
    assert.equal(trace.effectivePriority, 0);
  }

  {
    const { db, execution } = await setup('wait-evidence');
    setPolicy(db, 'member');
    setPoolCapacity(db, 1, 1);
    enqueue(execution, {
      taskId: 'overflow',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'overflow', actorId: 'member', kind: 'overflow' }),
    });
    enqueue(execution, {
      taskId: 'single',
      actorId: 'member',
      mediaTaskId: createTask(db, { taskId: 'single', actorId: 'member', kind: 'single' }),
    });
    const first = execution.admit(identity);
    assert.equal(first.kind, 'admitted');
    if (first.kind !== 'admitted') throw new Error('single grant expected');
    assert.equal(first.grant.operation.taskId, 'single');
    const second = execution.admit(identity);
    assert.deepEqual(second, { kind: 'deferred', reasons: ['pool_capacity'] });
    const wait = db.prepare(`SELECT waitDetail, admissionPriority, admissionCandidateCount
      FROM execution_operations WHERE taskId = 'overflow'`).get() as {
      waitDetail: string; admissionPriority: number; admissionCandidateCount: number;
    };
    assert.equal(wait.admissionPriority, 1);
    assert.equal(wait.admissionCandidateCount, 2);
    const detail = JSON.parse(wait.waitDetail) as Record<string, unknown>;
    assert.equal(detail.admissionPriority, 'overflow');
    assert.equal(detail.admissionCandidateCount, 2);
    assert.deepEqual(detail.admissionChannelKeys, ['qiniu', 'tencent']);
  }

  {
    const { db, execution } = await setup('member-fairness');
    setPolicy(db, 'actor-a');
    setPolicy(db, 'actor-b');
    enqueue(execution, {
      taskId: 'a-overflow',
      actorId: 'actor-a',
      mediaTaskId: createTask(db, { taskId: 'a-overflow', actorId: 'actor-a', kind: 'overflow' }),
    });
    enqueue(execution, {
      taskId: 'b-single',
      actorId: 'actor-b',
      mediaTaskId: createTask(db, { taskId: 'b-single', actorId: 'actor-b', kind: 'single' }),
    });
    const first = execution.admit(identity);
    assert.equal(first.kind, 'admitted');
    if (first.kind !== 'admitted') throw new Error('actor round-robin grant expected');
    assert.equal(first.grant.operation.taskId, 'a-overflow', 'member rotation remains ahead of the Tencent preference');
    const second = execution.admit(identity);
    assert.equal(second.kind, 'admitted');
    if (second.kind !== 'admitted') throw new Error('second actor grant expected');
    assert.equal(second.grant.operation.taskId, 'b-single');
  }

  {
    const { db, execution } = await setup('health-and-failed');
    setPolicy(db, 'member');
    db.prepare(`
      INSERT INTO execution_media_channel_health (
        healthKey, unifiedModel, channelKey, providerId, state, consecutiveFailures,
        reasonCode, avoidUntil, version, updatedAt
      ) VALUES (?, 'image2', ?, ?, 'avoided', 3, 'provider_server_error', ?, 3, ?)
    `).run(
      'image2:qiniu', qiniu.channelKey, qiniu.providerId,
      new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(),
    );
    const mediaTaskId = createTask(db, {
      taskId: 'avoided-qiniu',
      actorId: 'member',
      kind: 'overflow',
      qiniuState: 'candidate',
    });
    const enqueued = enqueue(execution, { taskId: 'avoided-qiniu', actorId: 'member', mediaTaskId });
    const priority = readMediaAdmissionPriority(db, enqueued.operation);
    assert.equal(priority.candidateCount, 1, 'an avoided qiniu is not counted as a currently available alternative');
    assert.equal(priority.priorityClass, 'single_channel');
    assert.equal(priority.priority, 0);

    const failedTaskId = createTask(db, {
      taskId: 'failed-qiniu',
      actorId: 'member',
      kind: 'single',
      qiniuState: 'not_created',
    });
    const failedEnqueued = enqueue(execution, {
      taskId: 'failed-qiniu',
      actorId: 'member',
      mediaTaskId: failedTaskId,
    });
    assert.equal(readMediaAdmissionPriority(db, failedEnqueued.operation).priorityClass, 'single_channel');
  }

  console.log('tencent single-channel priority tests passed');
} finally {
  for (const cleanup of cleanups) cleanup();
  for (const db of databases) db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
