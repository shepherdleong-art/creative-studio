import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import type { ScriptStudioCompleteJson } from '../lib/script-studio/llm-contract.ts';

// 静默加载 .env.local（COS 密钥等）；不打印密钥。
for (const line of fs.readFileSync(path.resolve('.env.local'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const { completeJson, getProviderMeta } = await import('../lib/script-providers/index.ts');
const { isCosMediaConfigured } = await import('../lib/cos-media.ts');
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { createVisionExtractor } = await import('../lib/script-studio/adapters/vision-extract.ts');
const { createVisionClosedQuestionReprobe } = await import('../lib/script-studio/adapters/reprobe.ts');
const { createScriptGenerator } = await import('../lib/script-studio/generator.ts');
const { createTask, getTask } = await import('../lib/script-studio/tasks.ts');
const { executeScriptStudioTask } = await import('../lib/script-studio/runner.ts');

const { dataRoot } = await import('../lib/data-root.ts');
const PROVIDER_ID = 'a94f6d47-4266-4b06-bbd4-89d273f06dbc';
const OUT_ROOT = path.join(dataRoot(), 'outputs', 'script-studio-real-smoke');
fs.mkdirSync(OUT_ROOT, { recursive: true });
if (!isCosMediaConfigured()) {
  throw new Error('COS 未配置，无法执行公司供应商媒体传输');
}

function imageRows(): Array<{ id: string; filename: string; usage: string; path: string }> {
  const db = new Database(path.join(dataRoot(), 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
  const rows = db.prepare(`
    SELECT id, filename, usage, path FROM image_assets
    WHERE role='input' AND usage IN ('scene_seed','shot_source')
      AND filename LIKE '%沙发%'
    ORDER BY projectId, createdAt DESC
  `).all() as Array<{ id: string; filename: string; usage: string; path: string }>;
  db.close();
  return rows;
}

const candidates = imageRows();
const selected = candidates.filter((row) => row.filename.includes('G564-A-沙发-贝母白'))
  .concat(candidates.filter((row) => row.filename.includes('LH122K3-B1-沙发')))
  .concat(candidates.filter((row) => row.filename.includes('PS691-B-模特图-沙发')))
  .slice(0, 3);
if (selected.length < 3) throw new Error(`预期选择 3 组真实产品图，实际 ${selected.length}`);

const provider = getProviderMeta(PROVIDER_ID);
if (!provider) throw new Error('公司 Luna 供应商不存在');

const taskId = `real-smoke-${Date.now()}`;
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
    refId: taskId,
  },
} as Parameters<typeof completeJson>[0]);

const vision = createVisionExtractor(completeForProvider, {
  id: PROVIDER_ID,
  model: provider.model || 'GPT-5-6-Luna-Standard',
}, { maxTokens: 8000 });
const reprobe = createVisionClosedQuestionReprobe(completeForProvider);
const generator = createScriptGenerator(completeForProvider, {
  id: PROVIDER_ID,
  model: provider.model || 'GPT-5-6-Luna-Standard',
}, { maxTokens: 8000 });

const realRoot = fs.mkdtempSync(path.join('/tmp', 'creative-studio-real-smoke-'));
const db = new Database(path.join(realRoot, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, role TEXT NOT NULL, filename TEXT NOT NULL,
    path TEXT NOT NULL, originalPath TEXT, mimeType TEXT NOT NULL,
    originalWidth INTEGER, originalHeight INTEGER
  );
  INSERT INTO projects (id, name) VALUES ('p-real', '真机实测项目');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(realRoot, 'backups'),
  now: () => new Date(),
});

for (const row of selected) {
  const absolutePath = path.resolve(row.path);
  const meta = await sharp(absolutePath).metadata();
  db.prepare(`
    INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
    VALUES (?, 'p-real', 'input', ?, ?, ?, 'image/jpeg', ?, ?)
  `).run(row.id, row.filename, absolutePath, absolutePath, meta.width || null, meta.height || null);
}

const startedAt = Date.now();
const results: Array<Record<string, unknown>> = [];
for (const row of selected) {
  const sourceSetId = `real-source-${row.id}`;
  db.prepare(`
    INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
    VALUES (?, 'p-real', ?, ?, ?)
  `).run(sourceSetId, `real-${row.id}`, JSON.stringify([row.id]), new Date().toISOString());
  const task = createTask(db, {
    projectId: 'p-real',
    requestKey: `real-smoke-${row.id}-${Date.now()}`,
    mode: 'first_extraction',
    sourceSetId,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '真实场景、克制表达' },
    requestedCount: 1,
  });
  const result = await executeScriptStudioTask({
    db,
    projectId: 'p-real',
    taskId: task.task.id,
    sourceSetId,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '真实场景、克制表达' },
    visionExtractor: vision,
    reprobe,
    generator,
    now: () => new Date(),
  });
  const finalTask = getTask(db, 'p-real', task.task.id);
  results.push({
    sampleId: row.id,
    filename: row.filename,
    taskId: task.task.id,
    status: finalTask?.status,
    resultStatus: result.status,
    succeededCount: result.succeededCount,
    failedCount: result.failedCount,
    scriptIds: result.scriptIds,
    errorCode: finalTask?.errorCode,
    errorMessage: finalTask?.errorMessage,
  });
}

const summary = {
  providerId: PROVIDER_ID,
  providerModel: provider.model,
  sampleCount: selected.length,
  samples: selected.map((row) => ({ id: row.id, filename: row.filename, usage: row.usage })),
  results,
  elapsedMs: Date.now() - startedAt,
  outputRoot: OUT_ROOT,
};
fs.writeFileSync(path.join(OUT_ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
db.close();
console.log(JSON.stringify(summary, null, 2));
console.log('script-studio real smoke completed');
