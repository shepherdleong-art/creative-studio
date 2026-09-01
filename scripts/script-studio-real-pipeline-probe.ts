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

const PROVIDER_ID = 'a94f6d47-4266-4b06-bbd4-89d273f06dbc';
const { dataRoot } = await import('../lib/data-root.ts');
const TILE = path.join(dataRoot(), 'outputs', 'detail-page-probe', 'tiles', 'p1-t01.jpg');
const OUT_ROOT = path.join(dataRoot(), 'outputs', 'script-studio-real-smoke');
fs.mkdirSync(OUT_ROOT, { recursive: true });
if (!isCosMediaConfigured()) throw new Error('COS 未配置');
if (!fs.existsSync(TILE)) throw new Error(`缺少真实探针切片：${TILE}`);

const model = getProviderMeta(PROVIDER_ID)?.model || 'GPT-5-6-Luna-Standard';
const refId = `real-pipeline-${Date.now()}`;
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

const vision = createVisionExtractor(completeForProvider, { id: PROVIDER_ID, model }, { maxTokens: 8000 });
const reprobe = createVisionClosedQuestionReprobe(completeForProvider);
const generator = createScriptGenerator(completeForProvider, { id: PROVIDER_ID, model }, { maxTokens: 8000 });
const meta = await sharp(TILE).metadata();

const realRoot = fs.mkdtempSync(path.join('/tmp', 'creative-studio-real-pipeline-'));
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
db.prepare(`
  INSERT INTO image_assets (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight)
  VALUES ('img-real-tile', 'p-real', 'input', 'p1-t01.jpg', ?, ?, 'image/jpeg', ?, ?)
`).run(TILE, TILE, meta.width || null, meta.height || null);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(realRoot, 'backups'),
  now: () => new Date(),
});
const sourceSetId = 'real-source-tile';
db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES (?, 'p-real', 'real-tile-fingerprint', '["img-real-tile"]', ?)
`).run(sourceSetId, new Date().toISOString());

const task = createTask(db, {
  projectId: 'p-real',
  requestKey: `real-pipeline-${Date.now()}`,
  mode: 'first_extraction',
  sourceSetId,
  inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '真实场景、克制表达' },
  requestedCount: 1,
});
const startedAt = Date.now();
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
let reuseResult: Awaited<ReturnType<typeof executeScriptStudioTask>> | null = null;
let reuseTaskId: string | null = null;
if (result.status === 'succeeded') {
  const libraryRevisionId = (db.prepare(`SELECT currentRevisionId FROM script_studio_libraries WHERE projectId='p-real'`).get() as { currentRevisionId: string }).currentRevisionId;
  const reuseTask = createTask(db, {
    projectId: 'p-real',
    requestKey: `real-reuse-${Date.now()}`,
    mode: 'reuse',
    libraryRevisionId,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '复用卖点库，再生成' },
    requestedCount: 1,
  });
  reuseTaskId = reuseTask.task.id;
  reuseResult = await executeScriptStudioTask({
    db,
    projectId: 'p-real',
    taskId: reuseTask.task.id,
    libraryRevisionId,
    inputSnapshot: { targetDurationSec: 15, requestedCount: 1, creativeBrief: '复用卖点库，再生成' },
    visionExtractor: vision,
    reprobe,
    generator,
    now: () => new Date(),
  });
}
const stages = db.prepare(`
  SELECT stage, status, payloadJson, errorCode FROM script_studio_task_stages WHERE taskId = ? ORDER BY seq
`).all(task.task.id);
const summary = {
  providerId: PROVIDER_ID,
  model,
  tile: path.basename(TILE),
  taskId: task.task.id,
  status: finalTask?.status,
  resultStatus: result.status,
  errorCode: finalTask?.errorCode,
  errorMessage: finalTask?.errorMessage,
  succeededCount: result.succeededCount,
  failedCount: result.failedCount,
  scriptIds: result.scriptIds,
  elapsedMs: Date.now() - startedAt,
  stages,
  reuse: reuseResult ? {
    taskId: reuseTaskId,
    status: reuseResult.status,
    errorCode: reuseResult.errorCode,
    errorMessage: reuseResult.errorMessage,
    scriptIds: reuseResult.scriptIds,
  } : null,
  outputRoot: OUT_ROOT,
};
fs.writeFileSync(path.join(OUT_ROOT, 'pipeline-probe.json'), JSON.stringify(summary, null, 2));
db.close();
console.log(JSON.stringify(summary, null, 2));
