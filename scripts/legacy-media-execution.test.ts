import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { register } from 'node:module';

// 公共队列接缝 + 真实 SQLite/execution；供应商均为 loopback/fake，不访问外网。
register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-media-execution-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'legacy-media-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'legacy-media-test-instance',
  CREATIVE_STUDIO_PORT: '43107',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const [{ getDb, closeDb }, { startTeamServiceRuntime, releaseTeamRuntimeOwner }, queue, videoQueue, videoProviders] = await Promise.all([
  import('../lib/db.ts'),
  import('../lib/team-service/runtime/index.ts'),
  import('../lib/queue.ts'),
  import('../lib/video-queue.ts'),
  import('../lib/video-providers/index.ts'),
]);
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');

const runtime = await startTeamServiceRuntime();
assert.equal(runtime.ready, true, runtime.code);
const db = getDb();
const now = new Date().toISOString();
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toBuffer();
const inputPath = path.join(root, 'input.png');
fs.writeFileSync(inputPath, png);

function member(id: string): void {
  db.prepare(`
    INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, createdAt, updatedAt)
    VALUES (?, ?, ?, 'employee', 'active', 'hash', ?, ?)
  `).run(id, id, id, now, now);
  updateActorPolicy(db, {
    actorId: id, monthlyLimitMinor: null, personalConcurrency: 1, paused: false, expectedVersion: 0,
  });
}

function project(id: string, actorId: string, providerId: string): void {
  db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, ?, 'model-a', 'prompt')`)
    .run(id, id, providerId);
  db.prepare(`
    INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, rootType, rootId, createdAt, updatedAt)
    VALUES ('project', ?, ?, 'project', ?, ?, ?)
  `).run(id, actorId, id, now, now);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, mimeType) VALUES (?, ?, 'input', 'input.png', ?, 'image/png')`)
    .run(`image-${id}`, id, inputPath);
}

function principal(module: 'image' | 'video', taskId: string, actorId: string, projectId: string): void {
  db.prepare(`
    INSERT INTO team_task_principals (module, taskId, actorUserId, scopeType, scopeId, creationSnapshot, createdAt)
    VALUES (?, ?, ?, 'project', ?, '{}', ?)
  `).run(module, taskId, actorId, projectId, now);
  db.prepare(`
    INSERT INTO team_resource_scopes (resourceType, resourceId, ownerUserId, parentType, parentId, rootType, rootId, createdAt, updatedAt)
    VALUES (?, ?, ?, 'project', ?, 'project', ?, ?, ?)
  `).run(module === 'image' ? 'job' : 'video_job', taskId, actorId, projectId, projectId, now, now);
}

function imageJob(id: string, projectId: string, actorId: string, providerId = 'shared-image'): void {
  db.prepare(`
    INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, size, quality, status, attempt, maxAttempts)
    VALUES (?, ?, ?, ?, 'model-a', 'prompt', '16x16', 'standard', 'pending', 0, 2)
  `).run(id, projectId, `image-${projectId}`, providerId);
  principal('image', id, actorId, projectId);
}

function videoJob(id: string, projectId: string, actorId: string, providerId = 'shared-video'): void {
  db.prepare(`
    INSERT INTO video_jobs (id, projectId, sourceImageId, providerId, model, prompt, durationSec, status, attempt, maxAttempts)
    VALUES (?, ?, ?, ?, 'model-a', 'prompt', 5, 'pending', 0, 2)
  `).run(id, projectId, `image-${projectId}`, providerId);
  principal('video', id, actorId, projectId);
}

function provider(id: string, type: string, baseUrl: string, apiKey = 'shared-secret'): void {
  db.prepare(`
    INSERT INTO providers (id, name, type, baseUrl, apiKey, model, enabled)
    VALUES (?, ?, ?, ?, ?, 'model-a', 1)
  `).run(id, id, type, baseUrl, apiKey);
}

function videoProvider(id: string, type: string, baseUrl: string, apiKey = 'shared-secret'): void {
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, baseUrl, apiKey, accessKey, secretKey)
    VALUES (?, ?, ?, '', '', '', 'model-a', 1, ?, ?, 'ak', 'sk')
  `).run(id, id, type, baseUrl, apiKey);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let imageRequestStarted!: () => void;
const imageStarted = new Promise<void>((resolve) => { imageRequestStarted = resolve; });
let releaseImage!: () => void;
const imageReleased = new Promise<void>((resolve) => { releaseImage = resolve; });
const imageRequests: string[] = [];
let videoDownloads = 0;
let syncImageDownloads = 0;
const fake = http.createServer((req, res) => {
  if (req.method === 'POST') imageRequests.push(req.url ?? '');
  if (req.method === 'GET' && req.url === '/sync-image.png') {
    syncImageDownloads += 1;
    if (syncImageDownloads === 1) {
      queue.cancelQueue('project-sync-url');
      res.writeHead(500).end();
    } else res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
    return;
  }
  if (req.method === 'POST' && req.url === '/sync-url/v1/images/edits') {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ url: `${baseUrl}/sync-image.png` }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/download-only.mp4') {
    videoDownloads += 1;
    if (videoDownloads === 1) {
      videoQueue.cancelVideoQueue('project-restart');
      res.writeHead(500).end();
    } else res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(Buffer.from('fake-video-bytes'));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/images/edits') {
    req.resume();
    imageRequestStarted();
    void imageReleased.then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    });
    return;
  }
  req.resume();
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const address = fake.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const sharedPoolKey = configureLegacyMediaProviderPool({ baseUrl, apiKey: 'shared-secret', capacity: 1 });
  provider('shared-image', 'openai-compatible', baseUrl);
  videoProvider('shared-video', 'openai-video', baseUrl);
  member('member-image');
  member('member-video');
  project('project-image', 'member-image', 'shared-image');
  project('project-video', 'member-video', 'shared-image');
  imageJob('job-shared-image', 'project-image', 'member-image');
  videoJob('job-shared-video', 'project-video', 'member-video');

  let videoSubmits = 0;
  videoProviders.registerTestVideoAdapter('openai-video', {
    submit: async () => {
      videoSubmits += 1;
      return { providerTaskId: 'remote-shared-video', rawResponse: null };
    },
    poll: async () => ({ status: 'failed', errorMessage: 'fake terminal', rawResponse: null }),
    minimumPollingTimeoutMs: () => 0,
  });

  const imageRun = queue.runQueue({ projectId: 'project-image', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  await imageStarted;
  const videoRun = videoQueue.runVideoQueue({ projectId: 'project-video', concurrency: 1, timeoutMs: 60_000 });
  await sleep(150);
  assert.equal(videoSubmits, 0, '同一实际上游池只有一个名额时，视频不得越过未完成的图片提交');
  assert.equal((db.prepare("SELECT attempt FROM jobs WHERE id = 'job-shared-image'").pluck().get() as number), 1);
  assert.equal((db.prepare("SELECT attempt FROM video_jobs WHERE id = 'job-shared-video'").pluck().get() as number), 0,
    '等待共享池名额不得增加视频业务 attempt');
  releaseImage();
  await imageRun;
  await videoRun;
  assert.equal(videoSubmits, 1);
  const held = db.prepare(`
    SELECT COUNT(*) FROM execution_reservations
    WHERE poolKey = ? AND kind = 'concurrency' AND state = 'held'
  `).pluck().get(sharedPoolKey) as number;
  assert.equal(held, 0, '远端明确终态后必须释放共享生成池，而不是等本地下载或进程退出');
  console.log('legacy media shared-pool test passed');

  provider('legacy-unknown-image', 'openai-compatible', `${baseUrl}/legacy-unknown`);
  member('member-legacy-unknown');
  project('project-legacy-unknown', 'member-legacy-unknown', 'legacy-unknown-image');
  imageJob('job-legacy-unknown', 'project-legacy-unknown', 'member-legacy-unknown', 'legacy-unknown-image');
  db.prepare("UPDATE jobs SET status = 'running', attempt = 1 WHERE id = 'job-legacy-unknown'").run();
  await queue.runQueue({ projectId: 'project-legacy-unknown', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal(imageRequests.filter((url) => url.includes('legacy-unknown')).length, 0,
    '没有回执的遗留 running 同步任务不得在 startup 被重发');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-legacy-unknown'").pluck().get() as string), 'needs_check');
  console.log('legacy media synchronous-unknown recovery test passed');

  member('member-restart');
  project('project-restart', 'member-restart', 'shared-image');
  videoJob('job-restart', 'project-restart', 'member-restart');
  let restartSubmits = 0;
  let restartPolls = 0;
  let firstPollStarted!: () => void;
  const firstPoll = new Promise<void>((resolve) => { firstPollStarted = resolve; });
  let releaseFirstPoll!: () => void;
  const firstPollRelease = new Promise<void>((resolve) => { releaseFirstPoll = resolve; });
  videoProviders.registerTestVideoAdapter('openai-video', {
    submit: async () => {
      restartSubmits += 1;
      return { providerTaskId: 'remote-restart', rawResponse: null };
    },
    poll: async () => {
      restartPolls += 1;
      if (restartPolls === 1) {
        firstPollStarted();
        await firstPollRelease;
        return { status: 'processing', rawResponse: null };
      }
      return { status: 'succeeded', videoUrl: `${baseUrl}/download-only.mp4`, rawResponse: null };
    },
    minimumPollingTimeoutMs: () => 0,
  });
  const acceptedRun = videoQueue.runVideoQueue({ projectId: 'project-restart', concurrency: 1, timeoutMs: 60_000 });
  await firstPoll;
  videoQueue.cancelVideoQueue('project-restart');
  releaseFirstPoll();
  await acceptedRun;
  assert.equal((db.prepare("SELECT status FROM video_jobs WHERE id = 'job-restart'").pluck().get() as string), 'needs_check',
    'server 取消不得把已受理远端任务标成 canceled');

  db.prepare("UPDATE team_users SET status = 'disabled' WHERE id = 'member-restart'").run();
  await videoQueue.runVideoQueue({ projectId: 'project-restart', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(restartSubmits, 1, '重启和停用成员后的已受理续查不得重新付费');
  assert.equal((db.prepare("SELECT providerStatus FROM video_jobs WHERE id = 'job-restart'").pluck().get() as string), 'download_failed');
  const pollsBeforeDownloadRepair = restartPolls;
  await videoQueue.resumeVideoJobPolling('job-restart');
  assert.equal(restartSubmits, 1);
  assert.equal(restartPolls, pollsBeforeDownloadRepair, '已有 remoteVideoUrl 的下载修复不得重复 poll');
  assert.equal(videoDownloads, 2);
  const repaired = db.prepare("SELECT status, errorMessage FROM video_jobs WHERE id = 'job-restart'").get() as { status: string; errorMessage: string };
  assert.equal(repaired.status, 'succeeded', repaired.errorMessage);
  assert.equal((db.prepare("SELECT attempt FROM video_jobs WHERE id = 'job-restart'").pluck().get() as number), 1,
    '续查和补下载不增加业务 attempt');
  console.log('legacy media accepted-recovery and download-only test passed');

  provider('sync-url-image', 'openai-compatible', `${baseUrl}/sync-url`);
  member('member-sync-url');
  project('project-sync-url', 'member-sync-url', 'sync-url-image');
  imageJob('job-sync-url', 'project-sync-url', 'member-sync-url', 'sync-url-image');
  await queue.runQueue({ projectId: 'project-sync-url', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal((db.prepare("SELECT providerStatus FROM jobs WHERE id = 'job-sync-url'").pluck().get() as string), 'download_failed');
  assert.equal(syncImageDownloads, 1);
  db.prepare(`UPDATE jobs SET status = 'running', providerStatus = NULL, remoteImageUrl = NULL
    WHERE id = 'job-sync-url'`).run();
  await queue.runQueue({ projectId: 'project-sync-url', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal(imageRequests.filter((url) => url === '/sync-url/v1/images/edits').length, 1,
    '同步 URL 结果重启后不得再次生成');
  assert.equal(syncImageDownloads, 2, '重启只补下载');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-sync-url'").pluck().get() as string), 'succeeded');
  console.log('legacy media synchronous URL download recovery test passed');
} finally {
  releaseImage();
  await releaseTeamRuntimeOwner();
  closeDb();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
