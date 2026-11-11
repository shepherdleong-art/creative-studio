import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-canvas-kling-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-canvas-kling-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-canvas-kling-instance',
  CREATIVE_STUDIO_PORT: '43131',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_TEST_ROOT: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'company',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { ensureCreativeCanvasSchemaReady } = await import('../lib/creative-canvas/schema.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { createTeamExecutionRuntime } = await import('../lib/team-service/bootstrap.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { createTeamAccessContext } = await import('../lib/team-service/resource-scopes.ts');
const { runWithAccessContext } = await import('../lib/media-core/access-context.ts');
const { createCanvas, saveCanvasGraph } = await import('../lib/creative-canvas/repository.ts');
const { canvasStorageRoot, importCanvasAsset } = await import('../lib/creative-canvas/assets.ts');
const { startCanvasRun } = await import('../lib/creative-canvas/runs.ts');
const { planCanvasRun } = await import('../lib/creative-canvas/planner.ts');
const {
  claimCanvasTasks,
  getCanvasTask,
  resolveCanvasTaskInputs,
  updateCanvasTaskUnGuarded,
} = await import('../lib/creative-canvas/tasks.ts');
const { runCanvasTask } = await import('../lib/creative-canvas/runner.ts');
const {
  retryCanvasTaskDownload,
  requestCanvasTaskCancel,
} = await import('../lib/creative-canvas/recovery.ts');
const { CanvasAdapterError } = await import('../lib/creative-canvas/adapters/types.ts');
const {
  clearCanvasCapabilities,
  findCanvasCapability,
} = await import('../lib/creative-canvas/capabilities.ts');
const { ensureCanvasCapabilitiesRegistered } = await import('../lib/creative-canvas/capabilities-bootstrap.ts');
const {
  COMPANY_CANVAS_KLING_3_0_CAPABILITY,
  COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY,
  COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY,
  COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY,
} = await import('../lib/creative-canvas/adapters/company-capabilities.ts');
const {
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const { isCanvasUnifiedMediaTask } = await import('../lib/creative-canvas/unified-media.ts');
const { isCanvasUnifiedKlingTask } = await import('../lib/creative-canvas/unified-kling.ts');
const { freezeUnifiedKlingVideoRequest } = await import('../lib/media-core/unified-media/video-requests.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { createCompanyCanvasAdapter } = await import('../lib/creative-canvas/adapters/company.ts');
const { createDefaultCanvasDeliverer } = await import('../lib/creative-canvas/adapters/media-delivery.ts');

const db = getDb();
seedProviders();
const readiness = await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
assert.equal(readiness.available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.notEqual(
  (await ensureCreativeCanvasSchemaReady({ db, backupRoot: path.join(root, 'canvas-backups') })).state,
  'compatibility_only',
);

const now = new Date().toISOString();
db.prepare(`INSERT INTO team_users (
  id, employeeId, displayName, role, status, passwordHash, mustChangePassword,
  sessionVersion, createdAt, updatedAt
) VALUES ('canvas-user', '0001', '画布员工', 'employee', 'active', 'hash', 0, 1, ?, ?)`)
  .run(now, now);
const principal = {
  kind: 'user' as const,
  userId: 'canvas-user',
  employeeId: '0001',
  displayName: '画布员工',
  role: 'employee' as const,
  sessionId: 'canvas-session',
  sessionVersion: 1,
  mustChangePassword: false,
  absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
};
const access = createTeamAccessContext({ db, principal });
updateActorPolicy(db, {
  actorId: 'canvas-user',
  monthlyLimitMinor: null,
  personalConcurrency: 10,
  concurrencyMode: 'fixed',
  paused: false,
  expectedVersion: 0,
});
const identity = { instanceId: 'unified-canvas-kling-instance', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'unified-canvas-kling-test' });
const runtime = createTeamExecutionRuntime({
  config: {
    mode: 'server',
    dataRoot: root,
    hostname: '127.0.0.1',
    port: 43131,
    deploymentId: 'unified-canvas-kling-test',
    trustedOrigin: 'https://studio.example.test',
  },
  db,
});
await runtime.lifecycle.start({
  ...identity,
  deploymentId: 'unified-canvas-kling-test',
  signal: new AbortController().signal,
});

const qiniu = UNIFIED_KLING3_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
const tencent = UNIFIED_KLING3_CHANNELS.find((channel) => channel.channelKey === 'tencent')!;
const qiniuBase = 'https://qiniu.canvas.kling.test';
const tencentBase = 'https://tencent.canvas.kling.test';
const qiniuKey = 'canvas-kling-qiniu-key';
const tencentKey = 'canvas-kling-tencent-key';
db.prepare(`UPDATE video_providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run(qiniuBase, qiniuKey, qiniu.providerId);
db.prepare(`UPDATE video_providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run(tencentBase, tencentKey, tencent.providerId);
const qiniuPool = configureLegacyMediaProviderPool({
  baseUrl: qiniuBase, apiKey: qiniuKey, capacity: 10,
});
const tencentPool = configureLegacyMediaProviderPool({
  baseUrl: tencentBase, apiKey: tencentKey, capacity: 10,
});
const imageQiniu = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
const imageQiniuBase = 'https://qiniu.canvas.image.chain.test';
const imageQiniuKey = 'canvas-image-chain-key';
db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run(imageQiniuBase, imageQiniuKey, imageQiniu.providerId);
configureLegacyMediaProviderPool({
  baseUrl: imageQiniuBase, apiKey: imageQiniuKey, capacity: 10,
});

process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
clearCanvasCapabilities();
const available = ensureCanvasCapabilitiesRegistered(db);
const unifiedCapability = available.find((capability) =>
  capability.key === COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key);
assert.ok(unifiedCapability, 'server canvas must expose one unified 可灵 3.0');
assert.deepEqual(unifiedCapability?.modes, ['image-to-video']);
assert.equal(available.some((capability) =>
  capability.key !== COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key
  &&
  capability.mediaKind === 'video'
  && [UNIFIED_KLING3_MODEL_KEY, `qiniuyun/${UNIFIED_KLING3_MODEL_KEY}`]
    .includes(capability.modelAlias)), false);
assert.ok(findCanvasCapability(COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key),
  'old exact qiniu capability remains recoverable');
assert.ok(findCanvasCapability(COMPANY_CANVAS_KLING_3_0_CAPABILITY.key),
  'old exact tencent capability remains recoverable');
assert.throws(
  () => freezeUnifiedKlingVideoRequest({
    sourceImageId: 'first',
    tailImageId: 'tail',
    referenceAssetIds: [],
    prompt: '首尾帧',
    durationSec: 5,
    generationMode: 'image-to-video',
    multiShot: false,
    aspectRatio: '3:4',
    resolution: '4K',
  }),
  /组合|通道/,
  'unverified 4K tail-frame must be rejected instead of silently falling back to 1080P',
);

const storageRoot = canvasStorageRoot(root);
const imageBytes = await sharp({
  create: { width: 64, height: 80, channels: 3, background: '#627a91' },
}).png().toBuffer();
const videoBytes = Buffer.from('fake-mp4-bytes');

async function makeAsset(canvasId: string, name: string): Promise<string> {
  const asset = await runWithAccessContext(access, () => importCanvasAsset({
    db,
    canvasId,
    storageRoot,
    filename: name,
    mimeType: 'image/png',
    data: imageBytes,
  }));
  return asset.id;
}

async function createVideoTask(input: {
  name: string;
  modelKey?: string;
  generationMode?: string;
  parameters?: Record<string, string | number | boolean>;
  withTail?: boolean;
}) {
  const canvas = runWithAccessContext(access, () => createCanvas(db, { name: input.name }));
  const nodeId = `node-${crypto.randomUUID()}`;
  const firstAsset = await makeAsset(canvas.id, `${input.name}-first.png`);
  const tailAsset = input.withTail ? await makeAsset(canvas.id, `${input.name}-tail.png`) : null;
  const nodes: Array<Record<string, unknown>> = [{
    id: 'material-first',
    kind: 'material',
    position: { x: 0, y: 0 },
    data: { title: '首帧', assetId: firstAsset, mediaKind: 'image' },
  }];
  const edges: Array<{ id: string; source: string; target: string }> = [{
    id: 'edge-first', source: 'material-first', target: nodeId,
  }];
  if (tailAsset) {
    nodes.push({
      id: 'material-tail',
      kind: 'material',
      position: { x: 0, y: 180 },
      data: { title: '尾帧', assetId: tailAsset, mediaKind: 'image' },
    });
    edges.push({ id: 'edge-tail', source: 'material-tail', target: nodeId });
  }
  nodes.push({
    id: nodeId,
    kind: 'video-generation',
    position: { x: 320, y: 0 },
    data: {
      title: input.name,
      modelKey: input.modelKey ?? COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key,
      generationMode: input.generationMode ?? 'image-to-video',
      prompt: `prompt-${input.name}`,
      parameters: input.parameters ?? (
        input.modelKey === COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key
          ? { durationSec: 5, multiShot: true }
          : { durationSec: 5, aspectRatio: '3:4', resolution: '1K', multiShot: true }
      ),
      references: [],
      referenceLabelCounter: 0,
    },
  });
  runWithAccessContext(access, () => saveCanvasGraph({
    db,
    canvasId: canvas.id,
    expectedGraphRevision: 0,
    graph: { schemaVersion: 1, nodes, edges },
  }));
  const task = runWithAccessContext(access, () => startCanvasRun({
    db,
    request: {
      canvasId: canvas.id,
      mode: 'single',
      targetNodeId: nodeId,
      requestKey: `run-${input.name}`,
    },
  })).tasks[0]!;
  return {
    canvasId: canvas.id,
    nodeId,
    task,
    readTask: () => {
      const current = runWithAccessContext(access, () => getCanvasTask(db, task.id));
      assert.ok(current);
      return current;
    },
  };
}

type Scenario = Awaited<ReturnType<typeof createVideoTask>>;

function parentFor(taskId: string) {
  return db.prepare(`SELECT id, status, currentChannelKey, waitReason, waitDetailJson,
      nextEligibleAt, sourceType, sourceId, actorId, unifiedModel, ruleVersion
    FROM execution_media_tasks WHERE taskKey = ?`).get(`canvas:${taskId}`) as
    | Record<string, unknown>
    | undefined;
}

function claim(taskId: string) {
  const workerId = `worker-${crypto.randomUUID()}`;
  const claimed = runWithAccessContext(access, () => claimCanvasTasks({
    db, workerId, limit: 20,
  })).find((candidate) => candidate.task.id === taskId);
  return claimed ? { ...claimed, workerId } : null;
}

async function execute(
  scenario: Scenario,
  adapter: Parameters<typeof runCanvasTask>[0]['adapter'],
  maxPollAttempts = 10,
) {
  const claimed = claim(scenario.task.id);
  assert.ok(claimed, 'task should be claimable');
  return runCanvasTask({
    db,
    taskId: scenario.task.id,
    adapter,
    execution: { facade: runtime.facade, instance: identity },
    workerId: claimed.workerId,
    fence: claimed.fence,
    storageRoot,
    pollIntervalMs: 0,
    maxPollAttempts,
    sleep: async () => {},
  });
}

type Hooks = {
  submit?: (context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) =>
    Promise<{ providerTaskId: string }>;
  poll?: (context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) =>
    Promise<import('../lib/creative-canvas/adapters/types.ts').CanvasPollOutcome>;
  download?: () => Promise<{ bytes: Buffer; mimeType: string }>;
};

function fakeAdapter(hooks: Hooks = {}) {
  const prepares: Array<{ providerIdentity: string; modelAlias: string; capabilityKey: string }> = [];
  const submissions: Array<{
    providerIdentity: string;
    modelAlias: string;
    parameters: Record<string, string | number | boolean>;
  }> = [];
  return Object.assign({
    kind: 'unified-canvas-kling-fixture',
    prepares,
    submissions,
    async prepare(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      prepares.push({
        providerIdentity: context.providerIdentity,
        modelAlias: context.modelAlias,
        capabilityKey: context.capabilityKey,
      });
    },
    async submit(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      submissions.push({
        providerIdentity: context.providerIdentity,
        modelAlias: context.modelAlias,
        parameters: { ...context.parameters },
      });
      return hooks.submit ? hooks.submit(context) : {
        providerTaskId: `remote-${context.providerIdentity}`,
      };
    },
    async poll(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      return hooks.poll ? hooks.poll(context) : { status: 'succeeded' as const };
    },
    async download() {
      return hooks.download ? hooks.download() : { bytes: videoBytes, mimeType: 'video/mp4' };
    },
  });
}

try {
  // 1. Qiniu first, exact actual channel, one canvas asset and no legacy jobs.
  {
    const scenario = await createVideoTask({ name: 'qiniu-ok', withTail: true });
    assert.equal(isCanvasUnifiedMediaTask(scenario.readTask()), true);
    assert.equal(isCanvasUnifiedKlingTask(scenario.readTask()), true);
    const snapshot = JSON.parse(scenario.readTask().providerSnapshot) as Record<string, unknown>;
    assert.equal(snapshot.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
    assert.equal(snapshot.unifiedRuleVersion, UNIFIED_MEDIA_RULE_VERSION);
    const adapter = fakeAdapter();
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'succeeded', outcome.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(adapter.submissions[0]?.providerIdentity, qiniu.providerId);
    assert.equal(adapter.submissions[0]?.modelAlias, qiniu.model);
    assert.equal(adapter.submissions[0]?.parameters.durationSec, 5);
    assert.equal(adapter.submissions[0]?.parameters.multiShot, true);
    assert.ok(scenario.readTask().outputAssetId);
    const parent = parentFor(scenario.task.id)!;
    assert.equal(parent.status, 'succeeded');
    assert.equal(parent.sourceType, 'canvas_node');
    assert.equal(parent.sourceId, scenario.canvasId);
    assert.equal(parent.actorId, 'canvas-user');
    assert.equal(parent.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
    assert.equal(parent.ruleVersion, UNIFIED_MEDIA_RULE_VERSION);
    const operation = db.prepare(`SELECT mediaTaskId, channelKey, providerSnapshotJson
      FROM execution_operations WHERE taskId = ?`).get(scenario.task.id) as Record<string, unknown>;
    assert.equal(operation.mediaTaskId, parent.id);
    assert.equal(operation.channelKey, 'qiniu');
    assert.equal(
      (JSON.parse(String(operation.providerSnapshotJson)) as Record<string, unknown>).unifiedModel,
      UNIFIED_KLING3_MODEL_KEY,
    );
    assert.equal((db.prepare('SELECT COUNT(*) FROM jobs WHERE id = ?').pluck()
      .get(scenario.task.id) as number), 0);
    assert.equal((db.prepare('SELECT COUNT(*) FROM video_jobs WHERE id = ?').pluck()
      .get(scenario.task.id) as number), 0);
    assert.equal((db.prepare('SELECT COUNT(*) FROM creative_canvas_assets WHERE sourceTaskId = ?')
      .pluck().get(scenario.task.id) as number), 1);
    const employeeTask = listTeamTasks(db, {
      userId: 'canvas-user', role: 'employee',
    }).items.find((item) => item.taskId === scenario.task.id);
    assert.equal(employeeTask?.unifiedModel, UNIFIED_KLING3_MODEL_KEY);
    assert.equal(employeeTask?.unifiedTaskId, parent.id);
    assert.equal(employeeTask?.model, '可灵 3.0');
    assert.ok((employeeTask?.unifiedTaskCostMinor ?? 0) > 0);
    assert.equal(
      JSON.stringify(employeeTask?.modelCalls).includes(qiniu.providerId),
      false,
      'employee projection must not expose the actual channel identity',
    );
  }

  // 2. Explicit qiniu rejection switches to tencent on the same canvas task.
  {
    const scenario = await createVideoTask({ name: 'qiniu-fallback' });
    const adapter = fakeAdapter({
      submit: async (context) => {
        if (context.providerIdentity === qiniu.providerId) {
          throw new CanvasAdapterError('submit', '七牛明确拒绝', {
            uncertain: false,
            code: 'provider_http_400',
            httpStatus: 400,
          });
        }
        return { providerTaskId: 'tencent-kling-result' };
      },
    });
    const first = await execute(scenario, adapter);
    assert.equal(first.phase, 'queued');
    assert.equal(adapter.submissions.length, 1);
    let parent = parentFor(scenario.task.id)!;
    assert.equal(parent.currentChannelKey, 'tencent');
    const second = await execute(scenario, adapter);
    assert.equal(second.phase, 'succeeded', second.errorCode ?? '');
    assert.equal(adapter.submissions.length, 2);
    assert.equal(adapter.submissions[1]?.providerIdentity, tencent.providerId);
    parent = parentFor(scenario.task.id)!;
    assert.equal(parent.currentChannelKey, 'tencent');
    assert.equal(parent.status, 'succeeded');
  }

  // 3. Qiniu capacity full spills immediately; no image-style 30 second wait.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    try {
      const scenario = await createVideoTask({ name: 'capacity-immediate' });
      const adapter = fakeAdapter();
      const spilled = await execute(scenario, adapter);
      assert.equal(spilled.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      let parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'tencent');
      assert.equal(parent.status, 'routing');
      assert.equal(parent.waitReason, null);
      const qiniuState = db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).get(parent.id) as { state: string };
      assert.equal(qiniuState.state, 'overflowed');
      const done = await execute(scenario, adapter);
      assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
      assert.equal(adapter.submissions.length, 1);
      assert.equal(adapter.submissions[0]?.providerIdentity, tencent.providerId);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'tencent');
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
    }
  }

  // 3a. If both pools are full, the tencent attempt waits without consuming a POST.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey IN (?, ?)')
      .run(qiniuPool, tencentPool);
    try {
      const scenario = await createVideoTask({ name: 'capacity-wait' });
      const adapter = fakeAdapter();
      const spilled = await execute(scenario, adapter);
      assert.equal(spilled.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      const waiting = await execute(scenario, adapter);
      assert.equal(waiting.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      const parent = parentFor(scenario.task.id)!;
      assert.equal(parent.status, 'waiting');
      assert.equal(parent.currentChannelKey, 'tencent');
      assert.equal(parent.waitReason, 'pool_capacity');
      assert.ok(parent.nextEligibleAt);
      assert.equal(claim(scenario.task.id), null, 'future video capacity deadline must not be claimed');
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(tencentPool);
      const past = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE execution_media_tasks SET nextEligibleAt = ? WHERE id = ?`)
        .run(past, parent.id);
      db.prepare(`UPDATE execution_media_channels SET nextEligibleAt = ? WHERE mediaTaskId = ?
        AND channelKey = 'tencent'`).run(past, parent.id);
      const done = await execute(scenario, adapter);
      assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
      assert.equal(adapter.submissions.length, 1);
      assert.equal(adapter.submissions[0]?.providerIdentity, tencent.providerId);
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey IN (?, ?)')
        .run(qiniuPool, tencentPool);
    }
  }

  // 3b. 4K is tencent-only for Kling 3.0.
  {
    const scenario = await createVideoTask({
      name: 'tencent-only-4k',
      parameters: { durationSec: 5, aspectRatio: '3:4', resolution: '4K', multiShot: false },
    });
    const adapter = fakeAdapter();
    const done = await execute(scenario, adapter);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(adapter.submissions[0]?.providerIdentity, tencent.providerId);
  }

  // 4. Unknown submission stays on qiniu and never consumes tencent.
  {
    const scenario = await createVideoTask({ name: 'unknown-submit' });
    const adapter = fakeAdapter({
      submit: async () => {
        throw new CanvasAdapterError('submit', '响应丢失', {
          uncertain: true,
          code: 'provider_http_503',
          httpStatus: 503,
        });
      },
    });
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'uncertain');
    assert.equal(adapter.submissions.length, 1);
    const parent = parentFor(scenario.task.id)!;
    assert.equal(parent.status, 'unknown');
    assert.equal(parent.currentChannelKey, 'qiniu');
    assert.equal(claim(scenario.task.id), null);
  }

  // 5. Accepted remote resumes without a second submit.
  {
    const scenario = await createVideoTask({ name: 'resume-accepted' });
    const firstAdapter = fakeAdapter({
      poll: async () => ({ status: 'running' }),
    });
    const first = await execute(scenario, firstAdapter, 0);
    assert.equal(first.phase, 'polling');
    assert.equal(firstAdapter.submissions.length, 1);
    runWithAccessContext(access, () => updateCanvasTaskUnGuarded(db, scenario.task.id, {
      leaseOwner: null,
      leaseUntil: null,
    }));
    const resumed = fakeAdapter();
    const done = await execute(scenario, resumed, 10);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(resumed.submissions.length, 0);
    assert.equal(firstAdapter.submissions.length, 1);
  }

  // 5a. A local poll query failure keeps the accepted qiniu identity and never falls back.
  {
    const scenario = await createVideoTask({ name: 'poll-query-failure' });
    const failing = fakeAdapter({
      poll: async () => {
        throw new CanvasAdapterError('poll', '查询超时', { code: 'gateway_poll_failed' });
      },
    });
    const first = await execute(scenario, failing, 1);
    assert.equal(first.phase, 'polling');
    assert.equal(failing.submissions.length, 1);
    assert.equal(parentFor(scenario.task.id)?.currentChannelKey, 'qiniu');
    runWithAccessContext(access, () => updateCanvasTaskUnGuarded(db, scenario.task.id, {
      leaseOwner: null,
      leaseUntil: null,
    }));
    const resumed = fakeAdapter();
    const done = await execute(scenario, resumed, 10);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(resumed.submissions.length, 0);
    assert.equal(failing.submissions.length, 1);
  }

  // 6. Download failure retries the original result only.
  {
    const scenario = await createVideoTask({ name: 'download-retry' });
    let downloads = 0;
    const adapter = fakeAdapter({
      download: async () => {
        downloads += 1;
        if (downloads === 1) {
          throw new CanvasAdapterError('download', '本地写入失败', { code: 'download_failed' });
        }
        return { bytes: videoBytes, mimeType: 'video/mp4' };
      },
    });
    const first = await execute(scenario, adapter);
    assert.equal(first.phase, 'download_failed');
    assert.equal(adapter.submissions.length, 1);
    runWithAccessContext(access, () => retryCanvasTaskDownload(db, { taskId: scenario.task.id }));
    const done = await execute(scenario, adapter);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
  }

  // 7. Unsupported text-to-video mode and resolution are rejected before a task.
  {
    const canvas = runWithAccessContext(access, () => createCanvas(db, { name: 'invalid-mode' }));
    const nodeId = 'invalid-kling';
    runWithAccessContext(access, () => saveCanvasGraph({
      db,
      canvasId: canvas.id,
      expectedGraphRevision: 0,
      graph: {
        schemaVersion: 1,
        nodes: [{
          id: nodeId,
          kind: 'video-generation',
          position: { x: 0, y: 0 },
          data: {
            title: '非法模式',
            modelKey: COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key,
            generationMode: 'text-to-video',
            prompt: 'test',
            parameters: { durationSec: 5, aspectRatio: '3:4', resolution: '1K', multiShot: false },
            references: [],
            referenceLabelCounter: 0,
          },
        }],
        edges: [],
      },
    }));
    const plan = runWithAccessContext(access, () => planCanvasRun(db, {
      canvasId: canvas.id,
      mode: 'single',
      targetNodeId: nodeId,
      requestKey: 'invalid-mode-plan',
    }));
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.problems[0]?.message ?? '', /模式|支持/);
  }

  // 8. Cancel while waiting stops every future channel without POST.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(tencentPool);
    try {
      const scenario = await createVideoTask({ name: 'cancel-waiting' });
      const adapter = fakeAdapter();
      const waiting = await execute(scenario, adapter);
      assert.equal(waiting.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      runWithAccessContext(access, () => requestCanvasTaskCancel(db, { taskId: scenario.task.id }));
      assert.equal(scenario.readTask().phase, 'cancelled');
      assert.equal(claim(scenario.task.id), null);
      assert.equal(adapter.submissions.length, 0);
      assert.equal(parentFor(scenario.task.id)?.status, 'canceled');
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(tencentPool);
    }
  }

  // 8b. Accepted cancel retains the late video but never publishes it.
  {
    const scenario = await createVideoTask({ name: 'cancel-late-result' });
    const adapter = fakeAdapter({
      download: async () => {
        runWithAccessContext(access, () => requestCanvasTaskCancel(db, { taskId: scenario.task.id }));
        return { bytes: videoBytes, mimeType: 'video/mp4' };
      },
    });
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'cancelled');
    assert.ok(outcome.outputAssetId);
    const task = scenario.readTask();
    assert.equal(task.phase, 'cancelled');
    assert.equal(task.outputAssetId, outcome.outputAssetId);
    const nodeState = db.prepare(`SELECT currentAssetId, resultTaskId
      FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`)
      .get(scenario.canvasId, scenario.nodeId) as {
        currentAssetId: string | null; resultTaskId: string | null;
      };
    assert.equal(nodeState.currentAssetId, null);
    assert.equal(nodeState.resultTaskId, null);
    const parent = db.prepare(`SELECT id, status, resultJson FROM execution_media_tasks
      WHERE taskKey = ?`).get(`canvas:${task.id}`) as {
        id: string; status: string; resultJson: string;
      };
    assert.equal(parent.status, 'canceled');
    const result = JSON.parse(parent.resultJson) as Record<string, unknown>;
    assert.equal(result.lateResult, true);
    assert.equal(result.outputAssetId, outcome.outputAssetId);
    assert.equal(
      db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(parent.id),
      'succeeded',
    );
  }

  // 9. Old exact Kling snapshots stay on the legacy path.
  {
    const scenario = await createVideoTask({
      name: 'legacy-exact',
      modelKey: COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.key,
    });
    assert.equal(isCanvasUnifiedMediaTask(scenario.readTask()), false);
    const adapter = fakeAdapter();
    const done = await execute(scenario, adapter);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(parentFor(scenario.task.id), undefined);
  }

  // 9a. A unified image node feeds a unified Kling node; downstream runs once with the frozen asset.
  {
    const canvas = runWithAccessContext(access, () => createCanvas(db, { name: 'image-to-kling-chain' }));
    const seedAsset = await makeAsset(canvas.id, 'chain-seed.png');
    const imageNodeId = 'chain-image';
    const videoNodeId = 'chain-video';
    runWithAccessContext(access, () => saveCanvasGraph({
      db,
      canvasId: canvas.id,
      expectedGraphRevision: 0,
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'chain-material',
            kind: 'material',
            position: { x: 0, y: 0 },
            data: { title: '产品', assetId: seedAsset, mediaKind: 'image' },
          },
          {
            id: imageNodeId,
            kind: 'image-generation',
            position: { x: 280, y: 0 },
            data: {
              title: '场景图',
              modelKey: COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key,
              generationMode: 'image-to-image',
              prompt: '保持产品不变，更换场景',
              parameters: { aspectRatio: '3:4', resolution: '2K' },
              references: [],
              referenceLabelCounter: 0,
            },
          },
          {
            id: videoNodeId,
            kind: 'video-generation',
            position: { x: 620, y: 0 },
            data: {
              title: '可灵成片',
              modelKey: COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key,
              generationMode: 'image-to-video',
              prompt: '镜头缓慢推进',
              parameters: {
                durationSec: 5,
                aspectRatio: '3:4',
                resolution: '1K',
                multiShot: true,
              },
              references: [],
              referenceLabelCounter: 0,
            },
          },
        ],
        edges: [
          { id: 'chain-edge-image', source: 'chain-material', target: imageNodeId },
          { id: 'chain-edge-video', source: imageNodeId, target: videoNodeId },
        ],
      },
    }));
    const run = runWithAccessContext(access, () => startCanvasRun({
      db,
      request: {
        canvasId: canvas.id,
        mode: 'branch',
        startNodeId: imageNodeId,
        targetNodeId: videoNodeId,
        requestKey: 'run-image-to-kling-chain',
      },
    }));
    const imageTask = run.tasks.find((task) => task.mediaKind === 'image');
    const videoTask = run.tasks.find((task) => task.mediaKind === 'video');
    assert.ok(imageTask);
    assert.ok(videoTask);
    assert.equal(videoTask.phase, 'waiting_input');

    const chainAdapter = {
      kind: 'unified-chain-fixture',
      async prepare() {},
      async submit(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
        return { providerTaskId: `remote-${context.mediaKind}` };
      },
      async poll() {
        return { status: 'succeeded' as const };
      },
      async download(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
        return context.mediaKind === 'image'
          ? { bytes: imageBytes, mimeType: 'image/png' }
          : { bytes: videoBytes, mimeType: 'video/mp4' };
      },
    };
    const imageClaim = claim(imageTask.id);
    assert.ok(imageClaim);
    const imageOutcome = await runCanvasTask({
      db,
      taskId: imageTask.id,
      adapter: chainAdapter,
      execution: { facade: runtime.facade, instance: identity },
      workerId: imageClaim.workerId,
      fence: imageClaim.fence,
      storageRoot,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(imageOutcome.phase, 'succeeded', imageOutcome.errorCode ?? '');
    runWithAccessContext(access, () => resolveCanvasTaskInputs(db));
    assert.equal(
      runWithAccessContext(access, () => getCanvasTask(db, videoTask.id))?.phase,
      'queued',
      'video node should be promoted only after the image result is available',
    );
    const videoClaim = claim(videoTask.id);
    assert.ok(videoClaim);
    const videoOutcome = await runCanvasTask({
      db,
      taskId: videoTask.id,
      adapter: chainAdapter,
      execution: { facade: runtime.facade, instance: identity },
      workerId: videoClaim.workerId,
      fence: videoClaim.fence,
      storageRoot,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(videoOutcome.phase, 'succeeded', videoOutcome.errorCode ?? '');
    const resolvedInput = db.prepare(`SELECT resolvedAssetId FROM creative_canvas_task_inputs
      WHERE taskId = ? ORDER BY orderIndex LIMIT 1`).get(videoTask.id) as
      | { resolvedAssetId: string | null }
      | undefined;
    assert.equal(resolvedInput?.resolvedAssetId, imageOutcome.outputAssetId);
    assert.equal((db.prepare('SELECT COUNT(*) FROM creative_canvas_assets WHERE sourceTaskId = ?')
      .pluck().get(videoTask.id) as number), 1);
  }

  // 10. Provider wire contract preserves intelligent storyboard for both channels.
  {
    type Captured = { url: string; body: Record<string, unknown> };
    const captured: Captured[] = [];
    const baseContext: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext = {
      task: {} as never,
      mediaKind: 'video',
      generationMode: 'image-to-video',
      prompt: '产品缓慢推进',
      parameters: {
        durationSec: 7,
        aspectRatio: '3:4',
        resolution: '1K',
        multiShot: true,
      },
      capabilityKey: '',
      providerIdentity: '',
      modelAlias: '',
      inputs: [
        {
          refId: 'first', orderIndex: 0, role: 'first-frame', note: '', kind: 'image',
          assetId: 'asset-first', absolutePath: path.join(root, 'first.png'),
          mimeType: 'image/png', byteSize: imageBytes.length, durationSec: null,
          textContent: null, upstreamTaskId: null, record: {} as never,
          deliveryRef: 'https://delivery.example/first.png',
        },
        {
          refId: 'tail', orderIndex: 1, role: 'last-frame', note: '', kind: 'image',
          assetId: 'asset-tail', absolutePath: path.join(root, 'tail.png'),
          mimeType: 'image/png', byteSize: imageBytes.length, durationSec: null,
          textContent: null, upstreamTaskId: null, record: {} as never,
          deliveryRef: 'https://delivery.example/tail.png',
        },
      ],
    };
    fs.writeFileSync(path.join(root, 'first.png'), imageBytes);
    fs.writeFileSync(path.join(root, 'tail.png'), imageBytes);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Response.json({ id: 'captured-task', status: 'queued' });
    }) as typeof fetch;
    const adapter = createCompanyCanvasAdapter({
      db,
      deliverer: createDefaultCanvasDeliverer(),
      fetchImpl,
      submitTimeoutMs: 2_000,
    });
    const qiniuCapability = findCanvasCapability(
      `${COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key}:channel:qiniu`,
    );
    const tencentCapability = findCanvasCapability(
      `${COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key}:channel:tencent`,
    );
    assert.ok(qiniuCapability);
    assert.ok(tencentCapability);
    await adapter.submit({
      ...baseContext,
      capabilityKey: qiniuCapability.key,
      providerIdentity: qiniu.providerId,
      modelAlias: qiniu.model,
    });
    await adapter.submit({
      ...baseContext,
      capabilityKey: tencentCapability.key,
      providerIdentity: tencent.providerId,
      modelAlias: tencent.model,
    });
    await adapter.submit({
      ...baseContext,
      capabilityKey: qiniuCapability.key,
      providerIdentity: qiniu.providerId,
      modelAlias: qiniu.model,
      parameters: { ...baseContext.parameters, multiShot: false },
    });
    await adapter.submit({
      ...baseContext,
      capabilityKey: tencentCapability.key,
      providerIdentity: tencent.providerId,
      modelAlias: tencent.model,
      parameters: { ...baseContext.parameters, multiShot: false },
    });
    await adapter.submit({
      ...baseContext,
      capabilityKey: qiniuCapability.key,
      providerIdentity: qiniu.providerId,
      modelAlias: qiniu.model,
      inputs: baseContext.inputs.slice(0, 1),
      parameters: { ...baseContext.parameters, multiShot: false, resolution: '1K' },
    });
    await adapter.submit({
      ...baseContext,
      capabilityKey: tencentCapability.key,
      providerIdentity: tencent.providerId,
      modelAlias: tencent.model,
      inputs: baseContext.inputs.slice(0, 1),
      parameters: { ...baseContext.parameters, multiShot: false, resolution: '4K' },
    });
    assert.equal(captured.length, 6);
    for (const request of captured.slice(0, 2)) {
      assert.equal(request.body.multi_shot, true);
      assert.equal(request.body.shot_type, 'intelligence');
      assert.equal(request.body.seconds, '7');
    }
    assert.equal(captured[2]?.body.multi_shot, false);
    assert.equal(captured[2]?.body.shot_type, undefined);
    assert.equal(captured[3]?.body.multi_shot, undefined);
    assert.equal(captured[3]?.body.shot_type, undefined);
    assert.equal(captured[0]?.body.end_image_url, 'https://delivery.example/tail.png');
    assert.equal(captured[1]?.body.LastFrameUrl, 'https://delivery.example/tail.png');
    assert.equal(captured[4]?.body.size, '1024x1366');
    assert.equal(captured[5]?.body.size, '2160x2880');
  }

  console.log('unified canvas Kling 3.0 tests passed (paid calls: 0)');
} finally {
  runtime.closeNewWork();
  clearCanvasCapabilities();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
