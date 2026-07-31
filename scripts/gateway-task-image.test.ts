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
  // poll：模拟网关未配服务器地址时返回 localhost 的 content URL
  pollCount += 1;
  return new Response(JSON.stringify({
    id: 'task-1',
    status: 'completed',
    progress: 100,
    metadata: { url: 'http://localhost:3000/v1/videos/task-1/content' },
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
  assert.equal(capturedBody?.size, '1024x1024');
  // prompt 带参考图引导前缀
  assert.ok(String(capturedBody?.prompt).includes('最后一张是需要编辑的原图'));
  assert.ok(String(capturedBody?.prompt).includes('把产品放到大理石台面上'));
  // images：参考图在前，底图在最后（未配置公共地址时回退 data URL）
  const images = capturedBody?.images as string[];
  assert.equal(images.length, 2);
  assert.ok(images[0].startsWith('data:image/png;base64,'));
  assert.ok(images[1].startsWith('data:image/png;base64,'));

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
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('gateway-task-image adapter tests passed');
