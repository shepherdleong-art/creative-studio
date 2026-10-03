import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { submitGatewayTaskImage, type GatewayTaskImageRequest } from '../lib/providers/gateway-task-image.ts';
import { _resetCosMediaCacheForTest } from '../lib/cos-media.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-image-adapters-'));
const originalFetch = globalThis.fetch;
const envNames = ['CREATIVE_STUDIO_COS_SECRET_ID', 'CREATIVE_STUDIO_COS_SECRET_KEY', 'CREATIVE_STUDIO_COS_DOMAIN'];
const oldEnv = envNames.map(name => process.env[name]);
const base = path.join(dir, 'base.png');
const ref = path.join(dir, 'ref.png');
await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toFile(base);
await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toFile(ref);
const expectedImageNames = [base, ref].map(file => `${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}.png`);
const imageNames = (urls: unknown) => (urls as string[]).map(url => path.posix.basename(new URL(url).pathname));
let posts = 0;
let endpoint = '';
let body: Record<string, unknown> = {};
let responseMode: 'ok' | 'error' | 'no-url' = 'ok';
const request: GatewayTaskImageRequest = {
  model: 'nano-banana-3.0', prompt: '换背景', inputImagePath: base, inputMimeType: 'image/png',
  referenceImagePaths: [ref], referenceMimeTypes: ['image/png'], size: '3840x2160', quality: 'auto',
};
try {
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'test-id';
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'test-key';
  process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.com';
  _resetCosMediaCacheForTest();
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://cos.example.com/')) return new Response('x', { status: 200 });
    posts++;
    endpoint = url;
    body = JSON.parse(String(init?.body));
    if (responseMode === 'error') return Response.json({ error: { message: 'failed Bearer gateway-key' } }, { status: 400 });
    if (responseMode === 'no-url') return Response.json({ data: [] });
    return Response.json(url.endsWith('/images/generations')
      ? { data: [{ url: 'https://cdn.example.com/output.jpg?signature=secret' }], usage: { generated_images: 1 } }
      : { id: 'task-1', status: 'queued' });
  }) as typeof fetch;
  for (const model of ['nano-banana-3.0', 'nano-banana-3.1']) {
    await submitGatewayTaskImage({ ...request, model }, 'gateway-key', 'http://127.0.0.1:4000');
    assert.equal(endpoint, 'http://127.0.0.1:4000/v1/videos');
    assert.deepEqual(body.OutputConfig, { Resolution: '4K', AspectRatio: '16:9' });
    assert.equal(body.response_format, 'jpeg');
    assert.equal(body.size, '3840x2160');
    const urls = body.images as string[];
    assert.equal(urls.length, 2);
    assert.notEqual(urls[0], urls[1]);
    assert.ok(urls.every(url => url.startsWith('https://cos.example.com/')));
    assert.deepEqual(imageNames(urls), expectedImageNames, `${model}: 图1必须是底图的内容，图2必须是参考图的内容`);
    assert.match(String(body.prompt), /图1.*原图/);
  }
  const inputOrder = body.images;
  const result = await submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image', size: '2560x1440' }, 'gateway-key', 'http://127.0.0.1:4000');
  assert.equal(endpoint, 'http://127.0.0.1:4000/v1/images/generations');
  assert.deepEqual(body.image, inputOrder, '方舟 image 必须仍是底图在前、参考图在后');
  assert.deepEqual(imageNames(body.image), expectedImageNames, 'Seedream 图1/图2需匹配实际文件内容');
  assert.equal(body.images, undefined);
  assert.equal(body.size, '2K');
  assert.match(String(body.prompt), /输出画幅为16:9，清晰度为2K/);
  assert.equal(body.response_format, 'url');
  assert.equal(body.n, 1);
  assert.equal(body.quality, undefined);
  assert.equal(result.taskId, undefined);
  assert.ok(result.immediateImageUrl);
  assert.doesNotMatch(JSON.stringify(result.rawResponse), /signature|secret|gateway-key/);

  await submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image', size: '1280x720' }, 'gateway-key', 'http://127.0.0.1:4000');
  assert.equal(body.size, '1K');
  assert.match(String(body.prompt), /输出画幅为16:9，清晰度为1K/);

  // Existing storyboard jobs use their explicit image-number prompt with no prefix.
  const storyboardPrompt = '图1是待编辑分镜图。图2是场景参考图。构图和机位景别严格参考图1。';
  for (const model of ['nano-banana-3.0', 'nano-banana-3.1', 'doubao-seedream-5-0-pro-image']) {
    await submitGatewayTaskImage({ ...request, model, prompt: storyboardPrompt, referenceGuidanceMode: 'none' },
      'gateway-key', 'http://127.0.0.1:4000');
    assert.deepEqual(imageNames(model === 'doubao-seedream-5-0-pro-image' ? body.image : body.images), expectedImageNames);
    if (model === 'doubao-seedream-5-0-pro-image') assert.ok(String(body.prompt).startsWith(`${storyboardPrompt}\n输出画幅`));
    else assert.equal(body.prompt, storyboardPrompt, 'Banana 不得改写分镜提示词或颠倒图号');
  }

  // Synchronous generation must report elapsed time before its response arrives,
  // without issuing extra billed requests; both success and error stop the timer.
  const normalFetch = globalThis.fetch;
  for (const status of [200, 500]) {
    const progress: string[] = [];
    let reply!: (response: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      if (!String(input).endsWith('/images/generations')) return normalFetch(input, init);
      calls++;
      return new Promise<Response>(resolve => { reply = resolve; signalStarted(); });
    }) as typeof fetch;
    mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100000 });
    try {
      const pending = submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image' },
        'gateway-key', 'http://127.0.0.1:4000', { onProgress: (message: string) => progress.push(message) });
      await started;
      mock.timers.tick(5000);
      assert.ok(progress.some(message => /等待.*5.*秒/.test(message)), '返回前应显示已等待 5 秒');
      mock.timers.tick(5000);
      assert.ok(progress.some(message => /等待.*10.*秒/.test(message)), '等待计时应持续更新');
      reply(status === 200 ? Response.json({ data: [{ url: 'https://cdn.example.com/output.jpg' }] })
        : Response.json({ error: { message: 'upstream failed' } }, { status }));
      if (status === 200) {
        await pending;
        assert.ok(progress.some(message => /返回.*10.*秒/.test(message)), '完成时记录请求耗时');
      } else {
        await assert.rejects(pending, /500/);
      }
      const count = progress.length;
      mock.timers.tick(10000);
      assert.equal(progress.length, count, '请求结束后必须清理等待计时器');
      assert.equal(calls, 1, '等待提示不能重新发送生成请求');
    } finally {
      mock.timers.reset();
      globalThis.fetch = normalFetch;
    }
  }

  // Exercise the actual waiting request: it must survive 120s and stop at the
  // configured deadline. Fake timers keep this deterministic and cost-free.
  for (const timeoutMs of [undefined, 240_000]) {
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let requestSignal!: AbortSignal;
    let calls = 0;
    let settled = false;
    globalThis.fetch = (async (input, init) => {
      if (!String(input).endsWith('/images/generations')) return normalFetch(input, init);
      calls++;
      requestSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
        signalStarted();
      });
    }) as typeof fetch;
    mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
    try {
      const pending = submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image' },
        'gateway-key', 'http://127.0.0.1:4000', { timeoutMs });
      const rejected = assert.rejects(pending, { name: 'TimeoutError' }).then(() => { settled = true; });
      await started;
      mock.timers.tick(120_000);
      await Promise.resolve();
      assert.equal(requestSignal.aborted, false, '120 秒不能再提前中断 Seedream');
      assert.equal(settled, false);
      mock.timers.tick((timeoutMs ?? 600_000) - 120_000 - 1);
      assert.equal(requestSignal.aborted, false, '必须等到完整的项目超时时间');
      mock.timers.tick(1);
      await rejected;
      assert.equal(calls, 1, '等待不能额外发起生成请求');
    } finally {
      mock.timers.reset();
      globalThis.fetch = normalFetch;
    }
  }

  // Extending the deadline must not make queue cancellation wait ten minutes.
  const controller = new AbortController();
  let requestStarted!: () => void;
  const requestReady = new Promise<void>(resolve => { requestStarted = resolve; });
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith('/images/generations')) return normalFetch(input, init);
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      requestStarted();
    });
  }) as typeof fetch;
  try {
    const pending = submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image' },
      'gateway-key', 'http://127.0.0.1:4000', { signal: controller.signal, timeoutMs: 600_000 });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await requestReady;
    controller.abort();
    await rejected;
  } finally {
    globalThis.fetch = normalFetch;
  }
  const queueSource = fs.readFileSync(new URL('../lib/queue.ts', import.meta.url), 'utf8');
  assert.match(queueSource, /onProgress: logInfo, timeoutMs, signal: reqAbort.signal/, '队列必须传入项目超时和取消信号');

  responseMode = 'error';
  await assert.rejects(submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image' }, 'gateway-key', 'http://127.0.0.1:4000'), e => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /400/);
    assert.doesNotMatch(e.message, /gateway-key/);
    return true;
  });
  responseMode = 'no-url';
  await assert.rejects(submitGatewayTaskImage({ ...request, model: 'doubao-seedream-5-0-pro-image' }, 'gateway-key', 'http://127.0.0.1:4000'), /未返回图片 URL/);
  const before = posts;
  await assert.rejects(submitGatewayTaskImage({ ...request, referenceImagePaths: Array(14).fill(ref) }, 'gateway-key', 'http://127.0.0.1:4000'), /14 张/);
  delete process.env.CREATIVE_STUDIO_COS_SECRET_KEY;
  _resetCosMediaCacheForTest();
  await assert.rejects(submitGatewayTaskImage(request, 'gateway-key', 'http://127.0.0.1:4000'), /COS/);
  assert.equal(posts, before, '参考图门禁失败必须在提交前结束');
} finally {
  globalThis.fetch = originalFetch;
  envNames.forEach((name, i) => { if (oldEnv[i] === undefined) delete process.env[name]; else process.env[name] = oldEnv[i]; });
  _resetCosMediaCacheForTest();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('company image adapter tests passed');
