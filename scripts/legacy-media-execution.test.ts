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

const [{ getDb, closeDb }, { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner, getTeamExecutionFacade }, queue, videoQueue, videoProviders] = await Promise.all([
  import('../lib/db.ts'),
  import('../lib/team-service/runtime/index.ts'),
  import('../lib/queue.ts'),
  import('../lib/video-queue.ts'),
  import('../lib/video-providers/index.ts'),
]);
const { configureLegacyMediaProviderPool, legacyMediaProviderPoolKey } = await import('../lib/legacy-media-execution.ts');
const { createLegacyMediaLifecycle } = await import('../lib/legacy-media-lifecycle.ts');
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
  if (req.method === 'POST' && ['/fair-a/v1/images/edits', '/fair-b/v1/images/edits', '/lifecycle-deferred/v1/images/edits'].includes(req.url ?? '')) {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/packy-terminal/v1/images/edits') {
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad request' } }));
    return;
  }
  req.resume();
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const address = fake.address() as { port: number };
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  provider('zero-image', 'openai-compatible', `${baseUrl}/lifecycle-deferred`);
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/lifecycle-deferred`, apiKey: 'shared-secret', capacity: 1 });
  member('member-zero');
  updateActorPolicy(db, { actorId: 'member-zero', monthlyLimitMinor: null, personalConcurrency: 0, paused: false, expectedVersion: 1 });
  project('project-zero', 'member-zero', 'zero-image');
  imageJob('job-zero', 'project-zero', 'member-zero', 'zero-image');
  db.prepare("UPDATE projects SET name='测试床场景项目' WHERE id='project-zero'").run();
  db.prepare("UPDATE image_assets SET usage='scene_seed' WHERE projectId='project-zero'").run();
  let zeroClaims = 0;
  db.function('observe_zero_claim', () => { zeroClaims += 1; return 0; });
  db.exec(`CREATE TEMP TRIGGER observe_zero_claim AFTER UPDATE OF status ON jobs
    WHEN NEW.id='job-zero' AND NEW.status='running' AND OLD.status!='running'
    BEGIN SELECT observe_zero_claim(); END`);
  const zeroRun = queue.runQueue({ projectId: 'project-zero', concurrency: 4, maxAttempts: 2, timeoutMs: 60000 });
  await sleep(1350);
  const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
  const zeroViewer = { userId: 'member-zero', role: 'employee' as const };
  const waitingTask = listTeamTasks(db, zeroViewer).items[0];
  assert.equal(waitingTask.taskName, '新场景图生成');
  assert.equal(waitingTask.scopeName, '测试床场景项目');
  assert.equal(waitingTask.submissionCount, 0);
  assert.match(waitingTask.waitLabel, /上限为 0/);
  const zeroLogs = db.prepare("SELECT message FROM job_logs WHERE jobId='job-zero'").all() as { message: string }[];
  queue.cancelQueue('project-zero');
  await zeroRun;
  db.exec('DROP TRIGGER observe_zero_claim');
  assert.ok(zeroClaims <= 2, `等待期间重新领取过快：${zeroClaims} 次`);
  assert.equal(imageRequests.length, 0, '零并发等待不得发送供应商请求');
  assert.equal(zeroLogs.filter(row => /Job started|Calling API|请求已开始/.test(row.message)).length, 0,
    '等待名额时不得反复输出已经启动/调用供应商的日志');
  assert.ok(zeroLogs.length <= 2, `等待名额不能刷屏，实际 ${zeroLogs.length} 条`);
  assert.equal(db.prepare("SELECT waitReason FROM execution_operations WHERE taskId='job-zero'").pluck().get(), 'stage_canceled');
  assert.equal(listTeamTasks(db, zeroViewer, { status: 'canceled' }).items.length, 1);
  assert.equal(listTeamTasks(db, zeroViewer, { status: 'deferred' }).items.length, 0);
  // Older canceled jobs have a stale deferred ledger; display/filter must still agree.
  db.prepare("UPDATE execution_operations SET status='deferred',waitReason='personal_concurrency' WHERE taskId='job-zero'").run();
  db.prepare("UPDATE jobs SET status='pending' WHERE id='job-zero'").run();
  const { createInheritedActorPolicy } = await import('../lib/media-core/execution/pools.ts');
  const { updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
  db.prepare('DELETE FROM execution_actor_policies WHERE actorId=?').run('member-zero');
  createInheritedActorPolicy(db, 'member-zero');
  updateTeamConcurrencyPolicy(db, { manualDefaultConcurrency: 2, expectedVersion: 0 });
  assert.equal(listTeamTasks(db, { userId: 'member-zero', role: 'admin' }).items[0].waitLabel, '个人运行名额已满（上限 2），名额释放后自动继续', '继承成员等待提示必须使用生效团队默认');
  db.prepare('DELETE FROM execution_actor_policies WHERE actorId=?').run('member-zero');
  updateActorPolicy(db, { actorId: 'member-zero', monthlyLimitMinor: null, personalConcurrency: 0, paused: false, expectedVersion: 0 });
  db.prepare("UPDATE jobs SET status='canceled' WHERE id='job-zero'").run();
  assert.equal(listTeamTasks(db, zeroViewer).items[0].status, 'canceled');
  assert.equal(listTeamTasks(db, zeroViewer, { status: 'deferred' }).items.length, 0);
  assert.equal(listTeamTasks(db, { userId: 'other-member', role: 'employee' }).items.length, 0);
  imageJob('job-zero-resume', 'project-zero', 'member-zero', 'zero-image');
  const resumeRun = queue.runQueue({ projectId: 'project-zero', concurrency: 4, maxAttempts: 2, timeoutMs: 60000 });
  await sleep(100);
  updateActorPolicy(db, { actorId: 'member-zero', monthlyLimitMinor: null, personalConcurrency: 10, paused: false, expectedVersion: 1 });
  await resumeRun;
  assert.equal(imageRequests.length, 1, '解除并发等待后只能发送一次');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='job-zero-resume'").pluck().get(), 'succeeded');
  assert.equal(listTeamTasks(db, zeroViewer, { status: 'succeeded' }).items[0].submissionCount, 1);
  console.log('legacy media zero-concurrency, truthful logs, cancellation and task labels passed');

  provider('lifecycle-deferred-image', 'openai-compatible', `${baseUrl}/lifecycle-deferred`);
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/lifecycle-deferred`, apiKey: 'shared-secret', capacity: 1 });
  member('member-lifecycle-deferred');
  project('project-lifecycle-deferred', 'member-lifecycle-deferred', 'lifecycle-deferred-image');
  imageJob('job-lifecycle-deferred', 'project-lifecycle-deferred', 'member-lifecycle-deferred', 'lifecycle-deferred-image');
  db.prepare("UPDATE jobs SET status = 'deferred' WHERE id = 'job-lifecycle-deferred'").run();
  const deferredLifecycle = createLegacyMediaLifecycle();
  const lifecycleContext = {
    deploymentId: 'legacy-media-test', instanceId: 'legacy-media-test-instance', fence: 1,
    signal: new AbortController().signal,
  };
  deferredLifecycle.start(lifecycleContext);
  const lifecycleDeadline = Date.now() + 2_000;
  while (Date.now() < lifecycleDeadline
    && db.prepare("SELECT status FROM jobs WHERE id = 'job-lifecycle-deferred'").pluck().get() !== 'succeeded') await sleep(20);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-lifecycle-deferred'").pluck().get() as string), 'succeeded',
    'server lifecycle 必须重新发现并领取持久 deferred 任务');
  await deferredLifecycle.drain?.(lifecycleContext);
  console.log('legacy media lifecycle deferred recovery test passed');

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
  assert.equal((db.prepare("SELECT status FROM video_jobs WHERE id = 'job-shared-video'").pluck().get() as string), 'deferred',
    '视频等待必须持久 deferred 并释放编排领取，而不是占 worker 循环 admit');
  assert.equal((db.prepare(`SELECT COUNT(*) FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId WHERE o.taskId = 'job-shared-video'`).pluck().get() as number), 0,
  '跨模块 deferred 不得创建 execution attempt 或费用预留');
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

  const canvasOperation = getTeamExecutionFacade().enqueue({
    operationKey: 'canvas/canvas-before-legacy/submit/r0',
    actor: { userId: 'member-image' },
    scope: { resourceType: 'project', resourceId: 'project-image' },
    module: 'canvas', taskId: 'canvas-before-legacy', step: 'submit', inputRevision: 'r0',
    businessAttempt: { id: 'canvas-before-legacy:r0', number: 1 },
    inputSnapshot: { canvasId: 'canvas-before-legacy' }, inputHash: 'canvas-before-legacy',
    continuationKey: 'canvas.submit', providerSnapshot: { providerId: 'shared-image' },
    requiredPools: [sharedPoolKey], quote: { kind: 'unpriced' },
  });
  imageJob('job-after-canvas', 'project-image', 'member-image');
  const orderedRun = queue.runQueue({
    projectId: 'project-image', jobId: 'job-after-canvas', concurrency: 1, maxAttempts: 1, timeoutMs: 60_000,
  });
  try {
    const outcome = await Promise.race([
      orderedRun.then(() => 'done'),
      sleep(500).then(() => 'timeout'),
    ]);
    assert.equal(outcome, 'done', '旧媒体不得截留先就绪的 canvas grant 后永久等待');
    assert.equal((db.prepare('SELECT status FROM execution_operations WHERE id = ?').pluck()
      .get(canvasOperation.operation.id) as string), 'pending', 'canvas operation 必须留给自己的 continuation');
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-after-canvas'").pluck().get() as string), 'succeeded');
  } finally {
    queue.cancelQueue('project-image');
    await orderedRun;
  }
  console.log('legacy media directed-admission test passed');

  provider('terminal-image', 'openai-compatible', `${baseUrl}/terminal`);
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/terminal`, apiKey: 'shared-secret' });
  member('member-terminal');
  project('project-terminal', 'member-terminal', 'terminal-image');
  imageJob('job-terminal', 'project-terminal', 'member-terminal', 'terminal-image');
  db.prepare("UPDATE jobs SET maxAttempts = 1 WHERE id = 'job-terminal'").run();
  await queue.runQueue({ projectId: 'project-terminal', concurrency: 1, maxAttempts: 1, timeoutMs: 60_000 });
  const terminalFailure = db.prepare("SELECT status, errorMessage FROM jobs WHERE id = 'job-terminal'").get() as { status: string; errorMessage: string };
  assert.equal(terminalFailure.status, 'failed', terminalFailure.errorMessage);
  imageJob('job-after-terminal', 'project-terminal', 'member-terminal', 'shared-image');
  await queue.runQueue({
    projectId: 'project-terminal', jobId: 'job-after-terminal', concurrency: 1, maxAttempts: 1, timeoutMs: 60_000,
  });
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-after-terminal'").pluck().get() as string), 'succeeded');
  const terminalOperation = db.prepare(`SELECT id, status FROM execution_operations
    WHERE module = 'image' AND taskId = 'job-terminal'`).get() as { id: string; status: string };
  const terminalAdmission = getTeamExecutionFacade().admit({
    instanceId: 'legacy-media-test-instance', fence: 1, operationId: terminalOperation.id,
  });
  assert.equal(terminalAdmission.kind, 'idle', 'maxAttempts 耗尽的旧 operation 不得再次占名额');
  assert.equal(terminalOperation.status, 'failed', '业务终态必须保留失败台账');

  provider('terminal-packy', 'packy-images', `${baseUrl}/packy-terminal`);
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/packy-terminal`, apiKey: 'shared-secret' });
  imageJob('job-terminal-packy', 'project-terminal', 'member-terminal', 'terminal-packy');
  db.prepare("UPDATE jobs SET maxAttempts = 1 WHERE id = 'job-terminal-packy'").run();
  await queue.runQueue({
    projectId: 'project-terminal', jobId: 'job-terminal-packy', concurrency: 1, maxAttempts: 1, timeoutMs: 60_000,
  });
  const packyTerminalOperation = db.prepare(`SELECT id, status FROM execution_operations
    WHERE module = 'image' AND taskId = 'job-terminal-packy'`).get() as { id: string; status: string };
  assert.equal(packyTerminalOperation.status, 'failed', 'Packy 明确不可重试终态也必须关闭旧 operation');
  const packyTerminalAdmission = getTeamExecutionFacade().admit({
    instanceId: 'legacy-media-test-instance', fence: 1, operationId: packyTerminalOperation.id,
  });
  assert.equal(packyTerminalAdmission.kind, 'idle');
  console.log('legacy media terminal-operation test passed');

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
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/sync-url`, apiKey: 'shared-secret' });
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

  member('member-frozen');
  project('project-frozen', 'member-frozen', 'shared-image');
  videoJob('job-frozen', 'project-frozen', 'member-frozen');
  const frozenPolls: Array<{ apiKey: string; baseUrl: string }> = [];
  let providerChanged = false;
  videoProviders.registerTestVideoAdapter('openai-video', {
    submit: async () => ({ providerTaskId: 'remote-frozen', rawResponse: null }),
    poll: async (_taskId, apiKey, pollBaseUrl) => {
      frozenPolls.push({ apiKey, baseUrl: pollBaseUrl });
      if (providerChanged) return { status: 'failed', errorMessage: 'must not poll changed identity', rawResponse: null };
      return { status: 'processing', rawResponse: null };
    },
    minimumPollingTimeoutMs: () => 0,
  });
  const frozenRun = videoQueue.runVideoQueue({ projectId: 'project-frozen', concurrency: 1, timeoutMs: 60_000 });
  const frozenAcceptedDeadline = Date.now() + 2_000;
  while (Date.now() < frozenAcceptedDeadline) {
    const remoteId = db.prepare("SELECT providerTaskId FROM video_jobs WHERE id = 'job-frozen'").pluck().get() as string | null;
    if (remoteId === 'remote-frozen') break;
    await sleep(10);
  }
  assert.equal((db.prepare("SELECT providerTaskId FROM video_jobs WHERE id = 'job-frozen'").pluck().get() as string), 'remote-frozen');
  videoQueue.cancelVideoQueue('project-frozen');
  await frozenRun;
  const frozenPollsBeforeConfigChange = frozenPolls.length;
  const frozenExecution = db.prepare(`SELECT providerSnapshotJson, configVersion, credentialVersionRef
    FROM execution_operations WHERE module = 'video' AND taskId = 'job-frozen'`).get() as {
    providerSnapshotJson: string; configVersion: string | null; credentialVersionRef: string | null;
  };
  assert.equal((JSON.parse(frozenExecution.providerSnapshotJson) as { baseUrl: string }).baseUrl, baseUrl);
  assert.ok(frozenExecution.configVersion, '操作建立时必须冻结供应商配置版本');
  assert.ok(frozenExecution.credentialVersionRef, '操作建立时必须冻结受保护凭据版本引用');
  providerChanged = true;
  db.prepare("UPDATE video_providers SET baseUrl = ?, apiKey = 'changed-secret' WHERE id = 'shared-video'")
    .run(`${baseUrl}/changed-default`);
  await videoQueue.resumeVideoJobPolling('job-frozen');
  assert.equal(frozenPolls.length, frozenPollsBeforeConfigChange, '在途任务不得使用管理员后来修改的账号续查');
  const frozenRecovery = db.prepare("SELECT status, errorMessage FROM video_jobs WHERE id = 'job-frozen'").get() as {
    status: string; errorMessage: string;
  };
  assert.equal(frozenRecovery.status, 'needs_check', frozenRecovery.errorMessage);
  assert.match(frozenRecovery.errorMessage, /配置|凭据/, '无凭据版本解析设施时必须明确 fail closed');
  console.log('legacy media frozen-provider recovery test passed');

  provider('missing-pool-image', 'openai-compatible', `${baseUrl}/missing-pool`);
  member('member-missing-pool');
  project('project-missing-pool', 'member-missing-pool', 'missing-pool-image');
  imageJob('job-missing-pool', 'project-missing-pool', 'member-missing-pool', 'missing-pool-image');
  await queue.runQueue({ projectId: 'project-missing-pool', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal(imageRequests.filter((url) => url.includes('/missing-pool/')).length, 0,
    '缺少显式受控池时必须在 POST 前 fail closed');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-missing-pool'").pluck().get() as string), 'failed');
  assert.equal((db.prepare("SELECT attempt FROM jobs WHERE id = 'job-missing-pool'").pluck().get() as number), 0,
    '缺池不得消耗业务 attempt');
  assert.equal((db.prepare(`SELECT COUNT(*) FROM execution_pools WHERE mappingSnapshotJson LIKE '%/missing-pool%'`)
    .pluck().get() as number), 0, '缺池不得自动启用容量 10');
  console.log('legacy media missing-pool fail-closed test passed');

  provider('unverified-pool-image', 'openai-compatible', `${baseUrl}/unverified-pool`);
  member('member-unverified-pool');
  project('project-unverified-pool', 'member-unverified-pool', 'unverified-pool-image');
  imageJob('job-unverified-pool', 'project-unverified-pool', 'member-unverified-pool', 'unverified-pool-image');
  db.prepare(`INSERT INTO execution_pools (poolKey, kind, capacity, enabled, mappingSnapshotJson, version, updatedAt)
    VALUES (?, 'remote', 10, 1, '{}', 1, ?)`)
    .run(legacyMediaProviderPoolKey(`${baseUrl}/unverified-pool`, 'shared-secret'), new Date().toISOString());
  await queue.runQueue({ projectId: 'project-unverified-pool', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal(imageRequests.filter((url) => url.includes('/unverified-pool/')).length, 0,
    '既有池映射未核验时也必须 fail closed');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-unverified-pool'").pluck().get() as string), 'failed');
  assert.equal((db.prepare("SELECT attempt FROM jobs WHERE id = 'job-unverified-pool'").pluck().get() as number), 0);
  console.log('legacy media unverified-pool fail-closed test passed');

  const fairnessPool = configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/fair-a`, apiKey: 'shared-secret', capacity: 1 });
  configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/fair-b`, apiKey: 'shared-secret', capacity: 1 });
  const { readTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
  updateTeamConcurrencyPolicy(db, { mode: 'auto', manualDefaultConcurrency: 1, expectedVersion: readTeamConcurrencyPolicy(db).version });
  member('member-fair');
  updateActorPolicy(db, { actorId: 'member-fair', monthlyLimitMinor: null, personalConcurrency: 0, concurrencyMode: 'inherit', paused: false, expectedVersion: 1 });
  provider('fair-image-a', 'openai-compatible', `${baseUrl}/fair-a`);
  provider('fair-image-b', 'openai-compatible', `${baseUrl}/fair-b`);
  project('project-fair', 'member-fair', 'fair-image-a');
  imageJob('job-fair-a', 'project-fair', 'member-fair', 'fair-image-a');
  imageJob('job-fair-b', 'project-fair', 'member-fair', 'fair-image-b');
  const blocker = getTeamExecutionFacade().enqueue({
    operationKey: 'image/fairness-blocker/submit/r0', actor: { userId: 'member-image' },
    scope: { resourceType: 'project', resourceId: 'project-image' },
    module: 'image', taskId: 'fairness-blocker', step: 'submit', inputRevision: 'r0',
    businessAttempt: { id: 'fairness-blocker:r0', number: 1 },
    inputSnapshot: { taskId: 'fairness-blocker' }, inputHash: 'fairness-blocker',
    continuationKey: 'legacy-image.submit', providerSnapshot: { providerId: 'fair-image-a' },
    requiredPools: [fairnessPool], quote: { kind: 'unpriced' },
  });
  const blockerAdmission = getTeamExecutionFacade().admit({
    instanceId: 'legacy-media-test-instance', fence: 1, operationId: blocker.operation.id,
  });
  assert.equal(blockerAdmission.kind, 'admitted');
  if (blockerAdmission.kind !== 'admitted') throw new Error('fairness blocker must hold the pool');
  const fairRun = queue.runQueue({ projectId: 'project-fair', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  const fairDeadline = Date.now() + 2_000;
  while (Date.now() < fairDeadline
    && db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-b'").pluck().get() !== 'succeeded') await sleep(20);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-b'").pluck().get() as string), 'succeeded',
    'A 等待不可用一个池时，B 的首步必须能领取并准入另一个池');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-a'").pluck().get() as string), 'deferred');
  assert.equal((db.prepare("SELECT attempt FROM jobs WHERE id = 'job-fair-a'").pluck().get() as number), 0);
  assert.equal((db.prepare(`SELECT COUNT(*) FROM execution_attempts WHERE operationId = ?`)
    .pluck().get(db.prepare("SELECT id FROM execution_operations WHERE taskId = 'job-fair-a'").pluck().get()) as number), 0,
  'deferred 等待不得创建 execution attempt 或预留预算');
  await getTeamExecutionFacade().settle({
    attemptId: blockerAdmission.grant.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
  });
  await fairRun;
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-a'").pluck().get() as string), 'succeeded');
  assert.equal(imageRequests.filter((url) => url === '/fair-a/v1/images/edits').length, 1);
  assert.equal(imageRequests.filter((url) => url === '/fair-b/v1/images/edits').length, 1);

  imageJob('job-fair-auto-a', 'project-fair', 'member-fair', 'fair-image-a');
  imageJob('job-fair-auto-b', 'project-fair', 'member-fair', 'fair-image-b');
  await queue.runQueue({ projectId: 'project-fair', concurrency: 2, maxAttempts: 2, timeoutMs: 60_000 });
  assert.equal(imageRequests.filter((url) => url === '/fair-a/v1/images/edits').length, 2, '自动继承成员在真实图片入口借用空闲 A 池容量');
  assert.equal(imageRequests.filter((url) => url === '/fair-b/v1/images/edits').length, 2, '自动继承成员在真实图片入口借用空闲 B 池容量');
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state='held' AND kind='concurrency' AND actorId='member-fair'").pluck().get(), 0, '真实图片完成后释放自动借用名额，不改变费用台账');

  imageJob('job-fair-c', 'project-fair', 'member-fair', 'fair-image-a');
  imageJob('job-fair-d', 'project-fair', 'member-fair', 'fair-image-b');
  db.prepare("UPDATE jobs SET status = 'deferred' WHERE id IN ('job-fair-c', 'job-fair-d')").run();
  const secondBlocker = getTeamExecutionFacade().enqueue({
    operationKey: 'image/fairness-second-blocker/submit/r0', actor: { userId: 'member-image' },
    scope: { resourceType: 'project', resourceId: 'project-image' },
    module: 'image', taskId: 'fairness-second-blocker', step: 'submit', inputRevision: 'r0',
    businessAttempt: { id: 'fairness-second-blocker:r0', number: 1 },
    inputSnapshot: { taskId: 'fairness-second-blocker' }, inputHash: 'fairness-second-blocker',
    continuationKey: 'legacy-image.submit', providerSnapshot: { providerId: 'fair-image-a' },
    requiredPools: [fairnessPool], quote: { kind: 'unpriced' },
  });
  const secondBlockerAdmission = getTeamExecutionFacade().admit({
    instanceId: 'legacy-media-test-instance', fence: 1, operationId: secondBlocker.operation.id,
  });
  assert.equal(secondBlockerAdmission.kind, 'admitted');
  if (secondBlockerAdmission.kind !== 'admitted') throw new Error('second fairness blocker must hold the pool');
  const deferredFairRun = queue.runQueue({ projectId: 'project-fair', concurrency: 1, maxAttempts: 2, timeoutMs: 60_000 });
  const deferredFairDeadline = Date.now() + 2_000;
  while (Date.now() < deferredFairDeadline
    && db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-d'").pluck().get() !== 'succeeded') await sleep(20);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-d'").pluck().get() as string), 'succeeded',
    '两个持久 deferred 任务也必须轮转，A 的不可用池不得让 B 永久饥饿');
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-c'").pluck().get() as string), 'deferred');
  await getTeamExecutionFacade().settle({
    attemptId: secondBlockerAdmission.grant.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
  });
  await deferredFairRun;
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'job-fair-c'").pluck().get() as string), 'succeeded');
  console.log('legacy media persistent-deferred fairness test passed');
} finally {
  releaseImage();
  await drainTeamRuntime(5_000);
  await releaseTeamRuntimeOwner();
  closeDb();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
