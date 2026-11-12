// node scripts/unified-image-queue.test.ts
// Real SQLite + execution facade + image queue; all HTTP is intercepted and unpriced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-image-queue-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-image-queue-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-image-queue-test-instance',
  CREATIVE_STUDIO_PORT: '43118',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import('../lib/team-service/runtime/index.ts');
const queue = await import('../lib/queue.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { freezeUnifiedImageRequest, UnifiedImageRequestError } = await import('../lib/media-core/unified-media/requests.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_CHANNELS, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const { listUnifiedImageChannelAttempts } = await import('../lib/media-core/unified-media/execution.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { queryTeamUsage } = await import('../lib/team-service/usage.ts');

const originalFetch = globalThis.fetch;
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toBuffer();
const requests: Array<{ url: string; method: string; model?: string; size?: string }> = [];
let qiniuPosts = 0;
let tencentPosts = 0;

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  const method = String(init?.method || 'GET').toUpperCase();
  let body: { model?: string; size?: string } = {};
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body) as { model?: string; size?: string }; } catch { /* non-JSON fixture */ }
  }
  requests.push({ url, method, ...body });
  if (url.startsWith('https://qiniu.example.test/')) {
    if (method === 'POST' && url.endsWith('/v1/videos')) {
      qiniuPosts += 1;
      return Response.json({
        id: 'qiniu-image-1', status: 'completed',
        metadata: { url: 'https://qiniu.example.test/result.png' },
      });
    }
    if (method === 'GET' && url.endsWith('/result.png')) {
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
  }
  if (url.startsWith('https://tencent.example.test/')) {
    if (method === 'POST' && url.endsWith('/v1/videos')) {
      tencentPosts += 1;
      return Response.json({
        id: 'tencent-image-1', status: 'completed',
        metadata: { url: 'https://tencent.example.test/result.png' },
      });
    }
    if (method === 'GET' && url.endsWith('/result.png')) {
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
  }
  throw new Error(`unexpected fixture request: ${method} ${url}`);
}) as typeof fetch;

function insertMemberAndProject(
  db: ReturnType<typeof getDb>,
  projectId: string,
  providerId: string,
  model: string,
): string {
  const now = new Date().toISOString();
  const imagePath = path.join(root, `${projectId}.png`);
  fs.writeFileSync(imagePath, png);
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt, size, quality)
    VALUES (?, ?, ?, ?, 'prompt', '1728x2304', 'auto')`).run(projectId, projectId, providerId, model);
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
  input: {
    id: string; projectId: string; inputImageId: string;
    tier: '1k' | '2k' | '4k'; ratio: string; createdAt?: string;
  },
): void {
  const frozen = freezeUnifiedImageRequest({
    inputImageId: input.inputImageId,
    referenceImageIds: [],
    prompt: '保持产品不变，更换场景',
    tier: input.tier,
    ratio: input.ratio,
    referenceGuidanceMode: 'none',
  });
  const now = input.createdAt ?? new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
      unifiedModel, unifiedRuleVersion, unifiedRequestJson
    ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'auto', 'pending', 0, 1, 'none', ?, 0, ?, ?, ?)`)
    .run(
      input.id, input.projectId, input.inputImageId, UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY,
      frozen.prompt, frozen.size, now, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, JSON.stringify(frozen),
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

function insertLegacyJob(
  db: ReturnType<typeof getDb>,
  input: { id: string; projectId: string; inputImageId: string; providerId: string },
): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex
    ) VALUES (?, ?, ?, '[]', ?, 'qiniuyun/gpt-image-2-medium', 'legacy prompt', '1440x1440', 'auto',
      'pending', 0, 2, 'none', ?, 0)`)
    .run(input.id, input.projectId, input.inputImageId, input.providerId, now);
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('job', ?, 'member', 'project', ?, 'project', ?, ?, ?)`)
    .run(input.id, input.projectId, input.projectId, now, now);
  db.prepare(`INSERT INTO team_task_principals
    (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', ?, 'member', 'project', ?, '{}', ?)`)
    .run(input.id, input.projectId, now);
}

function findChannel(taskId: string): { channelKey: string; state: string; operationId: string | null; remoteId: string | null } {
  return getDb().prepare(`
    SELECT c.channelKey, c.state, c.operationId, c.remoteId
    FROM execution_media_channels c
    JOIN execution_media_tasks t ON t.id = c.mediaTaskId
    WHERE t.taskId = ? ORDER BY c.priority
  `).get(taskId) as { channelKey: string; state: string; operationId: string | null; remoteId: string | null };
}

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('member', 'member', 'Member', 'employee', 'active', 'hash', ?, ?)`).run(now, now);
  updateActorPolicy(db, {
    actorId: 'member', monthlyLimitMinor: null, personalConcurrency: 10, paused: false, expectedVersion: 0,
  }).valueOf();
  seedProviders();
  assert.ok(db.prepare('SELECT 1 FROM providers WHERE id = ?').get(UNIFIED_IMAGE_ANCHOR_ID));

  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://qiniu.example.test', 'fixture-qiniu-key', UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://tencent.example.test', 'fixture-tencent-key', UNIFIED_IMAGE_CHANNELS[1].providerId);
  configureLegacyMediaProviderPool({ baseUrl: 'https://qiniu.example.test', apiKey: 'fixture-qiniu-key', capacity: 4 });
  configureLegacyMediaProviderPool({ baseUrl: 'https://tencent.example.test', apiKey: 'fixture-tencent-key', capacity: 4 });

  const qiniuImageId = insertMemberAndProject(db, 'project-qiniu', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, { id: 'job-qiniu', projectId: 'project-qiniu', inputImageId: qiniuImageId, tier: '2k', ratio: '3:4' });
  await queue.runQueue({ projectId: 'project-qiniu', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });

  const qiniuJob = db.prepare(`SELECT status, providerId, model, unifiedModel, unifiedTaskId, outputImageId, estimatedCost
    FROM jobs WHERE id = 'job-qiniu'`).get() as Record<string, unknown>;
  assert.equal(qiniuJob.status, 'succeeded');
  assert.equal(qiniuJob.providerId, UNIFIED_IMAGE_ANCHOR_ID, 'business row keeps the unified anchor identity');
  assert.equal(qiniuJob.model, UNIFIED_IMAGE_MODEL_KEY, 'business row keeps the unified model identity');
  assert.equal(qiniuJob.unifiedModel, UNIFIED_IMAGE_MODEL_KEY);
  assert.ok(qiniuJob.unifiedTaskId);
  assert.ok(qiniuJob.outputImageId);
  assert.equal(qiniuPosts, 1);
  assert.equal(tencentPosts, 0, 'both-compatible request starts on qiniu');
  assert.equal(requests.filter((item) => item.method === 'POST')[0]?.model, 'qiniuyun/gpt-image-2-medium');
  assert.equal(requests.filter((item) => item.method === 'POST')[0]?.size, '1440x1920');
  assert.deepEqual(findChannel('job-qiniu'), {
    channelKey: 'qiniu', state: 'succeeded', operationId: findChannel('job-qiniu').operationId, remoteId: 'qiniu-image-1',
  });
  assert.ok(findChannel('job-qiniu').operationId);
  const qiniuLedger = listUnifiedImageChannelAttempts(db, 'job-qiniu');
  assert.equal(qiniuLedger.submissionCount, 1);
  assert.equal(qiniuLedger.usedChannelCount, 1);
  assert.equal(qiniuLedger.channels.find((channel) => channel.channelKey === 'qiniu')?.attempts[0]?.providerSnapshot.model,
    'qiniuyun/gpt-image-2-medium');
  assert.equal(
    db.prepare(`SELECT COUNT(*) FROM execution_operations WHERE taskId = 'job-qiniu' AND mediaTaskId IS NOT NULL AND channelKey = 'qiniu'`)
      .pluck().get(),
    1,
  );
  assert.deepEqual(
    db.prepare(`SELECT operationKey, inputRevision FROM execution_operations
      WHERE taskId = 'job-qiniu' AND mediaTaskId IS NOT NULL AND channelKey = 'qiniu'`).get(),
    { operationKey: 'image/job-qiniu/submit/r1', inputRevision: 'r1' },
    'the selected channel revision must be used by the execution operation so crash recovery finds the same attempt',
  );
  assert.equal(
    db.prepare(`SELECT executionRevision FROM jobs WHERE id = 'job-qiniu'`).pluck().get(),
    db.prepare(`SELECT executionRevision FROM execution_media_channels c
      JOIN execution_media_tasks t ON t.id = c.mediaTaskId
      WHERE t.taskId = 'job-qiniu' AND c.channelKey = 'qiniu'`).pluck().get(),
    'business row and selected channel must persist the same revision',
  );
  assert.deepEqual(
    db.prepare(`SELECT a.providerSnapshotJson, a.reservedMinor FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId WHERE o.taskId = 'job-qiniu'`).get(),
    {
      providerSnapshotJson: JSON.stringify({
        providerId: 'company-gateway-qiniuyun-gpt-image-2-medium',
        providerName: '公司网关 七牛云 GPT Image 2 Medium',
        type: 'gateway-task-image',
        model: 'qiniuyun/gpt-image-2-medium',
        baseUrl: 'https://qiniu.example.test',
        unifiedModel: 'image2',
      }),
      reservedMinor: 25,
    },
  );
  assert.equal(qiniuJob.estimatedCost, 0.25, 'the real qiniu attempt, not the anchor, determines price');

  const viewer = { userId: 'member', role: 'employee' as const };
  const taskView = listTeamTasks(db, viewer).items.find((item) => item.taskId === 'job-qiniu');
  assert.equal(taskView?.unifiedModel, 'image2');
  assert.equal(taskView?.model, 'Image 2');
  const usage = queryTeamUsage(db, viewer, { module: 'image' }).items.find((item) => item.taskId === 'job-qiniu');
  assert.equal(usage?.unifiedModel, 'image2');
  assert.equal(usage?.reservedMinor, 25);

  await queue.runQueue({ projectId: 'project-qiniu', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(qiniuPosts, 1, 're-running a finished queue must not submit again');

  const tencentImageId = insertMemberAndProject(db, 'project-tencent', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, { id: 'job-tencent', projectId: 'project-tencent', inputImageId: tencentImageId, tier: '1k', ratio: '1:1' });
  await queue.runQueue({ projectId: 'project-tencent', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-tencent'`).pluck().get(), 'succeeded');
  assert.equal(qiniuPosts, 1, 'a tencent-only combination never probes qiniu');
  assert.equal(tencentPosts, 1);
  assert.deepEqual(findChannel('job-tencent'), {
    channelKey: 'tencent', state: 'succeeded', operationId: findChannel('job-tencent').operationId, remoteId: 'tencent-image-1',
  });
  assert.equal(
    db.prepare(`SELECT a.reservedMinor FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId WHERE o.taskId = 'job-tencent'`).pluck().get(),
    158,
    'tencent-only work is priced by the real tencent channel',
  );

  const retryImageId = insertMemberAndProject(db, 'project-generation-turn', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-generation-turn', projectId: 'project-generation-turn',
    inputImageId: retryImageId, tier: '2k', ratio: '1:1',
  });
  await queue.runQueue({ projectId: 'project-generation-turn', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  const firstParent = db.prepare(`SELECT unifiedTaskId, unifiedGenerationId FROM jobs
    WHERE id = 'job-generation-turn'`).get() as { unifiedTaskId: string; unifiedGenerationId: string };
  assert.ok(firstParent.unifiedTaskId);
  assert.ok(firstParent.unifiedGenerationId);
  db.prepare(`UPDATE jobs SET status = 'pending', attempt = 0, providerTaskId = NULL,
    providerStatus = NULL, remoteImageUrl = NULL, outputImageId = NULL, finishedAt = NULL,
    unifiedTaskId = NULL, unifiedGenerationId = NULL, cancelRequestedAt = NULL
    WHERE id = 'job-generation-turn'`).run();
  await queue.runQueue({ projectId: 'project-generation-turn', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  const secondParent = db.prepare(`SELECT unifiedTaskId, unifiedGenerationId FROM jobs
    WHERE id = 'job-generation-turn'`).get() as { unifiedTaskId: string; unifiedGenerationId: string };
  assert.notEqual(secondParent.unifiedTaskId, firstParent.unifiedTaskId,
    'a new generation turn must not reuse an exhausted logical parent');
  assert.notEqual(secondParent.unifiedGenerationId, firstParent.unifiedGenerationId);
  assert.equal(
    db.prepare(`SELECT COUNT(*) FROM execution_media_tasks WHERE taskId = 'job-generation-turn'`).pluck().get(),
    2,
  );

  const legacyImageId = insertMemberAndProject(db, 'project-legacy', UNIFIED_IMAGE_CHANNELS[0].providerId, 'qiniuyun/gpt-image-2-medium');
  insertLegacyJob(db, {
    id: 'job-legacy', projectId: 'project-legacy', inputImageId: legacyImageId,
    providerId: UNIFIED_IMAGE_CHANNELS[0].providerId,
  });
  const taskCountBeforeLegacy = db.prepare('SELECT COUNT(*) FROM execution_media_tasks').pluck().get() as number;
  const qiniuPostsBeforeLegacy = qiniuPosts;
  await queue.runQueue({ projectId: 'project-legacy', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-legacy'`).pluck().get(), 'succeeded');
  assert.equal(qiniuPosts, qiniuPostsBeforeLegacy + 1, 'legacy jobs keep their original single-channel provider path');
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM execution_media_tasks').pluck().get(),
    taskCountBeforeLegacy,
    'legacy jobs without unifiedModel do not acquire a unified parent',
  );
  assert.deepEqual(
    db.prepare(`SELECT providerId, model, unifiedModel FROM jobs WHERE id = 'job-legacy'`).get(),
    { providerId: UNIFIED_IMAGE_CHANNELS[0].providerId, model: 'qiniuyun/gpt-image-2-medium', unifiedModel: null },
    'legacy jobs keep their original provider/model and do not acquire unified identity',
  );
  const legacyTaskView = listTeamTasks(db, viewer).items.find((item) => item.taskId === 'job-legacy');
  assert.equal(legacyTaskView?.unifiedModel, null, 'legacy task projections must not infer a unified model');
  assert.equal(legacyTaskView?.model, 'qiniuyun/gpt-image-2-medium');
  const legacyUsage = queryTeamUsage(db, viewer, { module: 'image' }).items.find((item) => item.taskId === 'job-legacy');
  assert.equal(legacyUsage?.unifiedModel, null, 'legacy usage projections must not infer a unified model');
  assert.equal(legacyUsage?.model, 'qiniuyun/gpt-image-2-medium');

  const postsBeforeInvalid = qiniuPosts + tencentPosts;
  const jobsBeforeInvalid = db.prepare('SELECT COUNT(*) FROM jobs').pluck().get() as number;
  let invalidRejected = false;
  try {
    freezeUnifiedImageRequest({
      inputImageId: 'image-invalid', referenceImageIds: [], prompt: 'prompt',
      tier: '4k', ratio: '2:1', referenceGuidanceMode: 'none',
    });
  } catch (error) {
    invalidRejected = error instanceof UnifiedImageRequestError && error.code === 'unsupported_image_combination';
  }
  assert.equal(invalidRejected, true);
  assert.equal(qiniuPosts + tencentPosts, postsBeforeInvalid, 'invalid creation performs zero paid submissions');
  assert.equal(db.prepare('SELECT COUNT(*) FROM jobs').pluck().get(), jobsBeforeInvalid, 'invalid creation stops before inserting a job');

  db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
  const disabledQiniuImageId = insertMemberAndProject(db, 'project-disabled-qiniu', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-disabled-qiniu', projectId: 'project-disabled-qiniu', inputImageId: disabledQiniuImageId, tier: '2k', ratio: '1:1',
  });
  const qiniuPostsBeforeDisabled = qiniuPosts;
  const tencentPostsBeforeDisabled = tencentPosts;
  await queue.runQueue({ projectId: 'project-disabled-qiniu', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-disabled-qiniu'`).pluck().get(), 'succeeded');
  assert.equal(qiniuPosts, qiniuPostsBeforeDisabled, 'a disabled qiniu channel is skipped');
  assert.equal(tencentPosts, tencentPostsBeforeDisabled + 1, 'a disabled qiniu channel allows the compatible tencent channel immediately');
  assert.equal(
    db.prepare(`SELECT c.state FROM execution_media_channels c
      JOIN execution_media_tasks t ON t.id = c.mediaTaskId
      WHERE t.taskId = 'job-disabled-qiniu' AND c.channelKey = 'qiniu'`).pluck().get(),
    'skipped',
  );
  db.prepare('UPDATE providers SET enabled = 1 WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);

  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM providers WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.pragma('foreign_keys = ON');
  const missingQiniuImageId = insertMemberAndProject(db, 'project-missing-qiniu', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-missing-qiniu', projectId: 'project-missing-qiniu', inputImageId: missingQiniuImageId, tier: '2k', ratio: '1:1',
  });
  const qiniuPostsBeforeMissingRow = qiniuPosts;
  const tencentPostsBeforeMissingRow = tencentPosts;
  await queue.runQueue({ projectId: 'project-missing-qiniu', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-missing-qiniu'`).pluck().get(), 'succeeded');
  assert.equal(qiniuPosts, qiniuPostsBeforeMissingRow, 'missing qiniu row is never sent');
  assert.equal(tencentPosts, tencentPostsBeforeMissingRow + 1, 'a missing qiniu row falls through to an available exact tencent channel');
  assert.deepEqual(
    db.prepare(`SELECT c.state, c.evidenceJson FROM execution_media_channels c
      JOIN execution_media_tasks t ON t.id = c.mediaTaskId
      WHERE t.taskId = 'job-missing-qiniu' AND c.channelKey = 'qiniu'`).get(),
    { state: 'skipped', evidenceJson: JSON.stringify({ reason: 'provider_missing' }) },
  );
  assert.equal(
    db.prepare(`SELECT c.state FROM execution_media_channels c
      JOIN execution_media_tasks t ON t.id = c.mediaTaskId
      WHERE t.taskId = 'job-missing-qiniu' AND c.channelKey = 'tencent'`).pluck().get(),
    'succeeded',
  );

  db.prepare(`INSERT INTO providers (id, name, type, baseUrl, apiKey, model, enabled)
    VALUES (?, '身份漂移的七牛', 'gateway-task-image', 'https://qiniu.example.test', 'fixture-qiniu-key', 'image2-medium', 1)`)
    .run(UNIFIED_IMAGE_CHANNELS[0].providerId);
  const mismatchImageId = insertMemberAndProject(db, 'project-channel-mismatch', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-channel-mismatch', projectId: 'project-channel-mismatch', inputImageId: mismatchImageId, tier: '2k', ratio: '1:1',
  });
  const postsBeforeMismatch = qiniuPosts + tencentPosts;
  await queue.runQueue({ projectId: 'project-channel-mismatch', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(qiniuPosts + tencentPosts, postsBeforeMismatch, 'an identity-mismatched canonical row fails closed without any POST');
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-channel-mismatch'`).pluck().get(), 'failed');
  assert.match(
    String(db.prepare(`SELECT errorMessage FROM jobs WHERE id = 'job-channel-mismatch'`).pluck().get()),
    /身份|映射/,
  );
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM providers WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.pragma('foreign_keys = ON');

  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://missing-qiniu-pool.example.test', 'missing-qiniu-key', UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://missing-tencent-pool.example.test', 'missing-tencent-key', UNIFIED_IMAGE_CHANNELS[1].providerId);
  const missingPoolImageId = insertMemberAndProject(db, 'project-missing-pool', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-missing-pool', projectId: 'project-missing-pool', inputImageId: missingPoolImageId, tier: '2k', ratio: '1:1',
  });
  const postsBeforeMissingPool = qiniuPosts + tencentPosts;
  await queue.runQueue({ projectId: 'project-missing-pool', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(qiniuPosts + tencentPosts, postsBeforeMissingPool, 'missing channel pool fails before POST');
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-missing-pool'`).pluck().get(), 'failed');
  assert.match(
    String(db.prepare(`SELECT errorMessage FROM jobs WHERE id = 'job-missing-pool'`).pluck().get()),
    /资源池|pool/i,
  );

  db.prepare(`UPDATE providers SET enabled = 0 WHERE id IN (?, ?)`)
    .run(UNIFIED_IMAGE_CHANNELS[0].providerId, UNIFIED_IMAGE_CHANNELS[1].providerId);
  const noChannelImageId = insertMemberAndProject(db, 'project-no-channel', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-no-channel', projectId: 'project-no-channel', inputImageId: noChannelImageId, tier: '2k', ratio: '1:1',
  });
  const postsBeforeNoChannel = qiniuPosts + tencentPosts;
  await queue.runQueue({ projectId: 'project-no-channel', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(qiniuPosts + tencentPosts, postsBeforeNoChannel, 'no enabled exact channel fails before POST');
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-no-channel'`).pluck().get(), 'failed');
  assert.match(
    String(db.prepare(`SELECT errorMessage FROM jobs WHERE id = 'job-no-channel'`).pluck().get()),
    /通道|Image 2/i,
  );

  const canceledImageId = insertMemberAndProject(db, 'project-canceled', UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY);
  insertUnifiedJob(db, {
    id: 'job-canceled', projectId: 'project-canceled', inputImageId: canceledImageId, tier: '2k', ratio: '1:1',
  });
  db.prepare(`UPDATE jobs SET cancelRequestedAt = ? WHERE id = 'job-canceled'`).run(now);
  const postsBeforeCanceled = qiniuPosts + tencentPosts;
  await queue.runQueue({ projectId: 'project-canceled', concurrency: 2, maxAttempts: 5, timeoutMs: 30_000 });
  assert.equal(qiniuPosts + tencentPosts, postsBeforeCanceled, 'a recorded cancel intent blocks every new channel submission');
  assert.equal(db.prepare(`SELECT status FROM jobs WHERE id = 'job-canceled'`).pluck().get(), 'canceled');
  assert.equal(
    db.prepare(`SELECT t.status FROM execution_media_tasks t WHERE t.taskId = 'job-canceled'`).pluck().get(),
    'canceled',
  );

  console.log('unified image queue tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
