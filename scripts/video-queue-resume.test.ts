import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// dataRoot 必须指向独立测试根,并在动态导入依赖模块前设置
const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-video-queue-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const dbModule = await import('../lib/db.ts');
const queueModule = await import('../lib/video-queue.ts');
const providersModule = await import('../lib/video-providers/index.ts');

const db = dbModule.getDb();

db.prepare(`
  INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
  VALUES ('provider-x', '测试供应商', 'http://fake.example', 'fake-key', 'model-x', 'openai-compatible', 1)
`).run();

function insertProject(id: string): void {
  db.prepare(`
    INSERT INTO projects (id, name, providerId, model, prompt)
    VALUES (?, '测试项目', 'provider-x', 'model-x', 'prompt')
  `).run(id);
}

function insertImageAsset(id: string, projectId: string): void {
  db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, mimeType)
    VALUES (?, ?, 'input', ?, ?, 'image/png')
  `).run(id, projectId, `${id}.png`, `/tmp/${id}.png`);
}

function insertProvider(id: string, type: string): void {
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, baseUrl, apiKey, accessKey, secretKey)
    VALUES (?, ?, ?, '', '', '', 'model-a', 1, 'http://fake.example', 'fake-key', 'ak', 'sk')
  `).run(id, `${id} 名称`, type);
}

function insertVideoJob(
  id: string,
  projectId: string,
  overrides: {
    status?: string;
    providerId?: string;
    maxAttempts?: number;
    createdAt?: string;
  } = {},
): void {
  db.prepare(`
    INSERT INTO video_jobs (id, projectId, sourceImageId, providerId, model, prompt, durationSec, status, maxAttempts, createdAt)
    VALUES (?, ?, ?, ?, 'model-a', 'prompt', 5, ?, ?, ?)
  `).run(
    id,
    projectId,
    'img-' + projectId,
    overrides.providerId ?? 'fake-kling',
    overrides.status ?? 'pending',
    overrides.maxAttempts ?? 1,
    overrides.createdAt ?? new Date().toISOString(),
  );
}

function videoJobStatus(id: string): string {
  return (db.prepare(`SELECT status FROM video_jobs WHERE id = ?`).get(id) as { status: string }).status;
}

function videoJobAttempt(id: string): number {
  return (db.prepare(`SELECT attempt FROM video_jobs WHERE id = ?`).get(id) as { attempt: number }).attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(id: string, statuses: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = videoJobStatus(id);
  while (Date.now() < deadline) {
    if (statuses.includes(last)) return last;
    await sleep(25);
    last = videoJobStatus(id);
  }
  return last;
}

// 基础钳制与默认值
assert.equal(queueModule.DEFAULT_VIDEO_TIMEOUT_MS, 15 * 60_000, '默认轮询窗口应提高到 15 分钟');
assert.equal(queueModule.DEFAULT_VIDEO_MAX_ATTEMPTS, 2, '运行时重试上限默认 2');
assert.equal(queueModule.providerConcurrencyLimit('kling'), null, '内置 kling 闸门已移除，默认不限速');
assert.equal(queueModule.providerConcurrencyLimit('jimeng'), null, '未列出的供应商不限速');

// VIDEO_TIMEOUT_MS 环境变量覆盖与钳制(子进程验证,避免污染本进程模块缓存)
{
  const { execFileSync } = await import('node:child_process');
  const probe = (code: string): string => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  }).trim();
  const value = probe(`
    process.env.VIDEO_TIMEOUT_MS = '120000';
    const { DEFAULT_VIDEO_TIMEOUT_MS } = await import('./lib/video-queue.ts');
    console.log(DEFAULT_VIDEO_TIMEOUT_MS);
  `);
  assert.equal(value, '120000', 'VIDEO_TIMEOUT_MS 必须可覆盖默认窗口');
  const clamped = probe(`
    process.env.VIDEO_TIMEOUT_MS = '10';
    const { DEFAULT_VIDEO_TIMEOUT_MS } = await import('./lib/video-queue.ts');
    console.log(DEFAULT_VIDEO_TIMEOUT_MS);
  `);
  assert.equal(clamped, '60000', '过小的 VIDEO_TIMEOUT_MS 必须被钳制到 1 分钟');
}

// 领取顺序与 createdAt 一致(不是 uuid 随机序)
{
  insertProject('project-order');
  insertImageAsset('img-project-order', 'project-order');
  insertProvider('fake-kling', 'kling');
  insertVideoJob('job-old', 'project-order', { createdAt: '2026-08-01T00:00:00.000Z' });
  insertVideoJob('job-new', 'project-order', { createdAt: '2026-08-02T00:00:00.000Z' });
  const first = queueModule.claimNextVideoJob('project-order');
  assert.equal(first.job?.id, 'job-old', '领取顺序必须与 createdAt 一致');
  const second = queueModule.claimNextVideoJob('project-order');
  assert.equal(second.job?.id, 'job-new', '第二条领取紧随其后');
  // 释放这两个 running 名额,避免影响后续闸门测试的计数
  db.prepare(`UPDATE video_jobs SET status = 'succeeded' WHERE id IN ('job-old', 'job-new')`).run();
}

// needs_check 自动续跑领取:持有远端 task_id 的任务转 running 继续轮询
{
  insertProject('project-resume');
  insertImageAsset('img-project-resume', 'project-resume');
  insertVideoJob('resume-job', 'project-resume', { status: 'needs_check' });
  db.prepare(`UPDATE video_jobs SET providerTaskId = 'remote-task-1' WHERE id = 'resume-job'`).run();
  const claimed = queueModule.claimNeedsCheckVideoJob('project-resume');
  assert.equal(claimed?.id, 'resume-job', 'needs_check 任务必须可自动续跑领取');
  assert.equal(videoJobStatus('resume-job'), 'running', '续跑领取后任务回到 running');
  assert.equal(videoJobAttempt('resume-job'), 1, '续跑领取会计入尝试次数');
}

// --- P0-c:适配器内部 AbortError 不得误判为用户取消 ---
{
  insertProject('project-abort');
  insertImageAsset('img-project-abort', 'project-abort');
  insertProvider('abort-provider', 'kling');
  insertVideoJob('abort-job', 'project-abort', { providerId: 'abort-provider' });
  let submitCalls = 0;
  providersModule.registerTestVideoAdapter('kling', {
    submit: async () => { submitCalls += 1; return { providerTaskId: 'remote-abort-1', rawResponse: null }; },
    poll: async () => { throw new DOMException('internal timeout', 'AbortError'); },
    minimumPollingTimeoutMs: () => 0,
  });
  const run = queueModule.runVideoQueue({
    projectId: 'project-abort',
    concurrency: 1,
    timeoutMs: 60_000,
  });
  // 轮询循环首轮前有 5 秒等待,采样 5.5 秒覆盖首次轮询超时。needs_check 与
  // 续跑的 running 状态切换在同一事件循环内完成(微秒级),采样很难直接
  // 抓到 needs_check 本身,因此用持久标记验证:providerStatus 记下 needs_check,
  // attempt >= 2 证明任务被自动续跑重新领取过。
  const observed = new Set<string>();
  const deadline = Date.now() + 5_500;
  while (Date.now() < deadline) {
    observed.add(videoJobStatus('abort-job'));
    await sleep(25);
  }
  assert.ok(!observed.has('canceled'), '适配器内部超时是普通失败,不得写成 canceled(远端任务仍在跑)');
  const abortRow = db.prepare(`
    SELECT providerStatus, attempt FROM video_jobs WHERE id = 'abort-job'
  `).get() as { providerStatus: string | null; attempt: number };
  assert.equal(abortRow.providerStatus, 'needs_check', '内部超时后应转入 needs_check 等待补抓');
  assert.ok(abortRow.attempt >= 2, 'needs_check 必须被队列自动续跑重新领取');
  assert.equal(submitCalls, 1, '已有 task_id 的失败不允许重新 submit(防重复扣费)');
  queueModule.cancelVideoQueue('project-abort');
  await run.catch(() => undefined);
}

// --- P0-b:needs_check 自动续跑(队列活跃时任务不掉出自动化管线) ---
{
  insertProject('project-autoresume');
  insertImageAsset('img-project-autoresume', 'project-autoresume');
  insertProvider('autoresume-provider', 'kling');
  insertVideoJob('autoresume-job', 'project-autoresume', { providerId: 'autoresume-provider' });
  let pollCalls = 0;
  providersModule.registerTestVideoAdapter('kling', {
    submit: async () => ({ providerTaskId: 'remote-auto-1', rawResponse: null }),
    poll: async () => {
      pollCalls += 1;
      if (pollCalls >= 3) return { status: 'succeeded', videoUrl: 'https://cdn.example/v.mp4', rawResponse: null };
      throw new Error('temporary poll failure');
    },
    minimumPollingTimeoutMs: () => 0,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith('https://cdn.example/')) {
      return new Response(Buffer.from('fake-video-bytes'), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  const run = queueModule.runVideoQueue({
    projectId: 'project-autoresume',
    concurrency: 1,
    timeoutMs: 60_000,
  });
  try {
    const finalStatus = await waitForStatus('autoresume-job', ['succeeded', 'failed', 'needs_check'], 30_000);
    assert.equal(finalStatus, 'succeeded', '轮询失败掉出窗口后必须自动续跑,直至取回结果');
    assert.ok(pollCalls >= 3, `预期发生多轮续跑轮询,实际 ${pollCalls} 次`);
    assert.ok(videoJobAttempt('autoresume-job') >= 2, '续跑后尝试次数大于 1');
  } finally {
    globalThis.fetch = originalFetch;
    queueModule.cancelVideoQueue('project-autoresume');
    await run.catch(() => undefined);
  }
}

// --- P0-d:存量库 maxAttempts=1 的旧行也能自动重试一次(运行时兜底) ---
{
  insertProject('project-retry');
  insertImageAsset('img-project-retry', 'project-retry');
  insertProvider('retry-provider', 'kling');
  insertVideoJob('retry-job', 'project-retry', { maxAttempts: 1, providerId: 'retry-provider' });
  providersModule.registerTestVideoAdapter('kling', {
    submit: async () => { throw new Error('provider down'); },
    poll: async () => { throw new Error('unreachable'); },
    minimumPollingTimeoutMs: () => 0,
  });
  await queueModule.runVideoQueue({
    projectId: 'project-retry',
    concurrency: 1,
    timeoutMs: 60_000,
  });
  assert.equal(videoJobStatus('retry-job'), 'failed', '最终失败');
  assert.equal(videoJobAttempt('retry-job'), 2, 'maxAttempts=1 的旧行也必须重试一次(运行时兜底到 2)');
}

// --- 提交限流退避:429/5xx 不消耗 maxAttempts,冷却退避,重排有界 ---
{
  assert.equal(queueModule.isRateLimitedSubmitError('Video gateway submit error 429: rate limited'), true);
  assert.equal(queueModule.isRateLimitedSubmitError('Video gateway submit error 503: overloaded'), true);
  assert.equal(queueModule.isRateLimitedSubmitError('Video gateway submit error 400: bad request'), false);

  insertProject('project-ratelimit');
  insertImageAsset('img-project-ratelimit', 'project-ratelimit');
  insertProvider('ratelimit-provider', 'kling');
  insertVideoJob('ratelimit-job', 'project-ratelimit', { providerId: 'ratelimit-provider' });
  let rlSubmitCalls = 0;
  providersModule.registerTestVideoAdapter('kling', {
    submit: async () => { rlSubmitCalls += 1; throw new Error('Video gateway submit error 429: rate limited'); },
    poll: async () => { throw new Error('unreachable'); },
    minimumPollingTimeoutMs: () => 0,
  });
  queueModule._resetRateLimitStateForTest();
  // 缩短冷却,避免测试等待真实的 30s 退避
  const savedCooldowns = [...queueModule.RATE_LIMIT_COOLDOWN_MS];
  queueModule.RATE_LIMIT_COOLDOWN_MS.splice(0, queueModule.RATE_LIMIT_COOLDOWN_MS.length, 10);
  try {
    await queueModule.runVideoQueue({
      projectId: 'project-ratelimit',
      concurrency: 1,
      timeoutMs: 60_000,
    });
  } finally {
    queueModule.RATE_LIMIT_COOLDOWN_MS.splice(0, queueModule.RATE_LIMIT_COOLDOWN_MS.length, ...savedCooldowns);
  }
  assert.equal(rlSubmitCalls, queueModule.RATE_LIMIT_MAX_REQUEUES + 1, '限流重排必须有界(初始提交 + 5 次重排)');
  assert.equal(videoJobStatus('ratelimit-job'), 'failed', '持续限流最终标失败');
  const rlRow = db.prepare(`SELECT errorMessage, attempt FROM video_jobs WHERE id = 'ratelimit-job'`).get() as { errorMessage: string; attempt: number };
  assert.ok(rlRow.errorMessage.includes('网关持续限流'), '失败信息须说明是持续限流');
  assert.ok(rlRow.attempt > 2, '限流重试不消耗 maxAttempts(默认 2 次外仍重排)');
}

console.log('video queue resume tests passed');

fs.rmSync(externalDataRoot, { recursive: true, force: true });
