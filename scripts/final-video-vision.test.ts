import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

const projectRootUrl = new URL('../', import.meta.url);
type ResolveContext = { parentURL?: string };
type NextResolve = (specifier: string, context: ResolveContext) => unknown;
const registerHooks = (nodeModule as unknown as {
  registerHooks(hooks: {
    resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
  }): void;
}).registerHooks;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const candidate = new URL(`${specifier.slice(2)}.ts`, projectRootUrl);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-video-vision-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;

const { getDb } = await import('../lib/db.ts');
const { describeClipImage, describeClipPool } = await import('../lib/final-video/vision.ts');
type ClipPoolItem = import('../lib/final-video/types.ts').ClipPoolItem;

const db = getDb();
const storage = path.join(testRoot, 'storage');
fs.mkdirSync(storage, { recursive: true });

// ── Fixture helpers ──

async function writeSmallPng(name: string, rgb: [number, number, number]): Promise<string> {
  const filePath = path.join(storage, name);
  await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  }).png().toFile(filePath);
  return filePath;
}

/** clip_visual_descriptions.imageAssetId has a FOREIGN KEY into image_assets(id). */
function registerImageAsset(id: string, filePath: string): void {
  db.prepare(`INSERT INTO image_assets (id, role, filename, path) VALUES (?, 'output', ?, ?)`)
    .run(id, path.basename(filePath), filePath);
}

function makeClipPoolItem(input: {
  clipId: string; shotId: string; shotIndex: number; videoPath: string; clipDurationSec: number;
  sourceImageId: string; sourceImagePath: string;
}): ClipPoolItem {
  return {
    ...input,
    visualDescription: '',
    descriptionProviderId: null,
    descriptionModel: null,
  };
}

function configureProvider(id: string, opts: { apiStyle: 'openai-compatible' | 'native-gemini'; supportsVision: boolean; model?: string }): void {
  db.prepare(`UPDATE script_providers SET baseUrl = ?, apiKey = ?, model = ?, apiStyle = ?, enabled = 1, supportsVision = ? WHERE id = ?`)
    .run(`https://${id}.example/api`, `${id}-secret`, opts.model || `${id}-vision-model`, opts.apiStyle, opts.supportsVision ? 1 : 0, id);
}

// ── fetch mock ──

interface MockResponse { ok: boolean; status: number; json?: unknown; text?: string }
type FetchCall = { url: string; body: Record<string, unknown> };

let fetchCalls: FetchCall[] = [];
let concurrentCount = 0;
let maxConcurrent = 0;
let artificialDelayMs = 0;
let responseFor: (url: string, body: Record<string, unknown>) => MockResponse = () => ({
  ok: true,
  status: 200,
  json: { choices: [{ message: { content: '默认描述。' } }] },
});

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  concurrentCount += 1;
  maxConcurrent = Math.max(maxConcurrent, concurrentCount);
  try {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    fetchCalls.push({ url, body });
    if (artificialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, artificialDelayMs));
    const response = responseFor(url, body);
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json,
      text: async () => response.text || '',
    } as Response;
  } finally {
    concurrentCount -= 1;
  }
}) as typeof fetch;

try {
  // ── 1. Happy path: openai-compatible ──
  configureProvider('qwen', { apiStyle: 'openai-compatible', supportsVision: true });
  const smallA = await writeSmallPng('small-a.png', [10, 20, 30]);
  const smallABase64 = fs.readFileSync(smallA).toString('base64');
  registerImageAsset('asset-openai', smallA);
  registerImageAsset('asset-novision', smallA);

  responseFor = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '  一只猫躺在窗台上晒太阳。 ' } }] } });
  fetchCalls = [];
  const openaiResult = await describeClipImage({ imageAssetId: 'asset-openai', imagePath: smallA, providerId: 'qwen' });
  assert.equal(openaiResult.description, '一只猫躺在窗台上晒太阳。');
  assert.equal(openaiResult.model, 'qwen-vision-model');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /qwen\.example\/api\/v1\/chat\/completions$/);
  {
    const body = fetchCalls[0].body as {
      model: string; temperature: number; max_tokens: number; response_format?: unknown;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
    };
    assert.equal(body.model, 'qwen-vision-model');
    assert.equal(body.response_format, undefined, 'vision call must not request json response_format');
    assert.equal(body.temperature, 0.3);
    const content = body.messages[0].content;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text || '', /描述|画面/);
    assert.equal(content[1].type, 'image_url');
    assert.equal(content[1].image_url?.url, `data:image/png;base64,${smallABase64}`);
  }
  assert.deepEqual(
    db.prepare(`SELECT description, providerId, model FROM clip_visual_descriptions WHERE imageAssetId = ?`).get('asset-openai'),
    { description: '一只猫躺在窗台上晒太阳。', providerId: 'qwen', model: 'qwen-vision-model' },
  );

  // ── 2. Happy path: native-gemini ──
  configureProvider('gemini', { apiStyle: 'native-gemini', supportsVision: true });
  const smallB = await writeSmallPng('small-b.png', [40, 50, 60]);
  const smallBBase64 = fs.readFileSync(smallB).toString('base64');
  registerImageAsset('asset-gemini', smallB);

  responseFor = () => ({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: ' 一个杯子放在木桌上。 ' }] } }] } });
  fetchCalls = [];
  const geminiResult = await describeClipImage({ imageAssetId: 'asset-gemini', imagePath: smallB, providerId: 'gemini' });
  assert.equal(geminiResult.description, '一个杯子放在木桌上。');
  assert.equal(geminiResult.model, 'gemini-vision-model');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /gemini\.example\/api\/v1beta\/models\/gemini-vision-model:generateContent\?key=gemini-secret$/);
  {
    const body = fetchCalls[0].body as {
      contents: Array<{ parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>;
      generationConfig: { temperature: number; maxOutputTokens: number };
    };
    assert.match(body.contents[0].parts[0].text || '', /描述|画面/);
    assert.equal(body.contents[0].parts[1].inlineData?.mimeType, 'image/png');
    assert.equal(body.contents[0].parts[1].inlineData?.data, smallBBase64);
    assert.equal(body.generationConfig.temperature, 0.3);
  }
  assert.deepEqual(
    db.prepare(`SELECT description, providerId, model FROM clip_visual_descriptions WHERE imageAssetId = ?`).get('asset-gemini'),
    { description: '一个杯子放在木桌上。', providerId: 'gemini', model: 'gemini-vision-model' },
  );

  // ── 3. Cache hit: second call must not call fetch ──
  fetchCalls = [];
  const cachedResult = await describeClipImage({ imageAssetId: 'asset-openai', imagePath: smallA, providerId: 'qwen' });
  assert.equal(fetchCalls.length, 0, 'cache hit must not call fetch');
  assert.equal(cachedResult.description, '一只猫躺在窗台上晒太阳。');

  // ── 4. force:true bypasses cache and overwrites ──
  responseFor = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '猫已经走开，现在窗台空空如也。' } }] } });
  fetchCalls = [];
  const forcedResult = await describeClipImage({ imageAssetId: 'asset-openai', imagePath: smallA, providerId: 'qwen', force: true });
  assert.equal(fetchCalls.length, 1, 'force=true must re-call the provider');
  assert.equal(forcedResult.description, '猫已经走开，现在窗台空空如也。');
  assert.deepEqual(
    db.prepare(`SELECT description FROM clip_visual_descriptions WHERE imageAssetId = ?`).get('asset-openai'),
    { description: '猫已经走开，现在窗台空空如也。' },
  );

  // ── 5. supportsVision: false throws before any fetch ──
  configureProvider('kimi', { apiStyle: 'openai-compatible', supportsVision: false });
  fetchCalls = [];
  await assert.rejects(
    describeClipImage({ imageAssetId: 'asset-novision', imagePath: smallA, providerId: 'kimi' }),
    /图片理解/,
  );
  assert.equal(fetchCalls.length, 0, 'disabled vision support must not call fetch');

  // ── 6. Large (>4MB) image gets resized before send ──
  const largeImagePath = path.join(storage, 'large.png');
  const rawNoise = randomBytes(3000 * 2000 * 3);
  await sharp(rawNoise, { raw: { width: 3000, height: 2000, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toFile(largeImagePath);
  const largeImageBytes = fs.statSync(largeImagePath).size;
  assert.ok(largeImageBytes > 4 * 1024 * 1024, `fixture must exceed 4MB, got ${largeImageBytes} bytes`);
  registerImageAsset('asset-large', largeImagePath);

  responseFor = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '一张很大的噪点测试图。' } }] } });
  fetchCalls = [];
  await describeClipImage({ imageAssetId: 'asset-large', imagePath: largeImagePath, providerId: 'qwen' });
  assert.equal(fetchCalls.length, 1);
  {
    const body = fetchCalls[0].body as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> };
    const dataUrl = body.messages[0].content[1].image_url?.url || '';
    assert.match(dataUrl, /^data:image\/jpeg;base64,/, 'resized payload must be re-encoded as jpeg');
    const decodedBuffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    assert.ok(
      decodedBuffer.byteLength < largeImageBytes,
      `resized payload (${decodedBuffer.byteLength}) should be smaller than original (${largeImageBytes})`,
    );
    const decodedMeta = await sharp(decodedBuffer).metadata();
    assert.ok(
      (decodedMeta.width || 0) <= 1600 && (decodedMeta.height || 0) <= 1600,
      `resized dimensions ${decodedMeta.width}x${decodedMeta.height} exceed the 1600px cap`,
    );
  }

  // ── 7. Path safety: outside the data root throws before any fetch ──
  const outsidePath = path.join(os.tmpdir(), `outside-vision-${process.pid}.png`);
  fs.writeFileSync(outsidePath, 'irrelevant bytes: rejected before any file/image parsing');
  registerImageAsset('asset-outside', outsidePath);
  try {
    fetchCalls = [];
    await assert.rejects(
      describeClipImage({ imageAssetId: 'asset-outside', imagePath: outsidePath, providerId: 'qwen' }),
      /数据目录/,
    );
    assert.equal(fetchCalls.length, 0, 'path-safety rejection must happen before any fetch call');
  } finally {
    fs.rmSync(outsidePath, { force: true });
  }

  // ── 8. describeClipPool: one clip's image call fails, others still succeed ──
  const poolImageA = await writeSmallPng('pool-a.png', [1, 2, 3]);
  const poolImageB = await writeSmallPng('pool-b.png', [4, 5, 6]);
  const poolImageC = await writeSmallPng('pool-c.png', [7, 8, 9]);
  const poolImageBBase64 = fs.readFileSync(poolImageB).toString('base64');
  registerImageAsset('pool-asset-a', poolImageA);
  registerImageAsset('pool-asset-b', poolImageB);
  registerImageAsset('pool-asset-c', poolImageC);

  responseFor = (_url, body) => {
    const content = (body as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> }).messages[0].content;
    const dataUrl = content[1].image_url?.url || '';
    if (dataUrl.endsWith(poolImageBBase64)) {
      return { ok: false, status: 500, text: 'vision provider exploded' };
    }
    return { ok: true, status: 200, json: { choices: [{ message: { content: `描述：${dataUrl.slice(-8)}` } }] } };
  };

  const poolClips: ClipPoolItem[] = [
    makeClipPoolItem({ clipId: 'clip-a', shotId: 'shot-a', shotIndex: 0, videoPath: '/video/a.mp4', clipDurationSec: 3, sourceImageId: 'pool-asset-a', sourceImagePath: poolImageA }),
    makeClipPoolItem({ clipId: 'clip-b', shotId: 'shot-b', shotIndex: 1, videoPath: '/video/b.mp4', clipDurationSec: 3, sourceImageId: 'pool-asset-b', sourceImagePath: poolImageB }),
    makeClipPoolItem({ clipId: 'clip-c', shotId: 'shot-c', shotIndex: 2, videoPath: '/video/c.mp4', clipDurationSec: 3, sourceImageId: 'pool-asset-c', sourceImagePath: poolImageC }),
  ];

  fetchCalls = [];
  const poolResult = await describeClipPool({ clips: poolClips, providerId: 'qwen' });
  assert.deepEqual(poolResult.clips.map((c) => c.clipId), ['clip-a', 'clip-b', 'clip-c'], 'result must preserve input order');
  assert.notEqual(poolResult.clips[0].visualDescription, '');
  assert.equal(poolResult.clips[0].descriptionProviderId, 'qwen');
  assert.equal(poolResult.clips[0].descriptionModel, 'qwen-vision-model');
  assert.notEqual(poolResult.clips[2].visualDescription, '');
  assert.equal(poolResult.clips[1].visualDescription, '', 'the failing clip must be returned unchanged');
  assert.equal(poolResult.clips[1].descriptionProviderId, null);
  assert.equal(poolResult.clips[1].descriptionModel, null);
  assert.deepEqual(poolResult.failures.map((f) => f.clipId), ['clip-b']);
  assert.match(poolResult.failures[0].message, /500|vision provider exploded/);

  // ── 9. Concurrency: never more than 2 in-flight vision calls ──
  responseFor = () => ({ ok: true, status: 200, json: { choices: [{ message: { content: '并发测试描述。' } }] } });
  artificialDelayMs = 30;
  maxConcurrent = 0;
  const concurrentImagePaths = await Promise.all(
    Array.from({ length: 5 }, (_, i) => writeSmallPng(`concurrent-${i}.png`, [i * 10, i * 20, i * 30])),
  );
  concurrentImagePaths.forEach((imagePath, i) => registerImageAsset(`concurrent-asset-${i}`, imagePath));
  const concurrentClips: ClipPoolItem[] = concurrentImagePaths.map((imagePath, i) => makeClipPoolItem({
    clipId: `concurrent-clip-${i}`,
    shotId: `concurrent-shot-${i}`,
    shotIndex: i,
    videoPath: `/video/concurrent-${i}.mp4`,
    clipDurationSec: 2,
    sourceImageId: `concurrent-asset-${i}`,
    sourceImagePath: imagePath,
  }));

  fetchCalls = [];
  const concurrentResult = await describeClipPool({ clips: concurrentClips, providerId: 'qwen' });
  artificialDelayMs = 0;
  assert.equal(concurrentResult.failures.length, 0);
  assert.equal(fetchCalls.length, 5);
  assert.ok(maxConcurrent <= 2, `max concurrent vision calls observed: ${maxConcurrent} (must be <= 2)`);
  assert.ok(maxConcurrent >= 2, `expected real parallelism (>=2) with 5 clips and 2 workers, observed: ${maxConcurrent}`);

  console.log('final-video-vision tests passed');
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}
