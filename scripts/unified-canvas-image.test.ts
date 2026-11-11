import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-canvas-image-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-canvas-image-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-canvas-image-instance',
  CREATIVE_STUDIO_PORT: '43121',
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
  COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY,
  COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY,
} = await import('../lib/creative-canvas/adapters/company-capabilities.ts');
const {
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const { isCanvasUnifiedImageTask } = await import('../lib/creative-canvas/unified-image.ts');
const {
  canvasParameterOptions,
  updateCanvasParameter,
} = await import('../lib/creative-canvas/unified-image-options.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { seedProviders } = await import('../lib/seed.ts');
const {
  clearUnifiedChannelHealthAvoidance,
  recordUnifiedChannelFailure,
} = await import('../lib/media-core/unified-media/health.ts');

const db = getDb();
seedProviders();
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
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

const identity = { instanceId: 'unified-canvas-image-instance', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'unified-canvas-image-test' });
const runtime = createTeamExecutionRuntime({
  config: {
    mode: 'server',
    dataRoot: root,
    hostname: '127.0.0.1',
    port: 43121,
    deploymentId: 'unified-canvas-image-test',
    trustedOrigin: 'https://studio.example.test',
  },
  db,
});
await runtime.lifecycle.start({
  ...identity,
  deploymentId: 'unified-canvas-image-test',
  signal: new AbortController().signal,
});

const qiniuModel = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'qiniu')!;
const tencentModel = UNIFIED_IMAGE_CHANNELS.find((channel) => channel.channelKey === 'tencent')!;
const qiniuBase = 'https://qiniu.canvas.test';
const tencentBase = 'https://tencent.canvas.test';
const qiniuKey = 'canvas-qiniu-key';
const tencentKey = 'canvas-tencent-key';
db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run(qiniuBase, qiniuKey, qiniuModel.providerId);
db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ?, enabled = 1 WHERE id = ?`)
  .run(tencentBase, tencentKey, tencentModel.providerId);
const qiniuPool = configureLegacyMediaProviderPool({
  baseUrl: qiniuBase, apiKey: qiniuKey, capacity: 10,
});
const tencentPool = configureLegacyMediaProviderPool({
  baseUrl: tencentBase, apiKey: tencentKey, capacity: 10,
});

clearCanvasCapabilities();
const available = ensureCanvasCapabilitiesRegistered(db);
const unified = available.find((capability) => capability.key === COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key);
assert.ok(unified, 'server canvas must expose one unified Image 2');
assert.equal(available.some((capability) =>
  capability.mediaKind === 'image'
  && ['image2-medium', 'qiniuyun/gpt-image-2-medium'].includes(capability.modelAlias)), false);
assert.ok(findCanvasCapability(COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY.key), 'old exact capability stays recoverable');
assert.deepEqual(
  canvasParameterOptions(COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key, 'resolution',
    ['1K', '2K', '4K'], { aspectRatio: '9:16' }),
  ['2K', '4K'],
);
assert.equal(
  canvasParameterOptions(COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key, 'aspectRatio',
    ['1:1', '3:4', '9:16'], { resolution: '1K' }).includes('9:16'),
  false,
);
assert.deepEqual(
  updateCanvasParameter(COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key, {
    aspectRatio: '1:1', resolution: '1K',
  }, 'aspectRatio', '9:16'),
  { aspectRatio: '9:16', resolution: '2K' },
);

const storageRoot = canvasStorageRoot(root);
const imageBytes = await sharp({
  create: { width: 64, height: 80, channels: 3, background: '#627a91' },
}).png().toBuffer();

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

async function createTask(input: {
  name: string;
  modelKey?: string;
  parameters?: Record<string, string | number | boolean>;
  withImage?: boolean;
}) {
  const canvas = runWithAccessContext(access, () => createCanvas(db, { name: input.name }));
  const nodeId = `node-${crypto.randomUUID()}`;
  const assetId = input.withImage === false ? null : await makeAsset(canvas.id, `${input.name}.png`);
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<{ id: string; source: string; target: string }> = [];
  if (assetId) {
    nodes.push({
      id: 'material', kind: 'material', position: { x: 0, y: 0 },
      data: { title: '素材', assetId, mediaKind: 'image' },
    });
  }
  nodes.push({
    id: nodeId, kind: 'image-generation', position: { x: 320, y: 0 },
    data: {
      title: input.name,
      modelKey: input.modelKey ?? COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key,
      generationMode: assetId ? 'image-to-image' : 'text-to-image',
      prompt: `prompt-${input.name}`,
      parameters: input.parameters ?? { aspectRatio: '3:4', resolution: '2K' },
      references: [], referenceLabelCounter: 0,
    },
  });
  if (assetId) edges.push({ id: 'edge-material', source: 'material', target: nodeId });
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
      assert.ok(current, 'canvas task should exist');
      return current;
    },
  };
}

type CanvasScenario = Awaited<ReturnType<typeof createTask>>;

function parentFor(taskId: string) {
  return db.prepare(`SELECT id, status, currentChannelKey, waitReason, waitDetailJson,
      nextEligibleAt, sourceType, sourceId, actorId, unifiedModel, ruleVersion, resultJson
    FROM execution_media_tasks WHERE taskKey = ?`).get(`canvas:${taskId}`) as Record<string, unknown> | undefined;
}

function claim(taskId: string) {
  const workerId = `worker-${crypto.randomUUID()}`;
  const claimed = runWithAccessContext(access, () => claimCanvasTasks({
    db, workerId, limit: 20,
  })).find((candidate) => candidate.task.id === taskId);
  return claimed ? { ...claimed, workerId } : null;
}

async function execute(
  scenario: CanvasScenario,
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

type AdapterHooks = {
  submit?: (context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) => Promise<{ providerTaskId: string }>;
  poll?: (context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) => Promise<
    import('../lib/creative-canvas/adapters/types.ts').CanvasPollOutcome
  >;
  download?: () => Promise<{ bytes: Buffer; mimeType: string }>;
};

function fakeAdapter(hooks: AdapterHooks = {}) {
  const prepares: Array<{ providerIdentity: string; modelAlias: string; capabilityKey: string }> = [];
  const submissions: Array<{ providerIdentity: string; modelAlias: string }> = [];
  const adapter = {
    kind: 'unified-canvas-fixture',
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
      });
      return hooks.submit ? hooks.submit(context) : { providerTaskId: `remote-${context.providerIdentity}` };
    },
    async poll(context: import('../lib/creative-canvas/adapters/types.ts').CanvasTaskContext) {
      return hooks.poll ? hooks.poll(context) : { status: 'succeeded' as const };
    },
    async download() {
      return hooks.download ? hooks.download() : { bytes: imageBytes, mimeType: 'image/png' };
    },
  };
  return adapter;
}

try {
  // 1. qiniu first, actual channel snapshot, one product.
  {
    const scenario = await createTask({ name: 'qiniu-ok' });
    assert.equal((scenario.readTask().phase), 'queued');
    assert.equal(isCanvasUnifiedImageTask(scenario.readTask()), true);
    const snapshot = JSON.parse(scenario.readTask().providerSnapshot) as Record<string, unknown>;
    assert.equal(snapshot.unifiedModel, UNIFIED_IMAGE_MODEL_KEY);
    assert.equal(snapshot.unifiedRuleVersion, UNIFIED_MEDIA_RULE_VERSION);

    const adapter = fakeAdapter();
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'succeeded', outcome.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(adapter.submissions[0]?.providerIdentity, qiniuModel.providerId);
    assert.equal(adapter.submissions[0]?.modelAlias, qiniuModel.model);
    const task = scenario.readTask();
    assert.ok(task.outputAssetId);
    const parent = parentFor(task.id)!;
    assert.equal(parent.status, 'succeeded');
    assert.equal(parent.sourceType, 'canvas_node');
    assert.equal(parent.sourceId, scenario.canvasId);
    assert.equal(parent.actorId, 'canvas-user');
    assert.equal(parent.currentChannelKey, 'qiniu');
    const channel = db.prepare(`SELECT state, providerId, providerModel FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).get(parent.id) as Record<string, unknown>;
    assert.equal(channel.state, 'succeeded');
    assert.equal(channel.providerId, qiniuModel.providerId);
    assert.equal(channel.providerModel, qiniuModel.model);
    const operation = db.prepare(`SELECT mediaTaskId, channelKey, providerSnapshotJson
      FROM execution_operations WHERE taskId = ?`).get(task.id) as Record<string, unknown>;
    assert.equal(operation.mediaTaskId, parent.id);
    assert.equal(operation.channelKey, 'qiniu');
    assert.equal((JSON.parse(String(operation.providerSnapshotJson)) as Record<string, unknown>).unifiedModel, 'image2');
    assert.equal((db.prepare("SELECT COUNT(*) FROM jobs WHERE id = ?").pluck().get(task.id) as number), 0);
    assert.equal((db.prepare('SELECT COUNT(*) FROM creative_canvas_assets WHERE sourceTaskId = ?')
      .pluck().get(task.id) as number), 1);
  }

  // 2. explicit qiniu rejection -> tencent takes over the same canvas task.
  {
    const scenario = await createTask({ name: 'qiniu-fallback' });
    const adapter = fakeAdapter({
      submit: async (context) => {
        if (context.providerIdentity === qiniuModel.providerId) {
          throw new CanvasAdapterError('submit', '七牛明确拒绝', {
            uncertain: false, code: 'provider_http_400', httpStatus: 400,
          });
        }
        return { providerTaskId: 'tencent-fallback-result' };
      },
    });
    const first = await execute(scenario, adapter);
    assert.equal(first.phase, 'queued');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(adapter.submissions[0]?.providerIdentity, qiniuModel.providerId);
    let parent = parentFor(scenario.task.id)!;
    assert.equal(parent.currentChannelKey, 'tencent');
    assert.equal(parent.status, 'routing');
    const second = await execute(scenario, adapter);
    assert.equal(second.phase, 'succeeded', second.errorCode ?? '');
    assert.equal(adapter.submissions.length, 2);
    assert.equal(adapter.submissions[1]?.providerIdentity, tencentModel.providerId);
    parent = parentFor(scenario.task.id)!;
    assert.equal(parent.status, 'succeeded');
    assert.equal(parent.currentChannelKey, 'tencent');
    const attempts = db.prepare(`SELECT COUNT(*) FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId WHERE o.taskId = ?`).pluck().get(scenario.task.id);
    assert.equal(attempts, 2);
    assert.equal((db.prepare('SELECT COUNT(*) FROM creative_canvas_assets WHERE sourceTaskId = ?')
      .pluck().get(scenario.task.id) as number), 1);
  }

  // 3. invalid complete combination is rejected in planning, before any task.
  {
    const canvas = runWithAccessContext(access, () => createCanvas(db, { name: 'invalid-combination' }));
    const nodeId = 'invalid-image';
    runWithAccessContext(access, () => saveCanvasGraph({
      db,
      canvasId: canvas.id,
      expectedGraphRevision: 0,
      graph: {
        schemaVersion: 1,
        nodes: [{
          id: nodeId, kind: 'image-generation', position: { x: 0, y: 0 },
          data: {
            title: '非法组合',
            modelKey: COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key,
            generationMode: 'text-to-image',
            prompt: 'test',
            parameters: { aspectRatio: '9:16', resolution: '1K' },
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
      requestKey: 'invalid-plan',
    }));
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.problems[0]?.message ?? '', /1K.*9:16|9:16.*1K/);
  }

  // 4. unknown submission never consumes the fallback channel.
  {
    const scenario = await createTask({ name: 'unknown-submit' });
    const adapter = fakeAdapter({
      submit: async () => {
        throw new CanvasAdapterError('submit', '响应丢失', {
          uncertain: true, code: 'provider_http_503', httpStatus: 503,
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

  // 4b. a bypassed invalid combination fails again at the execution boundary before POST.
  {
    const scenario = await createTask({ name: 'invalid-execution' });
    const snapshot = JSON.parse(scenario.task.parameterSnapshot) as {
      generationMode: string;
      prompt: string;
      parameters: Record<string, string | number | boolean>;
    };
    snapshot.parameters.aspectRatio = '9:16';
    snapshot.parameters.resolution = '1K';
    db.prepare('UPDATE creative_canvas_tasks SET parameterSnapshot = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), scenario.task.id);
    const adapter = fakeAdapter();
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'failed');
    assert.equal(adapter.submissions.length, 0);
    assert.match(outcome.errorCode ?? '', /unsupported|invalid/i);
  }

  // 5. qiniu congestion waits, then spills to tencent; no POST consumes qiniu.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    try {
      const scenario = await createTask({ name: 'capacity-spill' });
      const adapter = fakeAdapter();
      const waiting = await execute(scenario, adapter);
      assert.equal(waiting.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      let parent = parentFor(scenario.task.id)!;
      assert.equal(parent.status, 'waiting');
      assert.equal(parent.waitReason, 'pool_capacity');
      assert.ok(parent.nextEligibleAt);
      assert.equal(claim(scenario.task.id), null, 'future congestion deadline must not be claimed');

      const past = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE execution_media_tasks SET nextEligibleAt = ?,
        waitDetailJson = ? WHERE id = ?`).run(
        past,
        JSON.stringify({ reason: 'pool_capacity', nextEligibleAt: past }),
        parent.id,
      );
      db.prepare(`UPDATE execution_media_channels SET nextEligibleAt = ?,
        evidenceJson = ? WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).run(
        past,
        JSON.stringify({ reason: 'pool_capacity', nextEligibleAt: past }),
        parent.id,
      );

      const spilled = await execute(scenario, adapter);
      assert.equal(spilled.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'tencent');
      const qiniuChannel = db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).get(parent.id) as { state: string };
      assert.equal(qiniuChannel.state, 'overflowed');

      const done = await execute(scenario, adapter);
      assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
      assert.equal(adapter.submissions.length, 1);
      assert.equal(adapter.submissions[0]?.providerIdentity, tencentModel.providerId);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'tencent');
      assert.equal((db.prepare(`SELECT COUNT(*) FROM execution_attempts a
        JOIN execution_operations o ON o.id = a.operationId
        WHERE o.taskId = ? AND o.channelKey = 'tencent'`).pluck().get(scenario.task.id) as number), 1);
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
    }
  }

  // 6. accepted remote resumes without another submit.
  {
    const scenario = await createTask({ name: 'resume-accepted' });
    const adapter = fakeAdapter({
      poll: async () => ({ status: 'running' }),
    });
    const first = await execute(scenario, adapter, 0);
    assert.equal(first.phase, 'polling');
    assert.equal(adapter.submissions.length, 1);
    assert.ok(scenario.readTask().providerTaskId);
    assert.equal(parentFor(scenario.task.id)?.status, 'accepted');
    runWithAccessContext(access, () => updateCanvasTaskUnGuarded(db, scenario.task.id, {
      leaseOwner: null,
      leaseUntil: null,
    }));
    const resumed = fakeAdapter();
    const done = await execute(scenario, resumed, 10);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(resumed.submissions.length, 0);
    assert.equal(adapter.submissions.length, 1);
  }

  // 6a. if qiniu recovers at the deadline, it keeps priority and tencent is untouched.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    try {
      const scenario = await createTask({ name: 'qiniu-recovers' });
      const adapter = fakeAdapter();
      await execute(scenario, adapter);
      const parent = parentFor(scenario.task.id)!;
      const past = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE execution_media_tasks SET nextEligibleAt = ? WHERE id = ?`).run(past, parent.id);
      db.prepare(`UPDATE execution_media_channels SET nextEligibleAt = ? WHERE mediaTaskId = ?
        AND channelKey = 'qiniu'`).run(past, parent.id);
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
      const done = await execute(scenario, adapter);
      assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
      assert.equal(adapter.submissions.length, 1);
      assert.equal(adapter.submissions[0]?.providerIdentity, qiniuModel.providerId);
      assert.equal(parentFor(scenario.task.id)?.currentChannelKey, 'qiniu');
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
    }
  }

  // 6b. tencent spills first, then an explicit tencent failure can return to qiniu.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    try {
      const scenario = await createTask({ name: 'tencent-to-qiniu' });
      const adapter = fakeAdapter({
        submit: async (context) => {
          if (context.providerIdentity === tencentModel.providerId) {
            throw new CanvasAdapterError('submit', '腾讯明确拒绝', {
              uncertain: false, code: 'provider_http_400', httpStatus: 400,
            });
          }
          return { providerTaskId: 'qiniu-after-tencent' };
        },
      });
      const waiting = await execute(scenario, adapter);
      assert.equal(waiting.phase, 'queued');
      let parent = parentFor(scenario.task.id)!;
      const past = new Date(Date.now() - 1_000).toISOString();
      db.prepare(`UPDATE execution_media_tasks SET nextEligibleAt = ? WHERE id = ?`).run(past, parent.id);
      db.prepare(`UPDATE execution_media_channels SET nextEligibleAt = ? WHERE mediaTaskId = ?
        AND channelKey = 'qiniu'`).run(past, parent.id);
      const spilled = await execute(scenario, adapter);
      assert.equal(spilled.phase, 'queued');
      assert.equal(adapter.submissions.length, 0);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'tencent');

      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
      const tencentFailed = await execute(scenario, adapter);
      assert.equal(tencentFailed.phase, 'queued');
      assert.equal(adapter.submissions.length, 1);
      assert.equal(adapter.submissions[0]?.providerIdentity, tencentModel.providerId);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'qiniu');

      const done = await execute(scenario, adapter);
      assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
      assert.deepEqual(adapter.submissions.map((entry) => entry.providerIdentity), [
        tencentModel.providerId,
        qiniuModel.providerId,
      ]);
      parent = parentFor(scenario.task.id)!;
      assert.equal(parent.currentChannelKey, 'qiniu');
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
    }
  }

  // 7. download failure retries the original result, not the model.
  {
    const scenario = await createTask({ name: 'download-retry' });
    let downloads = 0;
    const failing = fakeAdapter({
      download: async () => {
        downloads += 1;
        if (downloads === 1) throw new CanvasAdapterError('download', '本地写入失败', { code: 'download_failed' });
        return { bytes: imageBytes, mimeType: 'image/png' };
      },
    });
    const first = await execute(scenario, failing);
    assert.equal(first.phase, 'download_failed');
    assert.equal(failing.submissions.length, 1);
    assert.equal(parentFor(scenario.task.id)?.status, 'accepted');
    runWithAccessContext(access, () => retryCanvasTaskDownload(db, { taskId: scenario.task.id }));
    const done = await execute(scenario, failing);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(failing.submissions.length, 1, 'download retry must not POST again');
  }

  // 7b. channel health avoidance is shared with canvas routing.
  {
    for (let index = 0; index < 3; index += 1) {
      recordUnifiedChannelFailure(db, {
        unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
        channelKey: 'qiniu',
        providerId: qiniuModel.providerId,
        reasonCode: 'provider_server_error',
      });
    }
    const health = db.prepare(`SELECT state, version FROM execution_media_channel_health
      WHERE healthKey = ?`).get(`${UNIFIED_IMAGE_MODEL_KEY}:qiniu`) as { state: string; version: number };
    assert.equal(health.state, 'avoided');
    const scenario = await createTask({ name: 'health-avoidance' });
    const adapter = fakeAdapter();
    const done = await execute(scenario, adapter);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(adapter.submissions[0]?.providerIdentity, tencentModel.providerId);
    clearUnifiedChannelHealthAvoidance(db, {
      unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
      channelKey: 'qiniu',
      providerId: qiniuModel.providerId,
      actorId: 'canvas-user',
      expectedVersion: health.version,
    });
  }

  // 8. cancel while queued/waiting stops every future channel.
  {
    db.prepare('UPDATE execution_pools SET capacity = 0 WHERE poolKey = ?').run(qiniuPool);
    try {
      const scenario = await createTask({ name: 'cancel-waiting' });
      const adapter = fakeAdapter();
      await execute(scenario, adapter);
      runWithAccessContext(access, () => requestCanvasTaskCancel(db, { taskId: scenario.task.id }));
      assert.equal(scenario.readTask().phase, 'cancelled');
      assert.equal(claim(scenario.task.id), null);
      assert.equal(adapter.submissions.length, 0);
      assert.equal(parentFor(scenario.task.id)?.status, 'canceled');
    } finally {
      db.prepare('UPDATE execution_pools SET capacity = 10 WHERE poolKey = ?').run(qiniuPool);
    }
  }

  // 8b. A canceled accepted task retains its late asset but never publishes it
  // or promotes a downstream task.
  {
    const scenario = await createTask({ name: 'cancel-late-result' });
    const adapter = fakeAdapter({
      download: async () => {
        runWithAccessContext(access, () => requestCanvasTaskCancel(db, { taskId: scenario.task.id }));
        return { bytes: imageBytes, mimeType: 'image/png' };
      },
    });
    const outcome = await execute(scenario, adapter);
    assert.equal(outcome.phase, 'cancelled');
    assert.ok(outcome.outputAssetId, 'late canvas result is retained on the canceled task');
    const task = scenario.readTask();
    assert.equal(task.phase, 'cancelled');
    assert.equal(task.outputAssetId, outcome.outputAssetId);
    const nodeState = db.prepare(`SELECT currentAssetId, resultTaskId
      FROM creative_canvas_node_states WHERE canvasId = ? AND nodeId = ?`)
      .get(scenario.canvasId, scenario.nodeId) as {
        currentAssetId: string | null; resultTaskId: string | null;
      };
    assert.equal(nodeState.currentAssetId, null, 'canceled late result must not replace the node result');
    assert.equal(nodeState.resultTaskId, null);
    const parent = parentFor(task.id)!;
    assert.equal(parent.status, 'canceled');
    const parentResult = JSON.parse(String(parent.resultJson ?? '{}')) as Record<string, unknown>;
    assert.equal(parentResult.lateResult, true);
    assert.equal(parentResult.outputAssetId, outcome.outputAssetId);
    assert.equal(
      db.prepare(`SELECT state FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = 'qiniu'`).pluck().get(parent.id),
      'succeeded',
    );

    const downstreamId = crypto.randomUUID();
    const at = new Date().toISOString();
    db.prepare(`INSERT INTO creative_canvas_tasks (
      id, runId, canvasId, nodeId, nodeEpoch, mediaKind, phase,
      providerSnapshot, parameterSnapshot, submissionState, slotHeld, fence, createdAt, updatedAt
    ) VALUES (?, NULL, ?, ?, 0, 'image', 'waiting_input', '{}', '{}', 'not_sent', 0, 0, ?, ?)`)
      .run(downstreamId, scenario.canvasId, `downstream-${downstreamId}`, at, at);
    runWithAccessContext(access, () => access.registerInheritedScope({
      resourceType: 'canvas_task',
      resourceId: downstreamId,
      parent: { resourceType: 'canvas', resourceId: scenario.canvasId },
    }));
    db.prepare(`INSERT INTO creative_canvas_task_inputs (
      id, taskId, refId, orderIndex, role, note, sourceNodeId, assetId,
      upstreamTaskId, textContent, resolvedAssetId, createdAt
    ) VALUES (?, ?, 'upstream', 0, 'reference', '', NULL, NULL, ?, NULL, NULL, ?)`)
      .run(crypto.randomUUID(), downstreamId, scenario.task.id, at);
    const resolved = runWithAccessContext(access, () => resolveCanvasTaskInputs(db));
    assert.equal(resolved.promoted.includes(downstreamId), false);
    assert.equal(resolved.blocked.includes(downstreamId), true);
    assert.equal(
      db.prepare('SELECT phase FROM creative_canvas_tasks WHERE id = ?').pluck().get(downstreamId),
      'blocked',
    );
  }

  // 9. old exact Image 2 snapshots remain on the old path and acquire no parent.
  {
    const scenario = await createTask({
      name: 'legacy-exact',
      modelKey: COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY.key,
    });
    assert.equal(isCanvasUnifiedImageTask(scenario.readTask()), false);
    const adapter = fakeAdapter();
    const done = await execute(scenario, adapter);
    assert.equal(done.phase, 'succeeded', done.errorCode ?? '');
    assert.equal(adapter.submissions.length, 1);
    assert.equal(parentFor(scenario.task.id), undefined);
  }

  void qiniuPool;
  void tencentPool;
  console.log('unified canvas Image 2 tests passed (paid calls: 0)');
} finally {
  runtime.closeNewWork();
  clearCanvasCapabilities();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
