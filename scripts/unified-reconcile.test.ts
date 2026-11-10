// node scripts/unified-reconcile.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-unified-reconcile-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-unified-reconcile',
  CREATIVE_STUDIO_INSTANCE_ID: 'instance-unified-reconcile',
  CREATIVE_STUDIO_PORT: '43127',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { createExecutionJournal } = await import('../lib/media-core/execution/journal.ts');
const {
  updateActorPolicy,
} = await import('../lib/media-core/execution/pools.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const { freezeUnifiedImageRequest } = await import('../lib/media-core/unified-media/requests.ts');
const {
  UnifiedReconcileError,
  applyUnifiedReconcileAction,
  listUnifiedReconcileTasks,
} = await import('../lib/team-service/unified-reconcile.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: fixtureRoot, hostname: '127.0.0.1', port: 43127,
  deploymentId: 'deployment-unified-reconcile', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
seedProviders();
const paths = schemaUpgradeRuntimePaths(fixtureRoot);
assert.equal((await checkTeamServiceReadiness({ db, ...paths })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...paths })).available, true);

const now = new Date().toISOString();
function user(id: string, role: 'admin' | 'employee', employeeId: string, displayName: string): void {
  db.prepare(`INSERT INTO team_users
    (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'active', 'hash', 0, 1, ?, ?)`)
    .run(id, employeeId, displayName, role, now, now);
}
user('admin', 'admin', '0000', '管理员');
user('admin2', 'admin', '0002', '管理员乙');
user('member', 'employee', '0001', '员工甲');
updateActorPolicy(db, {
  actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 10, paused: false, expectedVersion: 0,
});

const admin = { userId: 'admin', role: 'admin' as const };
const admin2 = { userId: 'admin2', role: 'admin' as const };
const employee = { userId: 'member', role: 'employee' as const };

const qiniu = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
const tencent = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'tencent')!;
db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run('https://qiniu.reconcile.test', 'qiniu-reconcile-key', qiniu.providerId);
db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run('https://tencent.reconcile.test', 'tencent-reconcile-key', tencent.providerId);
db.prepare(`INSERT OR IGNORE INTO providers
  (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES (?, 'Image 2', '', '', '', ?, 'unified-image', 1)`)
  .run(UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
const qiniuPoolKey = configureLegacyMediaProviderPool({
  baseUrl: 'https://qiniu.reconcile.test', apiKey: 'qiniu-reconcile-key', capacity: 10,
});
configureLegacyMediaProviderPool({
  baseUrl: 'https://tencent.reconcile.test', apiKey: 'tencent-reconcile-key', capacity: 10,
});

db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt)
  VALUES ('reconcile-project', '核对项目', ?, ?, 'prompt')`)
  .run(UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage)
  VALUES ('reconcile-input', 'reconcile-project', 'input', 'input.png', ?, 'image/png', 'scene_seed')`)
  .run(path.join(fixtureRoot, 'input.png'));

const identity = { instanceId: 'instance-unified-reconcile', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-unified-reconcile' });
const journal = createExecutionJournal({
  deploymentId: 'deployment-unified-reconcile',
  directory: path.join(fixtureRoot, 'storage', 'execution-journal', 'deployment-unified-reconcile'),
});
const runtime = createExecutionFacade({
  db,
  deploymentId: 'deployment-unified-reconcile',
  journal,
  actorAllowed: () => true,
  scopeAllowed: () => true,
  maintenance: () => false,
});
await runtime.lifecycle.start({
  ...identity, deploymentId: 'deployment-unified-reconcile', signal: new AbortController().signal,
});

function mediaTaskId(jobId: string): string {
  return `media-${jobId}`;
}

async function createUnknownTask(
  jobId: string,
  options: { withTencent?: boolean; canceled?: boolean } = {},
): Promise<{
  taskId: string;
  operationId: string;
  attemptId: string;
  qiniuReserved: number;
}> {
  const withTencent = options.withTencent !== false;
  const frozen = freezeUnifiedImageRequest({
    inputImageId: 'reconcile-input',
    referenceImageIds: [],
    prompt: `核对 ${jobId}`,
    tier: '2k',
    ratio: '3:4',
    referenceGuidanceMode: 'none',
  });
  const taskId = mediaTaskId(jobId);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
    id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
    status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
    unifiedModel, unifiedRuleVersion, unifiedTaskId, unifiedRequestJson, cancelRequestedAt
  ) VALUES (?, 'reconcile-project', 'reconcile-input', '[]', ?, ?, ?, ?, 'auto',
    'needs_check', 1, 1, 'none', ?, 0, ?, ?, ?, ?, ?)`)
    .run(
      jobId, UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY, frozen.prompt, frozen.size,
      at, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, taskId, JSON.stringify(frozen),
      options.canceled ? at : null,
    );
  db.prepare(`INSERT INTO execution_media_tasks (
    id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
    inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
    status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
    resultJson, reconcileVersion, createdAt, updatedAt
  ) VALUES (@id, @taskKey, 'member', 'project', 'reconcile-project', 'image', @taskId, @unifiedModel, @ruleVersion,
    @inputHash, @inputSnapshotJson, @outputContractJson, 'project_scene', 'reconcile-project', @sourceMetaJson,
    @status, @cancelRequestedAt, @currentChannelKey, NULL, NULL, NULL,
    NULL, 0, @createdAt, @updatedAt)`)
    .run({
      id: taskId,
      taskKey: `image:${jobId}`,
      taskId: jobId,
      unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
      ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
      inputHash: `hash-${jobId}`,
      inputSnapshotJson: JSON.stringify(frozen),
      outputContractJson: JSON.stringify(frozen),
      sourceMetaJson: JSON.stringify({ entry: 'reconcile-test', jobId }),
      status: options.canceled ? 'canceled' : 'unknown',
      cancelRequestedAt: options.canceled ? at : null,
      currentChannelKey: qiniu.channelKey,
      createdAt: at,
      updatedAt: at,
    });
  const addChannel = db.prepare(`INSERT INTO execution_media_channels (
    id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
    state, executionRevision, operationId, remoteId, evidenceJson, nextEligibleAt, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'providers', ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, ?, ?)`);
  addChannel.run(`channel-${jobId}-qiniu`, taskId, qiniu.channelKey, qiniu.providerId, qiniu.model, qiniu.priority, 'unknown', at, at);
  if (withTencent) {
    addChannel.run(`channel-${jobId}-tencent`, taskId, tencent.channelKey, tencent.providerId, tencent.model, tencent.priority, 'candidate', at, at);
  }

  const operationKey = `image/${jobId}/submit/r1`;
  const enqueued = runtime.facade.enqueue({
    operationKey,
    actor: { userId: 'member' },
    scope: { resourceType: 'project', resourceId: 'reconcile-project' },
    module: 'image', taskId: jobId, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${jobId}:qiniu:r1`, number: 1 },
    inputSnapshot: frozen,
    inputHash: `input-${jobId}`,
    continuationKey: 'test',
    providerSnapshot: {
      providerId: qiniu.providerId,
      providerName: '七牛 Image 2',
      type: 'gateway-task-image',
      model: qiniu.model,
      baseUrl: 'https://qiniu.reconcile.test',
      unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    },
    requiredPools: [qiniuPoolKey],
    quote: {
      kind: 'priced',
      reserve: { currency: 'CNY', minor: 25 },
      pricingSnapshot: { coreModelKey: 'company-image2-medium', model: qiniu.model },
    },
    mediaTaskId: taskId,
    channelKey: qiniu.channelKey,
  });
  const admitted = runtime.facade.admit({ ...identity, operationId: enqueued.operation.id });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('expected admission');
  const intent = await runtime.facade.markSubmitting({
    grant: admitted.grant,
    requestSnapshot: { requestId: jobId },
  });
  await assert.rejects(() => runtime.facade.transmit(intent, async () => {
    throw new TypeError('network disconnected after send');
  }));
  return {
    taskId,
    operationId: enqueued.operation.id,
    attemptId: intent.attemptId,
    qiniuReserved: 25,
  };
}

function actionFor(
  task: Awaited<ReturnType<typeof createUnknownTask>>,
  action: 'attach_remote_id' | 'confirm_not_created' | 'confirm_succeeded' | 'confirm_failed' | 'still_unknown',
  overrides: Record<string, unknown> = {},
) {
  return {
    mediaTaskId: task.taskId,
    channelKey: qiniu.channelKey,
    attemptId: task.attemptId,
    action,
    evidence: '模拟供应商后台任务记录与账单截图，已人工复核',
    expectedVersion: 0,
    idempotencyKey: `${task.taskId}:${action}`,
    ...overrides,
  };
}

try {
  const listed = listUnifiedReconcileTasks(db, admin);
  assert.equal(listed.items.length, 0);
  assert.throws(
    () => listUnifiedReconcileTasks(db, employee),
    (error: unknown) => error instanceof UnifiedReconcileError && error.status === 403,
  );

  {
    const task = await createUnknownTask('job-attach');
    const before = listUnifiedReconcileTasks(db, admin).items.find((item) => item.mediaTaskId === task.taskId);
    assert.ok(before);
    assert.equal(before.actorDisplayName, '员工甲');
    assert.equal(before.scopeName, '核对项目');
    assert.equal(before.unifiedModel, 'image2');
    assert.equal(before.channels.find((channel) => channel.channelKey === 'qiniu')?.attempts[0]?.submissionState, 'maybe_sent');
    assert.equal(before.attention, true);
    assert.equal(JSON.stringify(before).includes('qiniu.reconcile.test'), false);
    assert.equal(JSON.stringify(before).includes('apiKey'), false);

    await assert.rejects(
      () => applyUnifiedReconcileAction(db, runtime.facade, employee, actionFor(task, 'attach_remote_id', {
        remoteId: 'remote-attach',
      })),
      (error: unknown) => error instanceof UnifiedReconcileError && error.status === 403,
    );
    await assert.rejects(
      () => applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'attach_remote_id', {
        channelKey: tencent.channelKey,
        remoteId: 'remote-wrong-channel',
      })),
      (error: unknown) => error instanceof UnifiedReconcileError && error.status === 409,
    );

    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'attach_remote_id', {
      remoteId: 'remote-attach',
      evidence: '后台任务 remote-attach，账单 URL https://bill.example.test/x?signature=secret-token',
    }));
    assert.equal(result.replayed, false);
    assert.equal(result.parentStatus, 'accepted');
    const job = db.prepare('SELECT status, providerTaskId, providerStatus FROM jobs WHERE id = ?').get('job-attach') as {
      status: string; providerTaskId: string; providerStatus: string;
    };
    assert.deepEqual(job, { status: 'needs_check', providerTaskId: 'remote-attach', providerStatus: 'accepted' });
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM execution_operations WHERE mediaTaskId = ?').pluck().get(task.taskId),
      1,
      'attaching a remote ID never creates a new generation operation',
    );
    assert.equal(
      db.prepare('SELECT remoteId FROM execution_attempts WHERE id = ?').pluck().get(task.attemptId),
      'remote-attach',
    );
    const audit = db.prepare('SELECT evidenceSummary, status, afterJson, resultJson FROM execution_media_reconcile_actions WHERE mediaTaskId = ?')
      .get(task.taskId) as { evidenceSummary: string; status: string; afterJson: string; resultJson: string };
    assert.equal(audit.status, 'completed');
    assert.equal(JSON.parse(audit.afterJson).parentStatus, 'accepted');
    assert.equal(audit.evidenceSummary.includes('secret-token'), false);
    assert.equal(JSON.parse(audit.resultJson).parentStatus, 'accepted');

    const other = await createUnknownTask('job-attach-other');
    await assert.rejects(
      () => applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(other, 'attach_remote_id', {
        remoteId: 'remote-attach',
      })),
      (error: unknown) => error instanceof UnifiedReconcileError
        && error.status === 409
        && error.code === 'remote_id_conflict',
    );

    const replay = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'attach_remote_id', {
      remoteId: 'remote-attach',
      evidence: '后台任务 remote-attach，账单 URL https://bill.example.test/x?signature=secret-token',
    }));
    assert.equal(replay.replayed, true);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM execution_media_reconcile_actions WHERE mediaTaskId = ?').pluck().get(task.taskId),
      1,
    );
    await assert.rejects(
      () => applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'still_unknown', {
        idempotencyKey: 'job-attach:second-action',
      })),
      (error: unknown) => error instanceof UnifiedReconcileError && error.status === 409,
    );
  }

  {
    const task = await createUnknownTask('job-not-created');
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_not_created'));
    assert.equal(result.parentStatus, 'routing');
    assert.equal(result.currentChannelKey, 'tencent');
    assert.equal(result.nextChannelKey, 'tencent');
    const attempts = db.prepare('SELECT terminalState FROM execution_attempts WHERE id = ?').pluck().get(task.attemptId);
    assert.equal(attempts, 'not_created');
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-not-created');
    assert.equal(job, 'pending');
    const qiniuState = db.prepare(`SELECT state FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(task.taskId);
    assert.equal(qiniuState, 'not_created');
    const tencentState = db.prepare(`SELECT state FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = 'tencent'`).pluck().get(task.taskId);
    assert.equal(tencentState, 'selected');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM execution_operations WHERE mediaTaskId = ?').pluck().get(task.taskId),
      1,
      'selecting a fallback does not create a hidden second POST',
    );
    const held = db.prepare(`SELECT COUNT(*) FROM execution_reservations
      WHERE attemptId = ? AND kind = 'cost' AND state = 'held'`).pluck().get(task.attemptId);
    assert.equal(held, 0, 'confirmed not-created releases the first attempt reservation');
  }

  {
    const task = await createUnknownTask('job-success');
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_succeeded', {
      remoteId: 'remote-success',
      actualCostMinor: 25,
    }));
    assert.equal(result.parentStatus, 'accepted');
    assert.equal(result.currentChannelKey, 'qiniu');
    const attempt = db.prepare(`SELECT terminalState, remoteId, actualMinor, costState
      FROM execution_attempts WHERE id = ?`).get(task.attemptId) as {
        terminalState: string; remoteId: string; actualMinor: number; costState: string;
      };
    assert.deepEqual(attempt, {
      terminalState: 'succeeded', remoteId: 'remote-success', actualMinor: 25, costState: 'settled',
    });
    const job = db.prepare('SELECT status, providerStatus, providerTaskId FROM jobs WHERE id = ?').get('job-success') as {
      status: string; providerStatus: string; providerTaskId: string;
    };
    assert.equal(job.status, 'needs_check');
    assert.equal(job.providerStatus, 'accepted');
    assert.equal(job.providerTaskId, 'remote-success');
  }

  {
    const task = await createUnknownTask('job-success-cost-unknown');
    await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_succeeded', {
      remoteId: 'remote-success-unknown-cost',
    }));
    const attempt = db.prepare('SELECT terminalState, actualMinor, costState FROM execution_attempts WHERE id = ?')
      .get(task.attemptId) as { terminalState: string; actualMinor: number | null; costState: string };
    assert.deepEqual(attempt, { terminalState: 'succeeded', actualMinor: null, costState: 'unknown' });
    const job = db.prepare('SELECT estimatedCost FROM jobs WHERE id = ?').pluck().get('job-success-cost-unknown');
    assert.equal(job, 0.25, 'an un-reconciled cost stays estimated from the real first-attempt reservation');
    const listed = listUnifiedReconcileTasks(db, admin, { status: 'all' }).items
      .find((item) => item.mediaTaskId === task.taskId);
    assert.equal(listed?.cost.costStatus, 'uncertain');
  }

  {
    const task = await createUnknownTask('job-success-result');
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_succeeded', {
      remoteId: 'remote-success-result',
      actualCostMinor: 25,
      resultRef: 'https://result.reconcile.test/image.png?signature=result-secret',
    }));
    assert.equal(JSON.stringify(result).includes('result-secret'), false);
    const job = db.prepare('SELECT status, providerStatus, remoteImageUrl FROM jobs WHERE id = ?')
      .get('job-success-result') as {
        status: string; providerStatus: string; remoteImageUrl: string;
      };
    assert.equal(job.status, 'needs_check');
    assert.equal(job.providerStatus, 'download_failed');
    assert.match(job.remoteImageUrl, /result-secret/, 'the original result address is stored only for补下载');
  }

  {
    const task = await createUnknownTask('job-failed');
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_failed', {
      actualCostMinor: 0,
    }));
    assert.equal(result.parentStatus, 'routing');
    assert.equal(result.currentChannelKey, 'tencent');
    const attempt = db.prepare('SELECT terminalState, actualMinor, costState FROM execution_attempts WHERE id = ?')
      .get(task.attemptId) as { terminalState: string; actualMinor: number; costState: string };
    assert.deepEqual(attempt, { terminalState: 'failed', actualMinor: 0, costState: 'settled' });
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-failed'), 'pending');
  }

  {
    const task = await createUnknownTask('job-unknown');
    const beforeHeld = db.prepare(`SELECT COUNT(*) FROM execution_reservations
      WHERE attemptId = ? AND kind = 'cost' AND state = 'held'`).pluck().get(task.attemptId);
    assert.equal(beforeHeld, 1);
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'still_unknown'));
    assert.equal(result.parentStatus, 'unknown');
    assert.equal(db.prepare('SELECT status FROM execution_operations WHERE id = ?').pluck().get(task.operationId), 'unknown');
    assert.equal(
      db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(task.taskId),
      'unknown',
    );
    assert.equal(db.prepare('SELECT terminalState FROM execution_attempts WHERE id = ?').pluck().get(task.attemptId), null);
    assert.equal(
      db.prepare(`SELECT COUNT(*) FROM execution_reservations
        WHERE attemptId = ? AND kind = 'cost' AND state = 'held'`).pluck().get(task.attemptId),
      1,
      'still unknown keeps the cost reservation',
    );
  }

  {
    const task = await createUnknownTask('job-canceled', { canceled: true });
    const result = await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_succeeded', {
      remoteId: 'remote-canceled',
      actualCostMinor: 25,
    }));
    assert.equal(result.parentStatus, 'canceled');
    const job = db.prepare('SELECT status, providerStatus, providerTaskId FROM jobs WHERE id = ?').get('job-canceled') as {
      status: string; providerStatus: string; providerTaskId: string;
    };
    assert.equal(job.status, 'canceled');
    assert.equal(job.providerStatus, 'accepted');
    assert.equal(job.providerTaskId, 'remote-canceled');
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM jobs WHERE id = ? AND status = ?').pluck().get('job-canceled', 'needs_check'),
      0,
      'a canceled task never re-enters the generation queue',
    );
  }

  {
    const task = await createUnknownTask('job-canceled-late-result', { canceled: true });
    await applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_succeeded', {
      remoteId: 'remote-canceled-late',
      resultRef: 'https://results.example.test/canceled-late.png',
      actualCostMinor: 25,
    }));
    const job = db.prepare(`SELECT status, providerStatus, providerTaskId, remoteImageUrl, cancelRequestedAt
      FROM jobs WHERE id = 'job-canceled-late-result'`).get() as {
        status: string; providerStatus: string; providerTaskId: string;
        remoteImageUrl: string; cancelRequestedAt: string | null;
      };
    assert.equal(job.status, 'needs_check');
    assert.equal(job.providerStatus, 'download_failed');
    assert.equal(job.providerTaskId, 'remote-canceled-late');
    assert.equal(job.remoteImageUrl, 'https://results.example.test/canceled-late.png');
    assert.ok(job.cancelRequestedAt);
    assert.equal(
      db.prepare(`SELECT COUNT(*) FROM execution_media_tasks WHERE taskId = ?
        AND status IN ('accepted', 'routing', 'waiting')`).pluck().get('job-canceled-late-result'),
      0,
      'a canceled task only enters result refetch, never another channel or downstream phase',
    );
  }

  {
    const task = await createUnknownTask('job-canceled-not-created', { canceled: true });
    const result = await applyUnifiedReconcileAction(
      db, runtime.facade, admin, actionFor(task, 'confirm_not_created'),
    );
    assert.equal(result.parentStatus, 'canceled');
    assert.equal(result.currentChannelKey, qiniu.channelKey);
    assert.equal(
      db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'tencent'`).pluck().get(task.taskId),
      'candidate',
      'a canceled task never starts the remaining fallback channel',
    );
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-canceled-not-created'), 'canceled');
  }

  {
    const task = await createUnknownTask('job-race');
    const results = await Promise.allSettled([
      applyUnifiedReconcileAction(db, runtime.facade, admin, actionFor(task, 'confirm_not_created', {
        idempotencyKey: 'race-a',
      })),
      applyUnifiedReconcileAction(db, runtime.facade, admin2, actionFor(task, 'confirm_not_created', {
        idempotencyKey: 'race-b',
      })),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected');
    assert.ok(rejected.reason instanceof UnifiedReconcileError);
    assert.equal(rejected.reason.status, 409);
  }

  {
    db.prepare(`INSERT INTO execution_reconciliation_orphans
      (attemptId, operationId, permitId, actorId, evidenceJson, state, createdAt, updatedAt)
      VALUES ('legacy-attempt', 'legacy-operation', 'legacy-permit', 'member', ?, 'unknown', ?, ?)`)
      .run(JSON.stringify({ module: 'image', errorCode: 'legacy_unknown' }), now, now);
    const legacy = listUnifiedReconcileTasks(db, admin);
    assert.ok(legacy.legacyItems.some((item) => item.attemptId === 'legacy-attempt'));
  }

  console.log('unified reconcile tests passed (paid calls: 0)');
} finally {
  runtime.closeNewWork();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
