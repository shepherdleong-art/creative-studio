import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { SubmitReferenceVideoRequest, SubmitVideoRequest } from '../lib/video-providers/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-queue-reference-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];

const { getDb, closeDb } = await import('../lib/db.ts');
const queue = await import('../lib/video-queue.ts');
const providers = await import('../lib/video-providers/index.ts');
const tailTransport = await import('../lib/company-gateway-tail-frame.ts');
const { openaiVideoAdapter } = await import('../lib/video-providers/openai-video.ts');
const cos = await import('../lib/cos-media.ts');
const db = getDb();
db.prepare("INSERT INTO providers (id, name, baseUrl) VALUES ('images', 'images', 'http://local')").run();
const posterPath = path.join(root, 'poster.png');
const referencePath = path.join(root, 'reference.png');
const referenceOtherPath = path.join(root, 'reference-other.png');
await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#111111' } }).png().toFile(posterPath);
await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#336699' } }).png().toFile(referencePath);
await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#993366' } }).png().toFile(referenceOtherPath);

function project(id: string) {
  db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES (?, ?, 'images', 'model', '')").run(id, id);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES (?, ?, 'input', 'poster.png', ?)`)
    .run(`poster-${id}`, id, posterPath);
}
function provider(id: string, type: string, model: string, baseUrl = 'http://fake.example') {
  db.prepare(`INSERT INTO video_providers
    (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, enabled)
    VALUES (?, ?, ?, ?, '', '', '', ?, 'key', 1)`).run(id, id, type, model, baseUrl);
}
function referenceAsset(id: string, projectId: string, kind: 'image' | 'video' | 'audio', filePath = referencePath) {
  const mimeType = kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  db.prepare(`INSERT INTO video_reference_assets
    (id, projectId, kind, filename, path, mimeType, byteSize, durationSec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, projectId, kind, `${id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`, filePath, mimeType, fs.existsSync(filePath) ? fs.statSync(filePath).size : 100, kind === 'image' ? null : 4);
}
function defaultResolutionFor(model: string): string {
  if (model === 'minimax-h3') return '2K';
  if (model === 'wan-3.0') return '1080P';
  return '1080p';
}
function job(input: {
  id: string; projectId: string; providerId: string; model: string; resolution?: string;
  status?: string; providerTaskId?: string; postAsImage?: string;
}) {
  if (input.postAsImage) {
    db.prepare('UPDATE image_assets SET path = ? WHERE id = ?').run(input.postAsImage, `poster-${input.projectId}`);
  }
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, sourceImageId, providerId, model, prompt, durationSec, generationMode, aspectRatio, resolution, status, maxAttempts)
    VALUES (?, ?, ?, ?, ?, 'reference prompt', 5, 'reference-to-video', '16:9', ?, ?, 1)`)
    .run(input.id, input.projectId, `poster-${input.projectId}`, input.providerId, input.model,
      input.resolution ?? defaultResolutionFor(input.model), input.status ?? 'pending');
  if (input.providerTaskId) db.prepare('UPDATE video_jobs SET providerTaskId = ? WHERE id = ?').run(input.providerTaskId, input.id);
}
function link(jobId: string, orderIndex: number, assetId: string) {
  db.prepare('INSERT INTO video_job_references (jobId, orderIndex, assetId) VALUES (?, ?, ?)').run(jobId, orderIndex, assetId);
}
const failedAdapter = (onReference: (request: SubmitReferenceVideoRequest) => { providerTaskId: string; rawResponse: unknown }) => ({
  submit: async () => { throw new Error('reference job must not use frame submit'); },
  submitReference: async (request: SubmitReferenceVideoRequest) => onReference(request),
  poll: async () => ({ status: 'failed' as const, errorMessage: 'test complete', rawResponse: null }),
  minimumPollingTimeoutMs: () => 0,
});

const originalFetch = globalThis.fetch;
try {
  project('direct');
  provider('direct-20', 'jimeng', 'doubao-seedance-2-0-260128');
  provider('direct-25', 'jimeng', 'doubao-seedance-2-5-260628');
  referenceAsset('direct-first', 'direct', 'image');
  referenceAsset('direct-second', 'direct', 'image', referenceOtherPath);
  job({ id: 'direct-job-20', projectId: 'direct', providerId: 'direct-20', model: 'doubao-seedance-2-0-260128' });
  link('direct-job-20', 0, 'direct-second');
  link('direct-job-20', 1, 'direct-first');
  job({ id: 'direct-job-25', projectId: 'direct', providerId: 'direct-25', model: 'doubao-seedance-2-5-260628' });
  link('direct-job-25', 0, 'direct-first');
  const directRequests = new Map<string, SubmitReferenceVideoRequest>();
  providers.registerTestVideoAdapter('jimeng', failedAdapter((request) => {
    directRequests.set(request.model, request);
    return { providerTaskId: `remote-${request.model}`, rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'direct', concurrency: 2, timeoutMs: 60_000 });
  const direct20 = directRequests.get('doubao-seedance-2-0-260128')!;
  const direct25 = directRequests.get('doubao-seedance-2-5-260628')!;
  assert.equal(directRequests.size, 2);
  assert.equal(direct20.omniReferenceTaskType, undefined, '2.0 不得发送 omni 字段');
  assert.equal(direct25.omniReferenceTaskType, 'reference', '2.5 必须显式 reference');
  assert.ok(direct20.references[0].url.startsWith('data:image/png;base64,'));
  assert.notEqual(direct20.references[0].url, direct20.references[1].url, '素材顺序不能因相同 MIME 丢失');
  assert.ok(!('sourceImagePath' in direct20) && !('tailImagePath' in direct20), '海报与尾帧不得进入参考请求');
  assert.equal(direct20.aspectRatio, '16:9');
  assert.equal(direct20.resolution, '1080p');
  const decodedFirst = Buffer.from(direct20.references[0].url.split(',')[1], 'base64');
  const decodedSecond = Buffer.from(direct20.references[1].url.split(',')[1], 'base64');
  assert.ok(decodedFirst.equals(fs.readFileSync(referenceOtherPath)), '第一份素材必须保持请求顺序');
  assert.ok(decodedSecond.equals(fs.readFileSync(referencePath)), '第二份素材必须保持请求顺序');
  assert.ok(!decodedFirst.equals(fs.readFileSync(posterPath)), '海报字节不得混入参考素材');

  project('implicit');
  provider('implicit-20', 'jimeng', 'doubao-seedance-2-0-260128');
  job({ id: 'implicit-job', projectId: 'implicit', providerId: 'implicit-20', model: 'doubao-seedance-2-0-260128' });
  let implicitRequest: SubmitReferenceVideoRequest | undefined;
  providers.registerTestVideoAdapter('jimeng', failedAdapter((request) => {
    implicitRequest = request;
    return { providerTaskId: 'remote-implicit', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'implicit', concurrency: 1, timeoutMs: 60_000 });
  assert.ok(implicitRequest);
  assert.equal(implicitRequest.references.length, 1);
  assert.ok(Buffer.from(implicitRequest.references[0].url.split(',')[1], 'base64').equals(fs.readFileSync(posterPath)), '默认参考必须直接交付冻结来源图的原始字节');

  project('company');
  provider('company-25', 'openai-video', 'doubao-seedance-2-5-260628', 'http://127.0.0.1:4000');
  referenceAsset('company-image', 'company', 'image');
  job({ id: 'company-job', projectId: 'company', providerId: 'company-25', model: 'doubao-seedance-2-5-260628' });
  link('company-job', 0, 'company-image');
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'test-id';
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'test-key';
  process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.test';
  cos._resetCosMediaCacheForTest();
  tailTransport._setCompanyTailFrameRuntimeInspectorForTest(async () => ({
    status: 'ready', reason: '', proxyAvailable: true, cosConfigured: true, startedAt: null,
  }));
  let companyRequest: SubmitReferenceVideoRequest | undefined;
  let cosCalls = 0;
  globalThis.fetch = (async () => {
    cosCalls += 1;
    return new Response(null, { status: 206 });
  }) as typeof fetch;
  providers.registerTestVideoAdapter('openai-video', failedAdapter((request) => {
    companyRequest = request;
    return { providerTaskId: 'remote-company', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'company', concurrency: 1, timeoutMs: 60_000 });
  assert.ok(cosCalls > 0, '公司参考必须实际经过模拟 COS 交付');
  assert.ok(companyRequest);
  assert.ok(companyRequest.references.every((reference) => reference.url.startsWith('https://cos.example.test/')));
  assert.ok(companyRequest.references.every((reference) => reference.url.includes('q-sign-algorithm=sha1')));
  assert.equal(companyRequest.omniReferenceTaskType, 'reference');
  assert.ok(!('sourceImagePath' in companyRequest) && !('tailImagePath' in companyRequest));

  project('company-delivery-failure');
  provider('company-failure-25', 'openai-video', 'doubao-seedance-2-5-260628', 'http://127.0.0.1:4000');
  referenceAsset('company-failure-image', 'company-delivery-failure', 'image');
  job({
    id: 'company-failure-job', projectId: 'company-delivery-failure', providerId: 'company-failure-25',
    model: 'doubao-seedance-2-5-260628',
  });
  link('company-failure-job', 0, 'company-failure-image');
  cos._resetCosMediaCacheForTest();
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  let companyFailureSubmitCalls = 0;
  providers.registerTestVideoAdapter('openai-video', failedAdapter(() => {
    companyFailureSubmitCalls += 1;
    return { providerTaskId: 'must-not-exist', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'company-delivery-failure', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(companyFailureSubmitCalls, 0, '公司 COS 交付失败必须零生成 POST');

  project('delivery-failure');
  provider('failure-20', 'jimeng', 'doubao-seedance-2-0-260128');
  referenceAsset('failure-video', 'delivery-failure', 'video');
  job({ id: 'failure-job', projectId: 'delivery-failure', providerId: 'failure-20', model: 'doubao-seedance-2-0-260128' });
  link('failure-job', 0, 'failure-video');
  for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
  let failureSubmitCalls = 0;
  providers.registerTestVideoAdapter('jimeng', failedAdapter(() => {
    failureSubmitCalls += 1;
    return { providerTaskId: 'must-not-exist', rawResponse: null };
  }));
  globalThis.fetch = (async () => { throw new Error('delivery failure must not reach upstream'); }) as typeof fetch;
  await queue.runVideoQueue({ projectId: 'delivery-failure', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(failureSubmitCalls, 0, '视频无 COS 交付必须在 submitReference 前失败');
  assert.equal((db.prepare('SELECT providerTaskId FROM video_jobs WHERE id = ?').get('failure-job') as { providerTaskId: string | null }).providerTaskId, null);

  project('resume');
  provider('resume-20', 'jimeng', 'doubao-seedance-2-0-260128');
  referenceAsset('resume-image', 'resume', 'image', path.join(root, 'missing-reference.png'));
  job({
    id: 'resume-job', projectId: 'resume', providerId: 'resume-20', model: 'doubao-seedance-2-0-260128',
    status: 'needs_check', providerTaskId: 'already-remote',
  });
  link('resume-job', 0, 'resume-image');
  let resumeSubmitCalls = 0;
  providers.registerTestVideoAdapter('jimeng', failedAdapter(() => {
    resumeSubmitCalls += 1;
    return { providerTaskId: 'must-not-resubmit', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'resume', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(resumeSubmitCalls, 0, '已有 taskId 不得重新交付素材或重新 submit');
  assert.equal((db.prepare('SELECT providerTaskId FROM video_jobs WHERE id = ?').get('resume-job') as { providerTaskId: string }).providerTaskId, 'already-remote');

  // ══ 规格 §7：执行交付阶段也必须覆盖 11 MiB 以上真实图片 ══════════════════
  const MIB = 1024 * 1024;
  /** 真实 sharp 编码的大图（3200x3000 模糊噪声 PNG ≈ 13 MiB），不是短字符串冒充。 */
  async function writeLargePng(filePath: string): Promise<number> {
    const width = 3200;
    const height = 3000;
    await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
      .blur(5)
      .png({ compressionLevel: 6 })
      .toFile(filePath);
    return fs.statSync(filePath).size;
  }

  /**
   * 假 COS：捕获实际上传字节（PUT body），并按内容再解码、量字节与尺寸。
   * 不是只断言参数被传入——票里明确要求实际字节验证。
   */
  type CapturedPut = { body: Buffer; mimeType: string };
  function installFakeCos(status = 200) {
    const puts = new Map<string, CapturedPut>();
    let cosCalls = 0;
    let cosPosts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/videos')) { cosPosts += 1; return new Response(null, { status: 500 }); }
      cosCalls += 1;
      if (init?.method === 'PUT') {
        const body = Buffer.from(init.body as Buffer);
        puts.set(url.split('?')[0], { body, mimeType: new Headers(init.headers).get('content-type') || '' });
        if (status !== 200) return new Response('cos unavailable', { status });
        return new Response(null, { status: 200 });
      }
      if (new Headers(init?.headers).get('range') === 'bytes=0-0') return new Response(null, { status: 404 });
      return new Response(null, { status });
    }) as typeof fetch;
    return {
      puts,
      get cosCalls() { return cosCalls; },
      get cosPosts() { return cosPosts; },
      /** 按对象键内容再解码测量；找不到就返回 null。 */
      async measureUploadedBySha(sha: string) {
        for (const [url, put] of puts) {
          const actualSha = crypto.createHash('sha256').update(put.body).digest('hex');
          if (actualSha !== sha) continue;
          const metadata = await sharp(put.body).metadata();
          return {
            url,
            body: put.body,
            mimeType: put.mimeType,
            byteSize: put.body.byteLength,
            format: metadata.format,
            width: metadata.width ?? 0,
            height: metadata.height ?? 0,
          };
        }
        return null;
      },
    };
  }

  function companyRuntime() {
    process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'test-id';
    process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'test-key';
    process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.test';
    cos._resetCosMediaCacheForTest();
    tailTransport._setCompanyTailFrameRuntimeInspectorForTest(async () => ({
      status: 'ready', reason: '', proxyAvailable: true, cosConfigured: true, startedAt: null,
    }));
  }
  function clearCos() {
    for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
    cos._resetCosMediaCacheForTest();
  }

  // ── H3 单图参考：11 MiB 以上原图必须在队列阶段交付合规副本 ──
  const largePath = path.join(root, 'large-ref.png');
  const largeBytes = await writeLargePng(largePath);
  assert.ok(largeBytes > 11 * MIB, `队列测试素材必须 >11 MiB，实得 ${largeBytes}`);
  const largeHash = crypto.createHash('sha256').update(fs.readFileSync(largePath)).digest('hex');
  const largeMtime = fs.statSync(largePath).mtimeMs;

  project('large-h3');
  provider('large-h3-provider', 'openai-video', 'minimax-h3', 'http://127.0.0.1:4000');
  job({ id: 'large-h3-job', projectId: 'large-h3', providerId: 'large-h3-provider', model: 'minimax-h3', postAsImage: largePath });
  companyRuntime();
  let fake = installFakeCos();
  let h3Request: SubmitReferenceVideoRequest | undefined;
  providers.registerTestVideoAdapter('openai-video', failedAdapter((request) => {
    h3Request = request;
    return { providerTaskId: 'remote-h3', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'large-h3', concurrency: 1, timeoutMs: 60_000 });
  assert.ok(h3Request, 'H3 参考任务必须走到提交');
  assert.ok(fake.cosCalls > 0, '公司参考必须实际经过假 COS');
  assert.equal(fake.cosPosts, 0, '假 COS 拒绝生成 POST，这里只验证上传字节');
  // 捕获到的每个 PUT 都必须能在下游预算内（体积 + 尺寸 + 格式）。
  const uploadedSizes = [...fake.puts.values()].map((put) => put.body.byteLength);
  assert.ok(uploadedSizes.length > 0, '必须捕获到实际上传字节');
  const uploaded = fake.puts.values().next().value as CapturedPut | undefined;
  assert.ok(uploaded, '必须有实际上传的字节');
  assert.ok(uploaded.body.byteLength <= 10 * MIB, `上传字节必须 ≤10 MiB，实得 ${uploaded.body.byteLength}`);
  const uploadedMeta = await sharp(uploaded.body).metadata();
  assert.ok(['jpeg', 'png'].includes(String(uploadedMeta.format)), `上传格式必须是 jpeg/png，实得 ${uploadedMeta.format}`);
  assert.ok((uploadedMeta.width ?? 0) <= 4096 && (uploadedMeta.height ?? 0) <= 4096, '上传尺寸必须在预算内');
  assert.match(uploaded.mimeType, /^image\/(jpeg|png)$/, 'COS content-type 必须与真实格式一致');
  // 原图身份不变
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(largePath)).digest('hex'), largeHash, '队列阶段不得修改原图');
  assert.equal(fs.statSync(largePath).mtimeMs, largeMtime, '队列阶段不得重写原图');

  // ── 首尾帧：两张都超预算时分别按角色预算处理，角色与顺序正确 ──
  // 这里走**真实 openai-video 适配器**：尾帧的 COS 上传只发生在适配器内部，
  // 只有真适配器才能证明「实际上传字节」是验过的副本。
  const largeTailPath = path.join(root, 'large-tail.png');
  const largeTailBytes = await writeLargePng(largeTailPath);
  assert.ok(largeTailBytes > 11 * MIB);
  const largeTailHash = crypto.createHash('sha256').update(fs.readFileSync(largeTailPath)).digest('hex');
  project('large-frames');
  provider('large-frames-provider', 'openai-video', 'wan-3.0', 'http://127.0.0.1:4000');
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, usage)
    VALUES ('large-tail-asset', 'large-frames', 'input', 'tail.png', ?, 'video_tail_frame')`).run(largeTailPath);
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, sourceImageId, tailImageId, providerId, model, prompt, durationSec, generationMode, aspectRatio, resolution, status, maxAttempts)
    VALUES ('large-frames-job', 'large-frames', 'poster-large-frames', 'large-tail-asset', 'large-frames-provider', 'wan-3.0',
      '首尾帧', 4, 'image-to-video', NULL, NULL, 'pending', 1)`).run();
  companyRuntime();
  // 用真适配器：PUT 捕获上传字节，POST /v1/videos 只做记录并返回假 task id。
  const framePuts: CapturedPut[] = [];
  const framePosts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/videos') && init?.method === 'POST') {
      framePosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: 'remote-frames', status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (init?.method === 'PUT') {
      framePuts.push({
        body: Buffer.from(init.body as Buffer),
        mimeType: new Headers(init.headers).get('content-type') || '',
      });
      return new Response(null, { status: 200 });
    }
    if (new Headers(init?.headers).get('range') === 'bytes=0-0') return new Response(null, { status: 404 });
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  providers.registerTestVideoAdapter('openai-video', {
    ...openaiVideoAdapter,
    poll: async () => ({ status: 'failed' as const, errorMessage: 'test complete', rawResponse: null }),
    minimumPollingTimeoutMs: () => 0,
  });
  await queue.runVideoQueue({ projectId: 'large-frames', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(framePuts.length, 2, '首帧与尾帧必须各上传一次（角色分别处理）');
  assert.equal(framePosts.length, 1, '首尾帧任务只发一次生成 POST');
  const frameMetrics = await Promise.all(framePuts.map(async (put) => {
    const metadata = await sharp(put.body).metadata();
    return { byteSize: put.body.byteLength, mimeType: put.mimeType, format: metadata.format };
  }));
  for (const metric of frameMetrics) {
    assert.ok(['jpeg', 'png'].includes(String(metric.format)), `首尾帧上传格式必须受支持，实得 ${metric.format}`);
    assert.match(metric.mimeType, /^image\/(jpeg|png)$/);
  }
  // 尾帧预算更严：两条上传里必然有一条 ≤ 尾帧预算（另一条是首帧）。
  assert.ok(frameMetrics.some((metric) => metric.byteSize <= 4_800_000), '尾帧上传必须在尾帧预算内');
  assert.ok(frameMetrics.every((metric) => metric.byteSize <= 10 * MIB), '两帧都不得超过首帧硬限');
  // 角色与顺序：FileInfos 首个是 FirstFrame、第二个是 LastFrame，且 URL 不同。
  const fileInfos = framePosts[0].FileInfos as Array<{ Usage: string; Url: string }>;
  assert.deepEqual(fileInfos.map((frame) => frame.Usage), ['FirstFrame', 'LastFrame'], '首尾帧角色与顺序必须正确');
  assert.notEqual(fileInfos[0].Url, fileInfos[1].Url, '首帧与尾帧不得指向同一份交付物');
  for (const frame of fileInfos) assert.match(frame.Url, /^https:\/\/cos\.example\.test\//);
  // 原图身份不变
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(largePath)).digest('hex'), largeHash, '首帧原图不得被修改');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(largeTailPath)).digest('hex'), largeTailHash, '尾帧原图不得被修改');
  globalThis.fetch = originalFetch;

  // ── 压缩/COS 失败时必须零生成 POST ──
  project('large-cos-failure');
  provider('large-cos-failure-provider', 'openai-video', 'minimax-h3', 'http://127.0.0.1:4000');
  job({ id: 'large-cos-failure-job', projectId: 'large-cos-failure', providerId: 'large-cos-failure-provider', model: 'minimax-h3', postAsImage: largePath });
  companyRuntime();
  fake = installFakeCos(500);
  let cosFailureSubmitCalls = 0;
  providers.registerTestVideoAdapter('openai-video', failedAdapter(() => {
    cosFailureSubmitCalls += 1;
    return { providerTaskId: 'must-not-exist', rawResponse: null };
  }));
  await queue.runVideoQueue({ projectId: 'large-cos-failure', concurrency: 1, timeoutMs: 60_000 });
  assert.equal(cosFailureSubmitCalls, 0, 'COS 失败必须零生成 POST');
  assert.equal(fake.cosPosts, 0, 'COS 失败不得触发生成 POST');
  clearCos();

  // ── 取消：零生成 POST ──
  project('large-cancel');
  provider('large-cancel-provider', 'openai-video', 'minimax-h3', 'http://127.0.0.1:4000');
  job({ id: 'large-cancel-job', projectId: 'large-cancel', providerId: 'large-cancel-provider', model: 'minimax-h3', postAsImage: largePath });
  companyRuntime();
  fake = installFakeCos();
  let cancelSubmitCalls = 0;
  providers.registerTestVideoAdapter('openai-video', failedAdapter(() => {
    cancelSubmitCalls += 1;
    return { providerTaskId: 'must-not-exist', rawResponse: null };
  }));
  const running = queue.runVideoQueue({ projectId: 'large-cancel', concurrency: 1, timeoutMs: 60_000 });
  queue.cancelVideoQueue('large-cancel');
  await running;
  assert.equal(cancelSubmitCalls, 0, '取消必须零生成 POST');
  assert.equal(fake.cosPosts, 0, '取消不得触发生成 POST');
  clearCos();

  // ── 预处理无法达标（本机保护上限）：零生成 POST，任务不提交 ──
  project('large-unreachable');
  provider('large-unreachable-provider', 'openai-video', 'minimax-h3', 'http://127.0.0.1:4000');
  job({ id: 'large-unreachable-job', projectId: 'large-unreachable', providerId: 'large-unreachable-provider', model: 'minimax-h3', postAsImage: largePath });
  companyRuntime();
  fake = installFakeCos();
  let unreachableSubmitCalls = 0;
  providers.registerTestVideoAdapter('openai-video', failedAdapter(() => {
    unreachableSubmitCalls += 1;
    return { providerTaskId: 'must-not-exist', rawResponse: null };
  }));
  process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES = '1024';
  try {
    await queue.runVideoQueue({ projectId: 'large-unreachable', concurrency: 1, timeoutMs: 60_000 });
  } finally {
    delete process.env.CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES;
  }
  assert.equal(unreachableSubmitCalls, 0, '预处理拒绝必须零生成 POST');
  assert.equal(fake.cosPosts, 0);
  clearCos();

  // ══ 规格 §6：老任务按**冻结字段**执行，不在 worker 重新推导当前 UI 规则 ══
  // 老 reference 任务重试仍是 Reference；老 image 任务仍是首尾帧；
  // 两者都只读任务冻结的 sourceImageId，不读分镜最新图。
  project('frozen-modes');
  provider('frozen-h3', 'openai-video', 'minimax-h3', 'http://127.0.0.1:4000');
  const latestPath = path.join(root, 'frozen-latest.png');
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#22aa55' } }).png().toFile(latestPath);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path)
    VALUES ('frozen-latest-image', 'frozen-modes', 'input', 'latest.png', ?)`).run(latestPath);
  db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path, usage)
    VALUES ('frozen-tail', 'frozen-modes', 'input', 'frozen-tail.png', ?, 'video_tail_frame')`).run(referenceOtherPath);
  db.prepare("INSERT INTO shot_sets (id, projectId, name) VALUES ('frozen-set', 'frozen-modes', 'frozen')").run();
  db.prepare("INSERT INTO shots (id, shotSetId, sourceImageId, indexNum, latestGeneratedImageId) VALUES ('frozen-shot', 'frozen-set', 'poster-frozen-modes', 1, 'frozen-latest-image')").run();
  // 老 reference 任务（冻结 generationMode=reference-to-video，无显式参考列表）
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, prompt, durationSec, generationMode, aspectRatio, resolution, status, maxAttempts)
    VALUES ('frozen-reference-job', 'frozen-modes', 'frozen-set', 'frozen-shot', 'poster-frozen-modes', 'frozen-h3', 'minimax-h3',
      '老参考任务', 5, 'reference-to-video', '16:9', '2K', 'pending', 1)`).run();
  // 老 image 任务（冻结 generationMode=image-to-video，冻结 tailImageId）
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model, prompt, durationSec, generationMode, status, maxAttempts)
    VALUES ('frozen-image-job', 'frozen-modes', 'frozen-set', 'frozen-shot', 'poster-frozen-modes', 'frozen-tail', 'frozen-h3', 'minimax-h3',
      '老首尾帧任务', 4, 'image-to-video', 'pending', 1)`).run();
  companyRuntime();
  const frozenReferenceRequests: SubmitReferenceVideoRequest[] = [];
  const frozenFrameRequests: SubmitVideoRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/videos') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: `remote-${frozenFrameRequests.length}`, status: 'queued' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 200 });
    if (new Headers(init?.headers).get('range') === 'bytes=0-0') return new Response(null, { status: 404 });
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  // 用真适配器：只有真适配器才能证明 FileInfos 角色来自冻结模式，而不是我们伪造的请求。
  providers.registerTestVideoAdapter('openai-video', {
    ...openaiVideoAdapter,
    poll: async () => ({ status: 'failed' as const, errorMessage: 'test complete', rawResponse: null }),
    minimumPollingTimeoutMs: () => 0,
  });
  const originalSubmitReference = openaiVideoAdapter.submitReference!;
  const originalSubmit = openaiVideoAdapter.submit;
  providers.registerTestVideoAdapter('openai-video', {
    ...openaiVideoAdapter,
    submitReference: async (request, apiKey, baseUrl, signal) => {
      frozenReferenceRequests.push(request);
      return originalSubmitReference(request, apiKey, baseUrl, signal);
    },
    submit: async (request, apiKey, baseUrl, signal) => {
      frozenFrameRequests.push(request);
      return originalSubmit(request, apiKey, baseUrl, signal);
    },
    poll: async () => ({ status: 'failed' as const, errorMessage: 'test complete', rawResponse: null }),
    minimumPollingTimeoutMs: () => 0,
  });
  await queue.runVideoQueue({ projectId: 'frozen-modes', concurrency: 2, timeoutMs: 60_000 });
  assert.equal(frozenReferenceRequests.length, 1, '老 reference 任务必须仍走 submitReference');
  assert.equal(frozenFrameRequests.length, 1, '老 image 任务必须仍走首尾帧 submit');
  const frozenReference = frozenReferenceRequests[0];
  assert.ok(!('sourceImagePath' in frozenReference), '参考请求不得携带首帧字段');
  const frozenFrame = frozenFrameRequests[0];
  assert.ok(frozenFrame.tailImagePath, '老首尾帧任务的尾帧路径必须来自冻结的 tailImageId');
  assert.ok(frozenFrame.preparedFrames?.lastFrame, '尾帧必须走严格预算的预处理副本');
  // 冻结来源图：两个任务都必须用 poster（不是最新的 latest 图）
  const frozenPosterBytes = fs.readFileSync(posterPath);
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(frozenFrame.preparedFrames!.firstFrame!.absolutePath)).digest('hex'),
    crypto.createHash('sha256').update(frozenPosterBytes).digest('hex'),
    '首尾帧任务的首帧必须来自任务冻结的 sourceImageId，不得改读最新分镜图',
  );
  for (const request of frozenReferenceRequests) {
    assert.ok(request.references.length > 0, '老参考任务必须有参考素材');
  }
  // 三个老任务都没有被改写成另一种模式
  const frozenModes = db.prepare(`SELECT id, generationMode FROM video_jobs WHERE id LIKE 'frozen-%' ORDER BY id`).all() as Array<{ id: string; generationMode: string }>;
  assert.deepEqual(
    frozenModes,
    [
      { id: 'frozen-image-job', generationMode: 'image-to-video' },
      { id: 'frozen-reference-job', generationMode: 'reference-to-video' },
    ],
    'worker 不得按当前 UI 规则改写历史任务的冻结模式',
  );
  clearCos();
  globalThis.fetch = originalFetch;

  console.log('video queue reference tests passed');
} finally {
  globalThis.fetch = originalFetch;
  tailTransport._setCompanyTailFrameRuntimeInspectorForTest(null);
  for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
