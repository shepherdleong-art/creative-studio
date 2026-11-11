// node scripts/unified-image-congestion.test.ts
// Real SQLite + execution admission + image queue; simulated providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-image-congestion-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-image-congestion-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-image-congestion-test-instance',
  CREATIVE_STUDIO_PORT: '43121',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import(
  '../lib/team-service/runtime/index.ts'
);
const queue = await import('../lib/queue.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { runWithTaskAccessContext } = await import('../lib/media-core/access-context.ts');
const { readActorPolicy, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { freezeUnifiedImageRequest } = await import('../lib/media-core/unified-media/requests.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const {
  listUnifiedImageChannelAttempts,
  pauseUnifiedImageQueueWaits,
  prepareUnifiedImageExecution,
  resumeUnifiedImageQueueWaits,
  UnifiedImageWaitingError,
} = await import('../lib/media-core/unified-media/execution.ts');
const {
  updateUnifiedImageCongestionSettings,
} = await import('../lib/media-core/unified-media/settings.ts');
const { readPoolAdminState } = await import('../lib/team-service/pools.ts');

const originalFetch = globalThis.fetch;
const png = await sharp({
  create: { width: 16, height: 16, channels: 3, background: '#eeeeee' },
}).png().toBuffer();
const qiniuBase = 'https://qiniu-congestion.example.test';
const tencentBase = 'https://tencent-congestion.example.test';
const qiniuKey = 'fixture-qiniu-congestion';
const tencentKey = 'fixture-tencent-congestion';
const requests: Array<{ channel: 'qiniu' | 'tencent'; method: string; prompt: string }> = [];
const tencentRejects = new Set<string>();

function readPrompt(init?: RequestInit): string {
  if (typeof init?.body !== 'string') return '';
  try {
    const body = JSON.parse(init.body) as { prompt?: unknown };
    return typeof body.prompt === 'string' ? body.prompt : '';
  } catch {
    return '';
  }
}

function channelOf(url: string): 'qiniu' | 'tencent' | null {
  if (url.startsWith(qiniuBase)) return 'qiniu';
  if (url.startsWith(tencentBase)) return 'tencent';
  return null;
}

function successResponse(channel: 'qiniu' | 'tencent', prompt: string): Response {
  return Response.json({
    id: `${channel}-${prompt}`,
    status: 'completed',
    metadata: {
      url: `${channel === 'qiniu' ? qiniuBase : tencentBase}/result/${encodeURIComponent(prompt)}.png`,
    },
  });
}

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  const method = String(init?.method || 'GET').toUpperCase();
  const channel = channelOf(url);
  const prompt = readPrompt(init);
  if (channel) requests.push({ channel, method, prompt });
  if (channel && method === 'POST' && url.endsWith('/v1/videos')) {
    if (channel === 'tencent' && tencentRejects.has(prompt)) {
      tencentRejects.delete(prompt);
      setPoolCapacity('qiniu', 1);
      return new Response('tenant channel rejected', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return successResponse(channel, prompt);
  }
  const downloadMatch = /\/result\/(.+)\.png$/.exec(new URL(url).pathname);
  if (channel && method === 'GET' && downloadMatch) {
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
  }
  throw new Error(`unexpected fixture request: ${method} ${url}`);
}) as typeof fetch;

function insertMemberAndProject(db: ReturnType<typeof getDb>, projectId: string): string {
  const now = new Date().toISOString();
  const imagePath = path.join(root, `${projectId}.png`);
  fs.writeFileSync(imagePath, png);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality)
    VALUES (?, ?, ?, ?, 'prompt', '1728x2304', 'auto')`)
    .run(projectId, projectId, UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType, usage)
    VALUES (?, ?, 'input', ?, ?, 'image/png', 'scene_seed')`)
    .run(`image-${projectId}`, projectId, `${projectId}.png`, imagePath);
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', ?, 'member', 'project', ?, ?, ?)`).run(projectId, projectId, now, now);
  return `image-${projectId}`;
}

function insertUnifiedJob(
  db: ReturnType<typeof getDb>,
  input: { id: string; projectId: string; inputImageId: string; prompt: string },
): void {
  const frozen = freezeUnifiedImageRequest({
    inputImageId: input.inputImageId,
    referenceImageIds: [],
    prompt: input.prompt,
    tier: '2k',
    ratio: '1:1',
    referenceGuidanceMode: 'none',
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
      unifiedModel, unifiedRuleVersion, unifiedRequestJson
    ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'auto', 'pending', 0, 1, 'none', ?, 0, ?, ?, ?)`)
    .run(
      input.id, input.projectId, input.inputImageId,
      UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY,
      frozen.prompt, frozen.size, now, UNIFIED_IMAGE_MODEL_KEY,
      UNIFIED_MEDIA_RULE_VERSION, JSON.stringify(frozen),
    );
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('job', ?, 'member', 'project', ?, 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, input.projectId, now, now);
  db.prepare(`INSERT INTO team_task_principals
    (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', ?, 'member', 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, JSON.stringify(frozen), now);
}

function createCase(
  db: ReturnType<typeof getDb>,
  name: string,
): { projectId: string; jobId: string; prompt: string } {
  const projectId = `project-${name}`;
  const jobId = `job-${name}`;
  const prompt = `case-${name}`;
  const imageId = insertMemberAndProject(db, projectId);
  insertUnifiedJob(db, { id: jobId, projectId, inputImageId: imageId, prompt });
  return { projectId, jobId, prompt };
}

function runJob(projectId: string, jobId: string): Promise<void> {
  return queue.runQueue({
    projectId, jobId, concurrency: 4, maxAttempts: 5, timeoutMs: 30_000,
  });
}

function postCount(prompt: string, channel: 'qiniu' | 'tencent'): number {
  return requests.filter((item) => (
    item.prompt === prompt && item.channel === channel && item.method === 'POST'
  )).length;
}

function setPoolCapacity(channel: 'qiniu' | 'tencent', capacity: number): void {
  configureLegacyMediaProviderPool({
    baseUrl: channel === 'qiniu' ? qiniuBase : tencentBase,
    apiKey: channel === 'qiniu' ? qiniuKey : tencentKey,
    capacity,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function ledger(jobId: string) {
  return listUnifiedImageChannelAttempts(getDb(), jobId);
}

function tryLedger(jobId: string) {
  try {
    return ledger(jobId);
  } catch {
    return null;
  }
}

function backdateUnifiedDeadline(jobId: string): void {
  const db = getDb();
  const job = db.prepare('SELECT unifiedTaskId FROM jobs WHERE id = ?').get(jobId) as
    { unifiedTaskId: string | null };
  assert.ok(job.unifiedTaskId);
  const past = new Date(Date.now() - 1_000).toISOString();
  db.prepare(`UPDATE execution_media_tasks SET nextEligibleAt = ?, updatedAt = ?
    WHERE id = ?`).run(past, past, job.unifiedTaskId);
  db.prepare(`UPDATE execution_media_channels SET nextEligibleAt = ?, updatedAt = ?
    WHERE mediaTaskId = ? AND nextEligibleAt IS NOT NULL`).run(past, past, job.unifiedTaskId);
}

async function stopQueue(running: Promise<void>): Promise<void> {
  await queue.drainImageQueues();
  await running;
}

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'Member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, {
    actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 10,
    paused: false, expectedVersion: 0,
  });
  seedProviders();
  db.prepare('UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?')
    .run(qiniuBase, qiniuKey, UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.prepare('UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?')
    .run(tencentBase, tencentKey, UNIFIED_IMAGE_CHANNELS[1].providerId);
  setPoolCapacity('qiniu', 4);
  setPoolCapacity('tencent', 4);

  {
    const settings = readPoolAdminState(db, { userId: 'admin', role: 'admin' })
      .unifiedImageCongestion;
    assert.equal(settings.imageCongestionThresholdSec, 30);
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const testCase = createCase(db, 'deadline-overflow');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const parent = tryLedger(testCase.jobId);
      return db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId) === 'deferred'
        && parent?.parentStatus === 'waiting'
        && parent.channels.find((channel) => channel.channelKey === 'qiniu')?.state === 'waiting_capacity';
    }, 'qiniu congestion wait');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 0);
    assert.equal(postCount(testCase.prompt, 'tencent'), 0, 'deadline must not overflow early');
    let parent = ledger(testCase.jobId);
    const qiniuWaiting = parent.channels.find((channel) => channel.channelKey === 'qiniu')!;
    assert.equal(qiniuWaiting.attempts.length, 0, 'capacity wait must not consume a submission');
    assert.equal(qiniuWaiting.operationWaitReason, 'pool_capacity');
    assert.ok(qiniuWaiting.operationId);
    const task = db.prepare('SELECT nextEligibleAt, waitDetailJson FROM execution_media_tasks WHERE id = ?')
      .get(parent.mediaTaskId) as { nextEligibleAt: string; waitDetailJson: string };
    const detail = JSON.parse(task.waitDetailJson) as { thresholdSec?: number };
    assert.equal(detail.thresholdSec, 30);
    assert.ok(Date.parse(task.nextEligibleAt) >= Date.now() + 25_000);
    let waitingClaims = 0;
    db.function('observe_congestion_claim', () => {
      waitingClaims += 1;
      return 0;
    });
    db.exec(`CREATE TEMP TRIGGER observe_congestion_claim AFTER UPDATE OF status ON jobs
      WHEN NEW.id = '${testCase.jobId}' AND NEW.status = 'running' AND OLD.status != 'running'
      BEGIN SELECT observe_congestion_claim(); END`);
    await sleep(900);
    assert.equal(waitingClaims, 0, 'deferred capacity wait must not be re-claimed before its deadline');
    db.exec('DROP TRIGGER observe_congestion_claim');

    await stopQueue(running);
    backdateUnifiedDeadline(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 0, 'qiniu still full at deadline must not be posted');
    assert.equal(postCount(testCase.prompt, 'tencent'), 1, 'after the deadline tencent takes exactly once');
    parent = ledger(testCase.jobId);
    assert.equal(parent.currentChannelKey, 'tencent');
    assert.equal(parent.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'overflowed');
    assert.equal(parent.submissionCount, 1, 'overflow is not a submitted channel attempt');
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const testCase = createCase(db, 'overflow-failure-return');
    tencentRejects.add(testCase.prompt);
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => tryLedger(testCase.jobId)?.parentStatus === 'waiting', 'overflow return initial wait');
    await stopQueue(running);
    backdateUnifiedDeadline(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 1);
    assert.equal(postCount(testCase.prompt, 'tencent'), 1);
    const parent = ledger(testCase.jobId);
    assert.equal(parent.submissionCount, 2);
    assert.equal(parent.channels.find((channel) => channel.channelKey === 'qiniu')?.state, 'succeeded');
    assert.equal(parent.channels.find((channel) => channel.channelKey === 'tencent')?.state, 'not_created');
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const testCase = createCase(db, 'qiniu-recovers');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => tryLedger(testCase.jobId)?.parentStatus === 'waiting', 'qiniu recovered wait');
    await stopQueue(running);
    setPoolCapacity('qiniu', 1);
    backdateUnifiedDeadline(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 1, 'a recovered qiniu is retried before overflow');
    assert.equal(postCount(testCase.prompt, 'tencent'), 0);
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 0);
    const testCase = createCase(db, 'both-full');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => tryLedger(testCase.jobId)?.parentStatus === 'waiting', 'both-full initial wait');
    await stopQueue(running);
    backdateUnifiedDeadline(testCase.jobId);
    const secondRun = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const parent = tryLedger(testCase.jobId);
      return parent?.currentChannelKey === 'tencent'
        && parent.parentStatus === 'waiting'
        && parent.channels.find((channel) => channel.channelKey === 'tencent')?.state === 'waiting_capacity';
    }, 'tencent waiting after overflow');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 0);
    assert.equal(postCount(testCase.prompt, 'tencent'), 0, 'no POST while both pools are full');
    await stopQueue(secondRun);
    setPoolCapacity('tencent', 1);
    backdateUnifiedDeadline(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'tencent'), 1);
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const current = readActorPolicy(db, 'member');
    updateActorPolicy(db, {
      actorId: 'member', monthlyLimitMinor: 0, personalConcurrency: current.personalConcurrency,
      paused: false, expectedVersion: current.version,
    });
    const testCase = createCase(db, 'budget-not-capacity');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const operation = db.prepare(`SELECT waitReason FROM execution_operations
        WHERE taskId = ? AND channelKey = 'qiniu'`).get(testCase.jobId) as { waitReason: string } | undefined;
      return status === 'deferred' && operation?.waitReason === 'monthly_budget';
    }, 'budget gate instead of congestion');
    const parent = ledger(testCase.jobId);
    const qiniu = parent.channels.find((channel) => channel.channelKey === 'qiniu')!;
    assert.notEqual(qiniu.state, 'waiting_capacity', 'budget must not look like a capacity wait');
    const task = db.prepare('SELECT nextEligibleAt FROM execution_media_tasks WHERE id = ?')
      .get(parent.mediaTaskId) as { nextEligibleAt: string | null };
    assert.equal(task.nextEligibleAt, null);
    assert.equal(postCount(testCase.prompt, 'qiniu'), 0);
    assert.equal(postCount(testCase.prompt, 'tencent'), 0);
    await stopQueue(running);
    updateActorPolicy(db, {
      actorId: 'member', monthlyLimitMinor: null, personalConcurrency: current.personalConcurrency,
      paused: false, expectedVersion: current.version + 1,
    });
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const current = readActorPolicy(db, 'member');
    updateActorPolicy(db, {
      actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 0,
      paused: false, expectedVersion: current.version,
    });
    const testCase = createCase(db, 'personal-limit-not-capacity');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => {
      const status = db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId);
      const operation = db.prepare(`SELECT waitReason FROM execution_operations
        WHERE taskId = ? AND channelKey = 'qiniu'`).get(testCase.jobId) as { waitReason: string } | undefined;
      return status === 'deferred' && operation?.waitReason === 'personal_concurrency';
    }, 'personal limit gate instead of congestion');
    const parent = ledger(testCase.jobId);
    const task = db.prepare('SELECT nextEligibleAt FROM execution_media_tasks WHERE id = ?')
      .get(parent.mediaTaskId) as { nextEligibleAt: string | null };
    assert.equal(task.nextEligibleAt, null);
    assert.equal(postCount(testCase.prompt, 'qiniu'), 0);
    assert.equal(postCount(testCase.prompt, 'tencent'), 0);
    await stopQueue(running);
    updateActorPolicy(db, {
      actorId: 'member', monthlyLimitMinor: null, personalConcurrency: current.personalConcurrency,
      paused: false, expectedVersion: current.version + 1,
    });
  }

  {
    setPoolCapacity('qiniu', 0);
    setPoolCapacity('tencent', 2);
    const settings = readPoolAdminState(db, { userId: 'admin', role: 'admin' }).unifiedImageCongestion;
    updateUnifiedImageCongestionSettings(db, {
      imageCongestionThresholdSec: 20,
      expectedVersion: settings.version,
    });
    const testCase = createCase(db, 'pause-resume');
    const running = runJob(testCase.projectId, testCase.jobId);
    await waitFor(() => tryLedger(testCase.jobId)?.parentStatus === 'waiting', 'pause-resume wait');
    await stopQueue(running);
    const parent = ledger(testCase.jobId);
    const before = db.prepare(`SELECT nextEligibleAt, waitDetailJson FROM execution_media_tasks WHERE id = ?`)
      .get(parent.mediaTaskId) as { nextEligibleAt: string; waitDetailJson: string };
    const oldDeadline = Date.parse(before.nextEligibleAt);
    const pausedAt = new Date(oldDeadline - 10_000);
    const resumedAt = new Date(pausedAt.getTime() + 7_000);
    pauseUnifiedImageQueueWaits(db, testCase.projectId, pausedAt);
    resumeUnifiedImageQueueWaits(db, testCase.projectId, resumedAt);
    const after = db.prepare(`SELECT nextEligibleAt FROM execution_media_tasks WHERE id = ?`)
      .get(parent.mediaTaskId) as { nextEligibleAt: string };
    assert.ok(
      Math.abs(Date.parse(after.nextEligibleAt) - (oldDeadline + 7_000)) < 2,
      'paused time must be added back to the capacity deadline',
    );
    assert.throws(
      () => runWithTaskAccessContext(db, 'image', testCase.jobId, () =>
        prepareUnifiedImageExecution(db, testCase.jobId, new Date(resumedAt.getTime() + 1_000))),
      (error: unknown) => error instanceof UnifiedImageWaitingError,
      'a persisted future deadline must keep the task waiting',
    );
    setPoolCapacity('qiniu', 1);
    backdateUnifiedDeadline(testCase.jobId);
    await runJob(testCase.projectId, testCase.jobId);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(testCase.jobId), 'succeeded');
    assert.equal(postCount(testCase.prompt, 'qiniu'), 1);
  }

  console.log('unified image congestion tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
