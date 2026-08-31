import fs from 'node:fs';
import path from 'node:path';
import type { ScriptStudioCompleteJson } from '../lib/script-studio/llm-contract.ts';

// 静默加载 .env.local（COS 密钥等）；不打印密钥。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { completeJson } = await import('../lib/script-providers/index.ts');
const { isCosMediaConfigured } = await import('../lib/cos-media.ts');
const { createVisionExtractor } = await import('../lib/script-studio/adapters/vision-extract.ts');

const PROVIDER_ID = 'a94f6d47-4266-4b06-bbd4-89d273f06dbc';
const TILE_DIR = path.resolve('outputs/detail-page-probe/tiles');
const OUT_ROOT = path.resolve('outputs/script-studio-real-smoke');
fs.mkdirSync(OUT_ROOT, { recursive: true });
if (!isCosMediaConfigured()) throw new Error('COS 未配置');

const files = fs.readdirSync(TILE_DIR)
  .filter((name) => /^p1-t\d+\.jpg$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .slice(0, 6);
if (files.length < 5) throw new Error(`探针切片不足：${files.length}`);

const tiles = files.map((name) => ({
  name,
  buffer: fs.readFileSync(path.join(TILE_DIR, name)),
}));
const provider = {
  id: PROVIDER_ID,
  model: 'GPT-5-6-Luna-Standard',
};
const refId = `real-probe-${Date.now()}`;
const completeForProvider: ScriptStudioCompleteJson = (request) => completeJson({
  providerId: PROVIDER_ID,
  systemPrompt: request.systemPrompt,
  userPrompt: request.userPrompt,
  temperature: request.temperature,
  maxTokens: request.maxTokens,
  timeoutMs: request.timeoutMs,
  signal: request.signal,
  images: request.images,
  onTextDelta: request.onTextDelta,
  onReasoningDelta: request.onReasoningDelta,
  usageContext: {
    enabled: true,
    projectId: 'script-studio-real-smoke',
    refType: 'script-studio-real-smoke',
    refId,
  },
} as Parameters<typeof completeJson>[0]);
const vision = createVisionExtractor(completeForProvider, provider, { maxTokens: 8000 });

const startedAt = Date.now();
const result = await vision.extract({
  pages: [{
    pageIndex: 0,
    imageAssetId: 'probe-tile-p1',
    filename: 'p1-tiles',
    sourceWidth: 1024,
    sourceHeight: 1024,
    tiles: tiles.map((tile) => ({ mimeType: 'image/jpeg', imageBase64: tile.buffer.toString('base64') })),
  }],
});
const summary = {
  providerId: PROVIDER_ID,
  model: provider.model,
  tileCount: tiles.length,
  elapsedMs: Date.now() - startedAt,
  productName: result.productName,
  category: result.category,
  brand: result.brand,
  candidateCount: result.sellingPoints.length,
  candidates: result.sellingPoints.map((point) => ({
    title: point.title,
    factText: point.factText,
    pointType: point.pointType,
    evidenceQuote: point.evidenceQuote,
    sourcePageIndex: point.sourcePageIndex,
    tileRefs: point.tileRefs,
    confidence: point.modelConfidence,
    riskLevel: point.riskLevel,
  })),
};
fs.writeFileSync(path.join(OUT_ROOT, 'vision-probe.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
