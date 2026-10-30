import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { SubmitReferenceVideoRequest } from '../lib/video-providers/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-queue-reference-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];

const { getDb, closeDb } = await import('../lib/db.ts');
const queue = await import('../lib/video-queue.ts');
const providers = await import('../lib/video-providers/index.ts');
const tailTransport = await import('../lib/company-gateway-tail-frame.ts');
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
function job(input: {
  id: string; projectId: string; providerId: string; model: string; resolution?: string;
  status?: string; providerTaskId?: string;
}) {
  db.prepare(`INSERT INTO video_jobs
    (id, projectId, sourceImageId, providerId, model, prompt, durationSec, generationMode, aspectRatio, resolution, status, maxAttempts)
    VALUES (?, ?, ?, ?, ?, 'reference prompt', 5, 'reference-to-video', '16:9', ?, ?, 1)`)
    .run(input.id, input.projectId, `poster-${input.projectId}`, input.providerId, input.model, input.resolution ?? '1080p', input.status ?? 'pending');
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

  console.log('video queue reference tests passed');
} finally {
  globalThis.fetch = originalFetch;
  tailTransport._setCompanyTailFrameRuntimeInspectorForTest(null);
  for (const key of Object.keys(process.env)) if (key.startsWith('CREATIVE_STUDIO_COS_')) delete process.env[key];
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
