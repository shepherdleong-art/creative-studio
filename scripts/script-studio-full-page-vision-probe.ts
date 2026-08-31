import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ScriptStudioCompleteJson } from '../lib/script-studio/llm-contract.ts';

// 仅为真机诊断加载本地配置；不输出任何密钥或签名 URL。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const PROJECT_ID = process.env.SCRIPT_STUDIO_PROBE_PROJECT_ID || 'c44a2df5-1ce1-4331-8117-556a63183b6e';
const SOURCE_SET_ID = process.env.SCRIPT_STUDIO_PROBE_SOURCE_SET_ID || '6061443a-487c-4b2b-beab-e93764670ced';

const [{ completeJson, getAvailableProviders }, { createVisionExtractor }, { tileSourceImages }, { selectScriptStudioRuntimeProviders }] = await Promise.all([
  import('../lib/script-providers/index.ts'),
  import('../lib/script-studio/adapters/vision-extract.ts'),
  import('../lib/script-studio/tiling.ts'),
  import('../lib/script-studio/provider-selection.ts'),
]);

const providers = selectScriptStudioRuntimeProviders(getAvailableProviders());
const db = new Database(path.resolve('data/workbench.db'), { readonly: true, fileMustExist: true });
const source = db.prepare(`
  SELECT imageAssetIdsJson FROM script_studio_source_sets WHERE id = ? AND projectId = ?
`).get(SOURCE_SET_ID, PROJECT_ID) as { imageAssetIdsJson: string } | undefined;
if (!source) throw new Error('真机探针来源集不存在');
const tiles = await tileSourceImages(db, PROJECT_ID, JSON.parse(source.imageAssetIdsJson) as string[]);
db.close();

const refId = `full-page-vision-probe-${Date.now()}`;
const completeForProvider: ScriptStudioCompleteJson = (request) => completeJson({
  providerId: providers.vision.id,
  ...request,
  usageContext: {
    enabled: true,
    projectId: PROJECT_ID,
    refType: 'script-studio-full-page-probe',
    refId,
  },
} as Parameters<typeof completeJson>[0]);
const extractor = createVisionExtractor(completeForProvider, providers.vision, {
  maxTokens: 8000,
  tileBatchSize: 50,
  concurrency: 1,
  requestTimeoutMs: 120_000,
  maxAttempts: 1,
});

const startedAt = Date.now();
const result = await extractor.extract({
  pages: tiles.pages.map((page) => ({
    pageIndex: page.pageIndex,
    imageAssetId: page.imageAssetId,
    filename: page.filename,
    sourceWidth: page.sourceWidth,
    sourceHeight: page.sourceHeight,
    tiles: page.tiles.map((tile) => ({ mimeType: tile.mimeType, imageBase64: tile.imageBase64 })),
  })),
});
console.log(JSON.stringify({
  refId,
  providerId: providers.vision.id,
  model: providers.vision.model,
  tileCount: tiles.totalTiles,
  elapsedMs: Date.now() - startedAt,
  candidateCount: result.sellingPoints.length,
  batchMetrics: result.batchMetrics,
}, null, 2));
