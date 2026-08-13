import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  submitGatewayTaskImage,
  pollGatewayTaskImage,
  downloadGatewayTaskImage,
  summarizeGatewayTaskResponse,
} from '../lib/providers/gateway-task-image.ts';
import { _resetCosMediaCacheForTest } from '../lib/cos-media.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-task-image-'));
const inputPath = path.join(tmpDir, 'input.png');
const refPath = path.join(tmpDir, 'ref.png');
fs.writeFileSync(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.writeFileSync(refPath, Buffer.from([0x89, 0x50, 0x4e, 0x48]));

let capturedUrl = '';
let capturedBody: Record<string, unknown> | undefined;
let capturedHeaders: Headers | undefined;
const capturedMethods: string[] = [];
let pollCount = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  capturedUrl = url;
  capturedMethods.push(init?.method || 'GET');
  capturedBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
  capturedHeaders = new Headers(init?.headers);

  if (init?.method === 'POST') {
    return new Response(JSON.stringify({ id: 'task-1', object: 'video', status: 'queued', progress: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url === 'https://llm-gateway.example.com/v1/videos/task-1/content') {
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }
  if (url === 'https://cdn.example.com/x.png') {
    return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
  }
  // 公司网关常见形态：完成态不带产物 URL，调用方应回退 /content 下载（文档 §4.3）
  if (url === 'https://llm-gateway.example.com/v1/videos/task-no-url') {
    return new Response(JSON.stringify({
      id: 'task-no-url',
      status: 'completed',
      progress: 100,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // poll：模拟网关未配服务器地址时返回 localhost 的 content URL；
  // 用 output.url 形态覆盖公司文档 §4.2 的完成响应结构
  pollCount += 1;
  return new Response(JSON.stringify({
    id: 'task-1',
    status: 'completed',
    progress: 100,
    output: { url: 'http://localhost:3000/v1/videos/task-1/content' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

try {
  const summary = summarizeGatewayTaskResponse({
    status: 'failed',
    error: { message: 'failed https://blob.example.com/gateway-key/file?sv=1&sig=sas-secret' },
  }, 'gateway-key');
  assert.match(summary, /https:\/\/blob\.example\.com\/\[REDACTED\]\/file\?\[query redacted\]/);
  assert.doesNotMatch(summary, /gateway-key|sas-secret|(?:^|[?&])sig=/i);

  const submitResult = await submitGatewayTaskImage(
    {
      model: 'image2-medium',
      prompt: '把产品放到大理石台面上',
      inputImagePath: inputPath,
      inputMimeType: 'image/png',
      referenceImagePaths: [refPath],
      referenceMimeTypes: ['image/png'],
      size: '1024x1024',
      quality: 'high',
      referenceGuidanceMode: 'preserve_subject',
    },
    'gateway-key',
    'https://llm-gateway.example.com',
  );

  assert.equal(submitResult.taskId, 'task-1');
  assert.equal(capturedMethods[0], 'POST');
  assert.equal(capturedUrl, 'https://llm-gateway.example.com/v1/videos');
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer gateway-key');
  assert.equal(capturedBody?.model, 'image2-medium');
  // 公司模型：size 吸附到文档白名单（1024x1024 本身是 1K 1:1，原样保留），并补 response_format
  assert.equal(capturedBody?.size, '1024x1024');
  assert.equal(capturedBody?.response_format, 'jpeg');
  // prompt 带参考图引导前缀（底图=图1，参考图=图2）
  assert.ok(String(capturedBody?.prompt).includes('图1是需要编辑的原图'));
  assert.ok(String(capturedBody?.prompt).includes('图2是风格/场景参考图'));
  assert.ok(String(capturedBody?.prompt).includes('把产品放到大理石台面上'));
  // images：底图在前（图1），参考图在后（图2）（未配置公共地址时回退 data URL）
  const images = capturedBody?.images as string[];
  assert.equal(images.length, 2);
  const decodeImage = (dataUrl: string) => Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.deepEqual(decodeImage(images[0]), Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'images[0] 必须是底图');
  assert.deepEqual(decodeImage(images[1]), Buffer.from([0x89, 0x50, 0x4e, 0x48]), 'images[1] 必须是参考图');

  const pollResult = await pollGatewayTaskImage(
    'task-1',
    'gateway-key',
    'https://llm-gateway.example.com/',
    Date.now(),
  );

  assert.equal(pollResult.status, 'succeeded');
  // localhost 结果 URL 被改写到网关 origin
  assert.equal(pollResult.imageUrl, 'https://llm-gateway.example.com/v1/videos/task-1/content');
  assert.ok(pollCount >= 1);

  // 完成态不带产物 URL：回退用原始任务 id 拼 /content 下载地址
  const noUrlPollResult = await pollGatewayTaskImage(
    'task-no-url',
    'gateway-key',
    'https://llm-gateway.example.com/',
    Date.now(),
  );
  assert.equal(noUrlPollResult.status, 'succeeded');
  assert.equal(noUrlPollResult.imageUrl, 'https://llm-gateway.example.com/v1/videos/task-no-url/content');

  // 下载网关自身的 /content 端点：必须带 Bearer 鉴权
  const downloadResult = await downloadGatewayTaskImage(
    pollResult.imageUrl!,
    'https://llm-gateway.example.com',
    'gateway-key'
  );
  assert.equal(downloadResult.ok, true);
  if (downloadResult.ok) {
    assert.deepEqual(Array.from(downloadResult.buffer), [1, 2, 3]);
  }
  assert.equal(capturedHeaders?.get('authorization'), 'Bearer gateway-key');

  // CDN 直链：不带鉴权头
  const cdnDownloadResult = await downloadGatewayTaskImage(
    'https://cdn.example.com/x.png',
    'https://llm-gateway.example.com',
    'gateway-key',
  );
  assert.equal(cdnDownloadResult.ok, true);
  assert.equal(capturedHeaders?.get('authorization'), null);

  // 非公司模型：size 原样透传，不补 response_format
  await submitGatewayTaskImage(
    {
      model: 'nano-banana-2.5',
      prompt: '换背景',
      inputImagePath: inputPath,
      inputMimeType: 'image/png',
      referenceImagePaths: [],
      referenceMimeTypes: [],
      size: '2304x1728',
      quality: 'high',
    },
    'gateway-key',
    'https://llm-gateway.example.com',
  );
  assert.equal(capturedBody?.size, '2304x1728');
  assert.equal(capturedBody?.response_format, undefined);

  // 配置 COS 后：images 使用 COS 预签名 URL（mock 对 HEAD 一律 200，视为对象已存在，跳过 PUT）
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'test-cos-id';
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'test-cos-key';
  process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.com';
  _resetCosMediaCacheForTest();
  await submitGatewayTaskImage(
    {
      model: 'image2-medium',
      prompt: '把产品放到大理石台面上',
      inputImagePath: inputPath,
      inputMimeType: 'image/png',
      referenceImagePaths: [refPath],
      referenceMimeTypes: ['image/png'],
      size: '1024x1024',
      quality: 'high',
    },
    'gateway-key',
    'https://llm-gateway.example.com',
  );
  const cosImages = capturedBody?.images as string[];
  assert.equal(cosImages.length, 2);
  for (const imageRef of cosImages) {
    assert.ok(imageRef.startsWith('https://cos.example.com/ref-images/'), imageRef);
    assert.match(imageRef, /q-sign-algorithm=sha1/);
    assert.match(imageRef, /q-signature=[0-9a-f]{40}/);
  }
  delete process.env.CREATIVE_STUDIO_COS_SECRET_ID;
  delete process.env.CREATIVE_STUDIO_COS_SECRET_KEY;
  delete process.env.CREATIVE_STUDIO_COS_DOMAIN;
  _resetCosMediaCacheForTest();
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.CREATIVE_STUDIO_COS_SECRET_ID;
  delete process.env.CREATIVE_STUDIO_COS_SECRET_KEY;
  delete process.env.CREATIVE_STUDIO_COS_DOMAIN;
  _resetCosMediaCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('gateway-task-image adapter tests passed');
