// node scripts/unified-image-health-routing.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-image-health-routing-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-image-health-routing',
  CREATIVE_STUDIO_INSTANCE_ID: 'unified-image-health-routing-instance',
  CREATIVE_STUDIO_PORT: '43131',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import('../lib/team-service/runtime/index.ts');
const queue = await import('../lib/queue.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { freezeUnifiedImageRequest } = await import('../lib/media-core/unified-media/requests.ts');
const {
  UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_CHANNELS, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION,
} = await import('../lib/media-core/unified-media/catalog.ts');
const {
  UNIFIED_CHANNEL_FAILURE_THRESHOLD, readUnifiedChannelHealth,
} = await import('../lib/media-core/unified-media/health.ts');

const originalFetch = globalThis.fetch;
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#dddddd' } }).png().toBuffer();
let qiniuPosts = 0;
let tencentPosts = 0;
let qiniuAvailable = false;
let qiniuRejectNext = false;

globalThis.fetch = (async (input, init) => {
  const url = String(input);
  const method = String(init?.method || 'GET').toUpperCase();
  if (url.startsWith('https://qiniu-health.test/')) {
    if (method === 'POST' && url.endsWith('/v1/videos')) {
      qiniuPosts += 1;
      if (qiniuRejectNext) {
        qiniuRejectNext = false;
        return new Response('single material rejected by audit', { status: 400 });
      }
      if (!qiniuAvailable) {
        return new Response('upstream unavailable', { status: 503 });
      }
      return Response.json({
        id: `qiniu-health-${qiniuPosts}`,
        status: 'completed',
        metadata: { url: 'https://qiniu-health.test/result.png' },
      });
    }
    if (method === 'GET' && url.endsWith('/result.png')) {
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
  }
  if (url.startsWith('https://tencent-health.test/')) {
    if (method === 'POST' && url.endsWith('/v1/videos')) {
      tencentPosts += 1;
      return Response.json({
        id: `tencent-health-${tencentPosts}`,
        status: 'completed',
        metadata: { url: 'https://tencent-health.test/result.png' },
      });
    }
    if (method === 'GET' && url.endsWith('/result.png')) {
      return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
    }
  }
  throw new Error(`unexpected fixture request: ${method} ${url}`);
}) as typeof fetch;

function seedMemberAndProject(db: ReturnType<typeof getDb>, projectId: string): string {
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
    VALUES ('project', ?, 'health-member', 'project', ?, ?, ?)`)
    .run(projectId, projectId, now, now);
  return `image-${projectId}`;
}

function insertJob(
  db: ReturnType<typeof getDb>,
  input: { jobId: string; projectId: string; imageId: string; prompt: string },
): void {
  const frozen = freezeUnifiedImageRequest({
    inputImageId: input.imageId,
    referenceImageIds: [],
    prompt: input.prompt,
    tier: '2k',
    ratio: '3:4',
    referenceGuidanceMode: 'none',
  });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs (
      id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality,
      status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex,
      unifiedModel, unifiedRuleVersion, unifiedRequestJson
    ) VALUES (?, ?, ?, '[]', ?, ?, ?, ?, 'auto', 'pending', 0, 1, 'none', ?, 0, ?, ?, ?)`)
    .run(
      input.jobId, input.projectId, input.imageId, UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_IMAGE_MODEL_KEY,
      frozen.prompt, frozen.size, now, UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION,
      JSON.stringify(frozen),
    );
  db.prepare(`INSERT INTO team_resource_scopes
    (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES ('job', ?, 'health-member', 'project', ?, 'project', ?, ?, ?)`)
    .run(input.jobId, input.projectId, input.projectId, now, now);
  db.prepare(`INSERT INTO team_task_principals
    (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES ('image', ?, 'health-member', 'project', ?, ?, ?)`)
    .run(input.jobId, input.projectId, JSON.stringify(frozen), now);
}

try {
  const runtime = await startTeamServiceRuntime();
  assert.equal(runtime.ready, true, runtime.code);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES ('health-member', 'health-member', 'Health Member', 'employee', 'active', 'hash', ?, ?)`)
    .run(now, now);
  updateActorPolicy(db, {
    actorId: 'health-member', monthlyLimitMinor: null, personalConcurrency: 10,
    paused: false, expectedVersion: 0,
  });
  seedProviders();
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://qiniu-health.test', 'qiniu-health-key', UNIFIED_IMAGE_CHANNELS[0].providerId);
  db.prepare(`UPDATE providers SET baseUrl = ?, apiKey = ? WHERE id = ?`)
    .run('https://tencent-health.test', 'tencent-health-key', UNIFIED_IMAGE_CHANNELS[1].providerId);
  configureLegacyMediaProviderPool({
    baseUrl: 'https://qiniu-health.test', apiKey: 'qiniu-health-key', capacity: 4,
  });
  configureLegacyMediaProviderPool({
    baseUrl: 'https://tencent-health.test', apiKey: 'tencent-health-key', capacity: 4,
  });

  for (let index = 1; index <= UNIFIED_CHANNEL_FAILURE_THRESHOLD; index += 1) {
    const projectId = `project-health-${index}`;
    const imageId = seedMemberAndProject(db, projectId);
    insertJob(db, {
      jobId: `job-health-${index}`, projectId, imageId, prompt: `health failure ${index}`,
    });
    await queue.runQueue({
      projectId, concurrency: 2, maxAttempts: 1, timeoutMs: 30_000,
    });
    assert.equal(
      db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get(`job-health-${index}`),
      'needs_check',
    );
  }
  assert.equal(qiniuPosts, UNIFIED_CHANNEL_FAILURE_THRESHOLD);
  assert.equal(tencentPosts, 0);
  const avoided = readUnifiedChannelHealth(db, UNIFIED_IMAGE_MODEL_KEY, 'qiniu');
  assert.equal(avoided?.state, 'avoided');
  assert.equal(avoided?.consecutiveFailures, UNIFIED_CHANNEL_FAILURE_THRESHOLD);

  const skipProject = 'project-health-skip';
  const skipImage = seedMemberAndProject(db, skipProject);
  insertJob(db, {
    jobId: 'job-health-skip', projectId: skipProject, imageId: skipImage,
    prompt: 'health skip avoided channel',
  });
  await queue.runQueue({ projectId: skipProject, concurrency: 2, maxAttempts: 1, timeoutMs: 30_000 });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-health-skip'), 'succeeded');
  assert.equal(qiniuPosts, UNIFIED_CHANNEL_FAILURE_THRESHOLD, 'avoided qiniu receives no new submit');
  assert.equal(tencentPosts, 1, 'compatible work uses tencent immediately');

  db.prepare(`UPDATE execution_media_channel_health SET avoidUntil = ?
    WHERE healthKey = ?`).run(new Date(Date.now() - 60_000).toISOString(), avoided!.healthKey);
  qiniuAvailable = true;
  const recoveryProject = 'project-health-recovery';
  const recoveryImage = seedMemberAndProject(db, recoveryProject);
  insertJob(db, {
    jobId: 'job-health-recovery', projectId: recoveryProject, imageId: recoveryImage,
    prompt: 'health recovery probe',
  });
  await queue.runQueue({ projectId: recoveryProject, concurrency: 2, maxAttempts: 1, timeoutMs: 30_000 });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-health-recovery'), 'succeeded');
  assert.equal(qiniuPosts, UNIFIED_CHANNEL_FAILURE_THRESHOLD + 1, 'recovered qiniu resumes priority');
  assert.equal(tencentPosts, 1);
  assert.equal(readUnifiedChannelHealth(db, UNIFIED_IMAGE_MODEL_KEY, 'qiniu')?.state, 'healthy');

  qiniuRejectNext = true;
  const auditProject = 'project-health-audit-reject';
  const auditImage = seedMemberAndProject(db, auditProject);
  insertJob(db, {
    jobId: 'job-health-audit-reject', projectId: auditProject, imageId: auditImage,
    prompt: 'single material audit rejection',
  });
  await queue.runQueue({ projectId: auditProject, concurrency: 2, maxAttempts: 1, timeoutMs: 30_000 });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-health-audit-reject'), 'succeeded',
    'the fallback channel may still complete after an audit rejection');
  assert.equal(tencentPosts, 2);
  assert.equal(
    readUnifiedChannelHealth(db, UNIFIED_IMAGE_MODEL_KEY, 'qiniu')?.consecutiveFailures,
    0,
    'a single-material audit rejection does not mark the channel unhealthy',
  );

  db.prepare('UPDATE providers SET enabled = 0 WHERE id = ?').run(UNIFIED_IMAGE_CHANNELS[0].providerId);
  const disabledProject = 'project-health-disabled';
  const disabledImage = seedMemberAndProject(db, disabledProject);
  insertJob(db, {
    jobId: 'job-health-disabled', projectId: disabledProject, imageId: disabledImage,
    prompt: 'manual disable remains disabled',
  });
  await queue.runQueue({ projectId: disabledProject, concurrency: 2, maxAttempts: 1, timeoutMs: 30_000 });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').pluck().get('job-health-disabled'), 'succeeded');
  assert.equal(tencentPosts, 3);
  assert.equal(
    db.prepare('SELECT enabled FROM providers WHERE id = ?').pluck().get(UNIFIED_IMAGE_CHANNELS[0].providerId),
    0,
    'health selection never enables a manually disabled provider',
  );

  console.log('unified image health routing tests passed (paid calls: 0)');
} finally {
  globalThis.fetch = originalFetch;
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
