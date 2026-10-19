import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cosSign,
  isCosMediaConfigured,
  tryUploadToCosAndSign,
  tryUploadBufferToCosAndSign,
  _resetCosMediaCacheForTest,
} from '../lib/cos-media.ts';

const COS_ENV_KEYS = [
  'CREATIVE_STUDIO_COS_SECRET_ID',
  'CREATIVE_STUDIO_COS_SECRET_KEY',
  'CREATIVE_STUDIO_COS_DOMAIN',
  'CREATIVE_STUDIO_COS_SIGN_HOST',
  'CREATIVE_STUDIO_COS_PREFIX',
  'CREATIVE_STUDIO_COS_URL_TTL_SEC',
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-media-'));
const imageContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const imagePath = path.join(tmpDir, '参考 图.jpg');
fs.writeFileSync(imagePath, imageContent);
const expectedHash = crypto.createHash('sha256').update(imageContent).digest('hex');

function setCosEnv() {
  process.env.CREATIVE_STUDIO_COS_SECRET_ID = 'test-secret-id';
  process.env.CREATIVE_STUDIO_COS_SECRET_KEY = 'test-secret-key';
  process.env.CREATIVE_STUDIO_COS_DOMAIN = 'cos.example.com';
}

function clearCosEnv() {
  for (const key of COS_ENV_KEYS) delete process.env[key];
}

type CapturedRequest = { method: string; url: string; headers: Headers; body: Buffer | null };

// ── 单元测试（mock fetch）───────────────────────────────────────────────

const captured: CapturedRequest[] = [];
let existsCheckStatus = 404;
let putStatus = 200;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const body = init?.body ? Buffer.from(init.body as Buffer) : null;
  captured.push({
    method: init?.method || 'GET',
    url: String(input),
    headers: new Headers(init?.headers),
    body,
  });
  // 查重请求：GET + Range: bytes=0-0（代替 HEAD，见 cos-media.ts 注释）
  if ((init?.method || 'GET') === 'GET' && new Headers(init?.headers).get('range') === 'bytes=0-0') {
    return new Response(null, { status: existsCheckStatus });
  }
  if (init?.method === 'PUT') return new Response(null, { status: putStatus });
  return new Response(null, { status: 500 });
}) as typeof fetch;

try {
  // 未配置：返回 null 且不发起任何请求
  clearCosEnv();
  _resetCosMediaCacheForTest();
  assert.equal(isCosMediaConfigured(), false);
  assert.equal(await tryUploadToCosAndSign(imagePath), null);
  assert.equal(captured.length, 0);

  // 签名确定性：参数顺序与 header 大小写不影响结果；签名为 40 位 hex
  const signInput = {
    method: 'PUT',
    pathname: '/ref-images/x.jpg',
    params: { b: '2', a: '1' },
    headers: { Host: 'COS.example.com', 'Content-Type': 'image/jpeg' },
    secretId: 'id',
    secretKey: 'key',
    startTs: 1_700_000_000,
    endTs: 1_700_086_400,
  };
  const signA = cosSign(signInput);
  const signB = cosSign({
    ...signInput,
    params: { a: '1', b: '2' },
    headers: { 'content-type': 'image/jpeg', host: 'COS.example.com' },
  });
  assert.match(signA.signature, /^[0-9a-f]{40}$/);
  assert.equal(signA.signature, signB.signature);
  assert.equal(signA.keyTime, '1700000000;1700086400');
  assert.equal(signA.paramList, 'a;b');
  assert.equal(signA.headerList, 'content-type;host');

  // 查重 404（对象不存在）→ PUT 上传并返回 24h 预签名 URL
  setCosEnv();
  _resetCosMediaCacheForTest();
  existsCheckStatus = 404;
  putStatus = 200;
  captured.length = 0;

  const signedUrl = await tryUploadToCosAndSign(imagePath);
  assert.ok(signedUrl, 'signed url should be returned');
  const expectedPath = `/ref-images/${expectedHash}.jpg`;
  assert.ok(signedUrl.startsWith(`https://cos.example.com${expectedPath}?`), signedUrl);
  assert.match(signedUrl, /q-sign-algorithm=sha1/);
  assert.match(signedUrl, /q-ak=test-secret-id/);
  assert.match(signedUrl, /q-signature=[0-9a-f]{40}/);
  const signTime = /q-sign-time=(\d+);(\d+)/.exec(signedUrl);
  assert.ok(signTime, 'q-sign-time present');
  assert.equal(Number(signTime[2]) - Number(signTime[1]), 86_400);

  assert.equal(captured.length, 2);
  const [existsReq, putReq] = captured;
  assert.equal(existsReq.method, 'GET');
  assert.equal(existsReq.headers.get('range'), 'bytes=0-0');
  assert.equal(existsReq.url, `https://cos.example.com${expectedPath}`);
  assert.match(existsReq.headers.get('authorization') || '', /q-sign-algorithm=sha1/);
  assert.match(existsReq.headers.get('authorization') || '', /q-ak=test-secret-id/);
  assert.equal(putReq.method, 'PUT');
  assert.ok(putReq.body?.equals(imageContent), 'PUT body should be the file bytes');
  assert.equal(putReq.headers.get('content-type'), 'image/jpeg');
  assert.match(putReq.headers.get('authorization') || '', /q-header-list=content-type%3Bhost|q-header-list=content-type;host/);

  // 自定义 TTL 生效
  process.env.CREATIVE_STUDIO_COS_URL_TTL_SEC = '3600';
  _resetCosMediaCacheForTest();
  captured.length = 0;
  existsCheckStatus = 200; // 对象已存在 → 不上传
  const ttlUrl = await tryUploadToCosAndSign(imagePath);
  assert.ok(ttlUrl);
  const ttlSignTime = /q-sign-time=(\d+);(\d+)/.exec(ttlUrl);
  assert.ok(ttlSignTime);
  assert.equal(Number(ttlSignTime[2]) - Number(ttlSignTime[1]), 3_600);
  assert.equal(captured.length, 1, 'only exists-check, no PUT');
  assert.equal(captured[0].method, 'GET');
  delete process.env.CREATIVE_STUDIO_COS_URL_TTL_SEC;

  // SIGN_HOST：URL 仍走 CDN 域名，但签名按源站 host 计算（CDN 回源改写 Host 的场景）
  process.env.CREATIVE_STUDIO_COS_SIGN_HOST = 'origin.example.com';
  _resetCosMediaCacheForTest();
  captured.length = 0;
  existsCheckStatus = 200;
  const signHostUrl = await tryUploadToCosAndSign(imagePath);
  assert.ok(signHostUrl);
  assert.ok(signHostUrl.startsWith(`https://cos.example.com${expectedPath}?`), signHostUrl);
  const shTime = /q-sign-time=(\d+);(\d+)/.exec(signHostUrl);
  const shSig = /q-signature=([0-9a-f]{40})/.exec(signHostUrl);
  assert.ok(shTime && shSig);
  const expectedSign = cosSign({
    method: 'get',
    pathname: expectedPath,
    params: {},
    headers: { host: 'origin.example.com' },
    secretId: 'test-secret-id',
    secretKey: 'test-secret-key',
    startTs: Number(shTime[1]),
    endTs: Number(shTime[2]),
  });
  assert.equal(shSig[1], expectedSign.signature);
  delete process.env.CREATIVE_STUDIO_COS_SIGN_HOST;

  // 内存缓存：同文件第二次调用零请求
  _resetCosMediaCacheForTest();
  captured.length = 0;
  existsCheckStatus = 200;
  await tryUploadToCosAndSign(imagePath); // 查重一次，写缓存
  captured.length = 0;
  const cachedUrl = await tryUploadToCosAndSign(imagePath);
  assert.ok(cachedUrl);
  assert.equal(captured.length, 0, 'cache hit should skip all requests');

  // 对象已存在时返回的 URL 与 PUT 路径同样带签名参数
  assert.match(cachedUrl, /q-signature=[0-9a-f]{40}/);

  // PUT 403 → 中文错误提示密钥/权限，不含签名串
  _resetCosMediaCacheForTest();
  captured.length = 0;
  existsCheckStatus = 404;
  putStatus = 403;
  let putError: Error | null = null;
  try {
    await tryUploadToCosAndSign(imagePath);
  } catch (error) {
    putError = error as Error;
  }
  assert.ok(putError, 'PUT 403 should throw');
  assert.match(putError.message, /HTTP 403/);
  assert.match(putError.message, /密钥|权限/);
  assert.doesNotMatch(putError.message, /q-signature|test-secret-key/);

  // 查重 403 → 同样抛中文错误
  _resetCosMediaCacheForTest();
  existsCheckStatus = 403;
  let headError: Error | null = null;
  try {
    await tryUploadToCosAndSign(imagePath);
  } catch (error) {
    headError = error as Error;
  }
  assert.ok(headError, 'exists-check 403 should throw');
  assert.match(headError.message, /HTTP 403/);

  // buffer 上传：未配置 COS → null 且零请求
  clearCosEnv();
  _resetCosMediaCacheForTest();
  captured.length = 0;
  const pngContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
  assert.equal(await tryUploadBufferToCosAndSign(pngContent, 'image/png'), null);
  assert.equal(captured.length, 0);

  // buffer 上传：按 MIME 推断扩展名，内容指纹与文件版本同一去重空间
  setCosEnv();
  _resetCosMediaCacheForTest();
  captured.length = 0;
  existsCheckStatus = 404;
  putStatus = 200;
  const bufferUrl = await tryUploadBufferToCosAndSign(pngContent, 'image/png');
  assert.ok(bufferUrl);
  const expectedPngHash = crypto.createHash('sha256').update(pngContent).digest('hex');
  assert.ok(bufferUrl.startsWith(`https://cos.example.com/ref-images/${expectedPngHash}.png?`), bufferUrl);
  assert.equal(captured.length, 2);
  assert.equal(captured[1].method, 'PUT');
  assert.ok(captured[1].body?.equals(pngContent), 'PUT body should be the buffer bytes');
  assert.equal(captured[1].headers.get('content-type'), 'image/png');

  // buffer 上传：未知 MIME 回退 .jpg 扩展名
  _resetCosMediaCacheForTest();
  captured.length = 0;
  const fallbackUrl = await tryUploadBufferToCosAndSign(pngContent, 'application/octet-stream');
  assert.ok(fallbackUrl);
  assert.ok(fallbackUrl.startsWith(`https://cos.example.com/ref-images/${expectedPngHash}.jpg?`), fallbackUrl);

  console.log('cos-media unit tests passed');
} finally {
  globalThis.fetch = originalFetch;
  clearCosEnv();
  _resetCosMediaCacheForTest();
}

// ── 可选真机回归：COS_LIVE_TEST=1 且配好真实密钥时跑真实往返 ─────────────
// 直接 `COS_LIVE_TEST=1 node scripts/cos-media.test.ts`；
// env 缺失时自动读仓库根 .env.local（简易 KEY=VALUE 解析，供本地手动验证用）。

function loadEnvLocalIfMissing() {
  const envPath = path.join(import.meta.dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (process.env.COS_LIVE_TEST === '1') {
  loadEnvLocalIfMissing();
  if (!isCosMediaConfigured()) {
    console.log('COS_LIVE_TEST=1 但未配置 CREATIVE_STUDIO_COS_*，跳过真机回归');
  } else {
    const liveContent = crypto.randomBytes(64 * 1024);
    const livePath = path.join(tmpDir, 'live-check.jpg');
    fs.writeFileSync(livePath, liveContent);
    try {
      const url = await tryUploadToCosAndSign(livePath);
      assert.ok(url, 'live signed url');
      const res = await originalFetch(url);
      assert.equal(res.status, 200, `live GET should succeed, got ${res.status}`);
      const downloaded = Buffer.from(await res.arrayBuffer());
      assert.ok(downloaded.equals(liveContent), 'live round-trip bytes should match');
      console.log('cos-media live round-trip passed');
    } finally {
      clearCosEnv();
    }
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
