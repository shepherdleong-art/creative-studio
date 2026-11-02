import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-execution-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-canvas-execution',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'fixture',
});

const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const { updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { createLocalAccessContext, runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { clearCanvasCapabilities, registerCanvasCapability } = await import('../lib/creative-canvas/capabilities.ts');
const { createCanvas, listCanvasNodeStates, requireCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { createCanvasScheduler } = await import('../lib/creative-canvas/scheduler.ts');
const { getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { recoverCanvasTasks, reconcileCanvasTaskExecution, reconcileCanvasTaskNotCreated, requestCanvasTaskCancel } = await import('../lib/creative-canvas/recovery.ts');
const { CanvasAdapterError } = await import('../lib/creative-canvas/adapters/types.ts');
const { createCanvasExport, requireCanvasExport } = await import('../lib/creative-canvas/export.ts');
const { readCanvasAsset } = await import('../lib/creative-canvas/assets.ts');

const databaseFile = path.join(root, 'workbench.db');
const db = new Database(databaseFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual((await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state, 'compatibility_only');

const now = '2026-11-02T00:00:00.000Z';
db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES ('user-a', '0001', '甲', 'employee', 'active', 'test', 0, 1, ?, ?)`).run(now, now);
db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt
) VALUES ('user-b', '0002', '乙', 'employee', 'active', 'test', 0, 1, ?, ?)`).run(now, now);
const principal = {
  kind: 'user' as const,
  userId: 'user-a', employeeId: '0001', displayName: '甲', role: 'employee' as const,
  sessionId: 'session-a', sessionVersion: 1, mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};
const access = createTeamAccessContext({ db, principal });
const accessB = createTeamAccessContext({
  db,
  principal: {
    ...principal, userId: 'user-b', employeeId: '0002', displayName: '乙', sessionId: 'session-b',
  },
});
const identity = { instanceId: 'canvas-execution-instance', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-canvas-execution' });
const runtime = createTeamExecutionRuntime({
  config: {
    mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
    deploymentId: 'deployment-canvas-execution', trustedOrigin: 'https://studio.example.test',
  },
  db,
});
await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-canvas-execution', signal: new AbortController().signal });
updateActorPolicy(db, {
  actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
});
upsertExecutionPool(db, {
  poolKey: 'shared-provider:remote', kind: 'remote', capacity: 1, enabled: true,
  mappingSnapshot: { providerIdentity: 'shared-provider' }, expectedVersion: 0,
});
db.prepare(`INSERT INTO team_resource_scopes (
  resourceType, resourceId, ownerUserId, visibility, parentType, parentId, rootType, rootId, createdAt, updatedAt
) VALUES ('project', 'project-a', 'user-a', 'private', NULL, NULL, 'project', 'project-a', ?, ?)`).run(now, now);

clearCanvasCapabilities();
registerCanvasCapability({
  key: 'fixture-execution-image', displayName: '共池测试图片', providerKind: 'external',
  providerIdentity: 'shared-provider', modelAlias: 'fixture-image', mediaKind: 'image',
  modes: ['text-to-image'], inputs: [], parameters: [], cancellation: false,
  evidence: 'candidate', evidenceNote: '隔离测试，不访问真实供应商。',
});
const canvasId = runWithAccessContext(access, () => createCanvas(db, { name: '共池画布' }).id);
runWithAccessContext(access, () => saveCanvasGraph({
  db, canvasId, expectedGraphRevision: 0,
  graph: {
    schemaVersion: 1,
    nodes: [{
      id: 'image-node', kind: 'image-generation', position: { x: 0, y: 0 },
      data: {
        title: '当前结果', modelKey: 'fixture-execution-image', generationMode: 'text-to-image',
        prompt: '只提交一次', parameters: {}, references: [], referenceLabelCounter: 0,
      },
    }],
    edges: [],
  },
}));
const started = runWithAccessContext(access, () => startCanvasRun({
  db,
  request: { canvasId, mode: 'single', targetNodeId: 'image-node', requestKey: 'shared-pool-run' },
}));
const taskId = started.tasks[0]!.id;
const readTask = () => runWithAccessContext(access, () => getCanvasTask(db, taskId));
const extraSchedulers: Array<{ stop(): Promise<void> }> = [];

function createSingleImageTask(name: string, nodeId: string, requestKey: string) {
  const id = runWithAccessContext(access, () => createCanvas(db, { name }).id);
  runWithAccessContext(access, () => saveCanvasGraph({
    db, canvasId: id, expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [{
        id: nodeId, kind: 'image-generation', position: { x: 0, y: 0 },
        data: {
          title: nodeId, modelKey: 'fixture-execution-image', generationMode: 'text-to-image',
          prompt: requestKey, parameters: {}, references: [], referenceLabelCounter: 0,
        },
      }],
      edges: [],
    },
  }));
  const task = runWithAccessContext(access, () => startCanvasRun({
    db,
    request: { canvasId: id, mode: 'single', targetNodeId: nodeId, requestKey },
  })).tasks[0]!;
  return {
    canvasId: id,
    nodeId,
    taskId: task.id,
    readTask: () => runWithAccessContext(access, () => getCanvasTask(db, task.id)),
  };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), message);
}

const oldOperation = {
  operationKey: 'images/old-project-task/submit/r1',
  actor: { userId: 'user-a' },
  scope: { resourceType: 'project', resourceId: 'project-a' },
  module: 'images', taskId: 'old-project-task', step: 'submit', inputRevision: 'r1',
  businessAttempt: { id: 'old-project-attempt', number: 1 },
  inputSnapshot: { projectId: 'project-a', prompt: '旧项目' }, inputHash: 'old-project-hash',
  continuationKey: 'images.submit', providerSnapshot: { providerIdentity: 'shared-provider' },
  requiredPools: ['shared-provider:remote'],
  quote: { kind: 'priced' as const, reserve: { currency: 'CNY' as const, minor: 0 }, pricingSnapshot: { version: 1 } },
};
runtime.facade.enqueue(oldOperation);
const oldAdmission = runtime.facade.admit(identity);
assert.equal(oldAdmission.kind, 'admitted');
if (oldAdmission.kind !== 'admitted') throw new Error('旧项目测试前置未获准入');

let submitCount = 0;
let downloadObserved: { remoteHeld: number; slotHeld: boolean } | null = null;
const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).png().toBuffer();
const adapter = {
  kind: 'execution-fixture',
  async prepare(): Promise<void> {},
  async submit(): Promise<{ providerTaskId: string }> {
    submitCount += 1;
    return { providerTaskId: 'canvas-remote-1' };
  },
  async poll(): Promise<{ status: 'succeeded' }> {
    return { status: 'succeeded' };
  },
  async download(): Promise<{ bytes: Buffer; mimeType: string }> {
    downloadObserved = {
      remoteHeld: Number((db.prepare(`SELECT COUNT(*) AS count FROM execution_reservations
        WHERE kind = 'concurrency' AND state = 'held'`).get() as { count: number }).count),
      slotHeld: readTask()?.slotHeld ?? false,
    };
    return { bytes, mimeType: 'image/png' };
  },
};
const scheduler = createCanvasScheduler({
  db, workerId: 'canvas-execution-worker', adapter, storageRoot: path.join(root, 'storage'),
  execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 0, sleep: async () => {},
});

try {
  await scheduler.tick();
  await scheduler.drain();
  assert.equal(submitCount, 0, '旧项目占满共享池和个人并发时，画布不得双占或直接提交');
  assert.equal(readTask()?.phase, 'queued', '等待公共 permit 时保持可恢复排队');
  assert.equal(readTask()?.slotHeld, false, '等待公共 permit 不得继续占内部 slot');

  const oldIntent = await runtime.facade.markSubmitting({
    grant: oldAdmission.grant, requestSnapshot: { taskId: 'old-project-task' },
  });
  await runtime.facade.transmit(oldIntent, async () => ({ remoteId: 'old-remote-1' }));
  await runtime.facade.reconcile({
    attemptId: oldAdmission.grant.attempt.id,
    evidence: { kind: 'terminal', outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 0 } },
    source: 'provider',
  });

  await scheduler.tick();
  await scheduler.drain();
  assert.equal(submitCount, 1, '旧项目结算后，同一画布任务只提交一次');
  assert.equal(readTask()?.phase, 'succeeded');
  assert.deepEqual(downloadObserved, { remoteHeld: 0, slotHeld: true },
    '远端终态先释放云端 permit，下载只保留内部执行 slot');
  const operation = db.prepare(`SELECT * FROM execution_operations WHERE module = 'canvas' AND taskId = ?`).get(taskId) as {
    actorId: string; scopeType: string; scopeId: string; inputRevision: string; step: string;
  };
  assert.equal(operation.actorId, 'user-a');
  assert.equal(operation.scopeType, 'canvas');
  assert.equal(operation.scopeId, canvasId);
  assert.equal(operation.step, 'submit');
  assert.match(operation.inputRevision, /epoch-1/);
  assert.match(operation.inputRevision, /variant-0/);
  assert.match(operation.inputRevision, /stage-direct/);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM execution_reservations
    WHERE kind = 'concurrency' AND state = 'held'`).get() as { count: number }).count), 0);

  // 崩溃发生在 06 已收到远端回执、画布尚未保存 remoteId 的窗口：恢复只接续，不重提。
  const restarted = createSingleImageTask('重启画布', 'restart-node', 'restart-run');
  let restartSubmitCount = 0;
  let restartPoll: 'running' | 'succeeded' = 'running';
  const restartAdapter = {
    kind: 'restart-fixture',
    async prepare(): Promise<void> {},
    async submit(): Promise<{ providerTaskId: string }> {
      restartSubmitCount += 1;
      return { providerTaskId: 'restart-remote-1' };
    },
    async poll(): Promise<{ status: 'running' | 'succeeded' }> {
      return { status: restartPoll };
    },
    async download(): Promise<{ bytes: Buffer; mimeType: string }> {
      return { bytes, mimeType: 'image/png' };
    },
  };
  const beforeRestart = createCanvasScheduler({
    db, workerId: 'before-restart', adapter: restartAdapter, storageRoot: path.join(root, 'storage'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 5,
  });
  extraSchedulers.push(beforeRestart);
  await beforeRestart.tick();
  await waitFor(() => restarted.readTask()?.providerTaskId === 'restart-remote-1', '首次提交应保存远端 ID');
  await beforeRestart.stop();
  db.prepare(`UPDATE creative_canvas_tasks
    SET phase = 'submitting', providerTaskId = NULL, submissionState = 'not_sent',
        slotHeld = 1, leaseOwner = 'dead-worker', leaseUntil = NULL
    WHERE id = ?`).run(restarted.taskId);
  runWithAccessContext(createLocalAccessContext(), () => recoverCanvasTasks(db));
  assert.equal(restarted.readTask()?.phase, 'polling', '06 回执应补回画布远端身份');
  assert.equal(restarted.readTask()?.providerTaskId, 'restart-remote-1');
  restartPoll = 'succeeded';
  const afterRestart = createCanvasScheduler({
    db, workerId: 'after-restart', adapter: restartAdapter, storageRoot: path.join(root, 'storage'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 1,
  });
  extraSchedulers.push(afterRestart);
  await afterRestart.tick();
  await afterRestart.drain();
  assert.equal(restarted.readTask()?.phase, 'succeeded');
  assert.equal(restartSubmitCount, 1, '重启恢复不得重复付费提交');

  // 新 nodeEpoch 已发布后，旧任务迟到的结果仍只登记为自己的资产，不覆盖新结果。
  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 2, paused: false, expectedVersion: 1,
  });
  upsertExecutionPool(db, {
    poolKey: 'shared-provider:remote', kind: 'remote', capacity: 2, enabled: true,
    mappingSnapshot: { providerIdentity: 'shared-provider', version: 2 }, expectedVersion: 1,
  });
  const epoch = createSingleImageTask('纪元画布', 'epoch-node', 'epoch-old-run');
  let releaseOldEpoch = false;
  let epochSubmits = 0;
  const epochAdapter = {
    kind: 'epoch-fixture',
    async prepare(): Promise<void> {},
    async submit(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      epochSubmits += 1;
      return { providerTaskId: `epoch-remote-${context.task.id}` };
    },
    async poll(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext, signal?: AbortSignal) {
      if (context.task.id !== epoch.taskId) return { status: 'succeeded' as const };
      while (!releaseOldEpoch && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return signal?.aborted
        ? { status: 'failed' as const, code: 'aborted', message: '测试停止' }
        : { status: 'succeeded' as const };
    },
    async download(): Promise<{ bytes: Buffer; mimeType: string }> {
      return { bytes, mimeType: 'image/png' };
    },
  };
  const epochScheduler = createCanvasScheduler({
    db, workerId: 'epoch-worker', adapter: epochAdapter, storageRoot: path.join(root, 'storage'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 1,
  });
  extraSchedulers.push(epochScheduler);
  await epochScheduler.tick();
  await waitFor(() => epoch.readTask()?.providerTaskId !== null, '旧纪元任务应已受理');
  runWithAccessContext(access, () => saveCanvasGraph({
    db, canvasId: epoch.canvasId, expectedGraphRevision: 1,
    graph: { schemaVersion: 1, nodes: [], edges: [] },
  }));
  runWithAccessContext(access, () => saveCanvasGraph({
    db, canvasId: epoch.canvasId, expectedGraphRevision: 2,
    graph: {
      schemaVersion: 1,
      nodes: [{
        id: epoch.nodeId, kind: 'image-generation', position: { x: 0, y: 0 },
        data: {
          title: epoch.nodeId, modelKey: 'fixture-execution-image', generationMode: 'text-to-image',
          prompt: '新纪元输入', parameters: {}, references: [], referenceLabelCounter: 0,
        },
      }],
      edges: [],
    },
  }));
  const newEpochTaskId = runWithAccessContext(access, () => startCanvasRun({
    db,
    request: { canvasId: epoch.canvasId, mode: 'single', targetNodeId: epoch.nodeId, requestKey: 'epoch-new-run' },
  })).tasks[0]!.id;
  const readNewEpochTask = () => runWithAccessContext(access, () => getCanvasTask(db, newEpochTaskId));
  await epochScheduler.tick();
  await waitFor(() => readNewEpochTask()?.phase === 'succeeded', '新纪元任务应先完成');
  releaseOldEpoch = true;
  await epochScheduler.drain();
  assert.equal(epoch.readTask()?.phase, 'succeeded');
  const epochState = runWithAccessContext(access, () => listCanvasNodeStates(db, epoch.canvasId))
    .find((state) => state.nodeId === epoch.nodeId);
  assert.equal(epochState?.currentAssetId, readNewEpochTask()?.outputAssetId);
  assert.notEqual(epochState?.currentAssetId, epoch.readTask()?.outputAssetId);
  assert.equal(epochSubmits, 2);

  // 提交未知保留 06 远端预留但不占本地 slot；人工确认未创建后只结算一次。
  const uncertain = createSingleImageTask('未知核查画布', 'uncertain-node', 'uncertain-run');
  let uncertainSubmits = 0;
  const uncertainAdapter = {
    kind: 'uncertain-fixture',
    async prepare(): Promise<void> {},
    async submit(): Promise<never> {
      uncertainSubmits += 1;
      throw new CanvasAdapterError('submit', '模拟响应丢失', { uncertain: true, code: 'submit_unknown' });
    },
    async poll(): Promise<{ status: 'succeeded' }> { return { status: 'succeeded' }; },
    async download(): Promise<{ bytes: Buffer; mimeType: string }> { return { bytes, mimeType: 'image/png' }; },
  };
  const uncertainScheduler = createCanvasScheduler({
    db, workerId: 'uncertain-worker', adapter: uncertainAdapter, storageRoot: path.join(root, 'storage'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 1,
  });
  extraSchedulers.push(uncertainScheduler);
  await uncertainScheduler.tick();
  await uncertainScheduler.drain();
  assert.equal(uncertain.readTask()?.phase, 'uncertain');
  assert.equal(uncertain.readTask()?.slotHeld, false);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM execution_reservations
    WHERE kind = 'concurrency' AND state = 'held'`).get() as { count: number }).count), 2);
  await uncertainScheduler.tick();
  await uncertainScheduler.drain();
  assert.equal(uncertainSubmits, 1, 'unknown 不得自动重提');
  await runWithAccessContext(access, () => reconcileCanvasTaskExecution(db, runtime.facade, {
    taskId: uncertain.taskId, outcome: 'not_created',
  }));
  runWithAccessContext(access, () => reconcileCanvasTaskNotCreated(db, { taskId: uncertain.taskId }));
  assert.equal(uncertain.readTask()?.phase, 'failed');
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM execution_reservations
    WHERE kind = 'concurrency' AND state = 'held'`).get() as { count: number }).count), 0);

  // 停用与取消只阻止新付费阶段；已受理任务继续查询、下载并登记受管文件。
  updateActorPolicy(db, {
    actorId: 'user-a', monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 2,
  });
  upsertExecutionPool(db, {
    poolKey: 'shared-provider:remote', kind: 'remote', capacity: 1, enabled: true,
    mappingSnapshot: { providerIdentity: 'shared-provider', version: 3 }, expectedVersion: 2,
  });
  const accepted = createSingleImageTask('停用回收画布', 'accepted-node', 'accepted-run');
  const blocked = createSingleImageTask('停用新阶段画布', 'blocked-node', 'blocked-run');
  let releaseAccepted = false;
  const disabledSubmissions: string[] = [];
  const disabledAdapter = {
    kind: 'disabled-fixture',
    async prepare(): Promise<void> {},
    async submit(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      disabledSubmissions.push(context.task.id);
      return { providerTaskId: `disabled-remote-${context.task.id}` };
    },
    async poll(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext, signal?: AbortSignal) {
      if (context.task.id !== accepted.taskId) return { status: 'succeeded' as const };
      while (!releaseAccepted && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      return signal?.aborted
        ? { status: 'failed' as const, code: 'aborted', message: '测试停止' }
        : { status: 'succeeded' as const };
    },
    async download(): Promise<{ bytes: Buffer; mimeType: string }> {
      return { bytes, mimeType: 'image/png' };
    },
  };
  const disabledScheduler = createCanvasScheduler({
    db, workerId: 'disabled-worker', adapter: disabledAdapter, storageRoot: path.join(root, 'storage'),
    execution: { facade: runtime.facade, instance: identity }, pollIntervalMs: 1, globalLimit: 1,
  });
  extraSchedulers.push(disabledScheduler);
  await disabledScheduler.tick();
  await waitFor(() => accepted.readTask()?.providerTaskId !== null, '停用前任务应已受理');
  db.prepare("UPDATE team_users SET status = 'disabled', updatedAt = ? WHERE id = 'user-a'").run(now);
  runWithAccessContext(access, () => requestCanvasTaskCancel(db, { taskId: accepted.taskId }));
  releaseAccepted = true;
  await waitFor(() => accepted.readTask()?.phase === 'succeeded', '已受理任务在停用/取消后仍应收取');
  await disabledScheduler.tick();
  await disabledScheduler.drain();
  assert.equal(blocked.readTask()?.phase, 'queued');
  assert.equal(blocked.readTask()?.errorCode, 'actor_disabled');
  assert.match(blocked.readTask()?.errorMessage ?? '', /已停用|已受理/);
  assert.equal(blocked.readTask()?.slotHeld, false);
  assert.deepEqual(disabledSubmissions, [accepted.taskId], '停用后不得提交新的付费任务');
  const acceptedAssetId = accepted.readTask()?.outputAssetId;
  assert.ok(acceptedAssetId);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM team_file_references
    WHERE resourceType = 'canvas_asset' AND resourceId = ? AND role = 'output'`).get(acceptedAssetId) as { count: number }).count), 1,
  '停用后收取的产物仍须完成 team_files 登记');

  // ZIP 固定选中生成节点的当前结果；跨用户图、文件与导出身份均拒绝。
  const exported = await runWithAccessContext(access, () => createCanvasExport({
    db, canvasId, storageRoot: path.join(root, 'storage'), nodeIds: ['image-node'],
  }));
  assert.equal(exported.status, 'ready');
  assert.deepEqual(exported.manifest.items.map((item) => item.assetId), [readTask()?.outputAssetId]);
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS count FROM team_file_references
    WHERE resourceType = 'canvas_export' AND resourceId = ? AND role = 'export'`).get(exported.id) as { count: number }).count), 1);
  assert.throws(() => runWithAccessContext(accessB, () => requireCanvas(db, canvasId)), /无权|不存在/);
  assert.throws(() => runWithAccessContext(accessB, () => readCanvasAsset({
    db, storageRoot: path.join(root, 'storage'), assetId: readTask()?.outputAssetId ?? '',
  })), /无权|不存在/);
  assert.throws(() => runWithAccessContext(accessB, () => requireCanvasExport(db, exported.id)), /无权|不存在/);

  const otherCanvasId = runWithAccessContext(accessB, () => createCanvas(db, { name: '越权引用画布' }).id);
  runWithAccessContext(accessB, () => saveCanvasGraph({
    db, canvasId: otherCanvasId, expectedGraphRevision: 0,
    graph: {
      schemaVersion: 1,
      nodes: [
        { id: 'foreign-material', kind: 'material', position: { x: 0, y: 0 }, data: {
          title: '他人结果', assetId: readTask()?.outputAssetId ?? '', mediaKind: 'image',
        } },
        { id: 'foreign-generation', kind: 'image-generation', position: { x: 0, y: 0 }, data: {
          title: '越权生成', modelKey: 'fixture-execution-image', generationMode: 'image-to-image',
          prompt: '不得使用他人素材', parameters: {}, references: [], referenceLabelCounter: 0,
        } },
      ],
      edges: [{ id: 'foreign-edge', source: 'foreign-material', target: 'foreign-generation' }],
    },
  }));
  assert.throws(() => runWithAccessContext(accessB, () => startCanvasRun({
    db,
    request: { canvasId: otherCanvasId, mode: 'single', targetNodeId: 'foreign-generation', requestKey: 'foreign-run' },
  })), /文件不可用|无权|不存在/);

  console.log('creative-canvas-execution.test.ts 通过');
} finally {
  await scheduler.stop();
  for (const extra of extraSchedulers) await extra.stop();
  runtime.closeNewWork();
  clearCanvasCapabilities();
  db.close();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
