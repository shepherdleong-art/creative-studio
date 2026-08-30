import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CORE_DB_MIGRATIONS } from '../lib/db-migrations.ts';

const db = new Database(':memory:');

db.exec(`
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'gpt-image-2',
    type TEXT NOT NULL DEFAULT 'openai-compatible',
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE video_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrlEnv TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL,
    modelEnv TEXT NOT NULL,
    defaultModel TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    defaultDurationSec INTEGER NOT NULL DEFAULT 5
  );

  CREATE TABLE script_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'gemini',
    model TEXT NOT NULL,
    inputSnapshot TEXT NOT NULL,
    outputJson TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negativePrompt TEXT DEFAULT '',
    size TEXT NOT NULL DEFAULT '1024x1024',
    quality TEXT NOT NULL DEFAULT 'standard',
    concurrency INTEGER NOT NULL DEFAULT 3,
    videoConcurrency INTEGER NOT NULL DEFAULT 10,
    maxAttempts INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'draft'
  );

  CREATE TABLE shots (
    id TEXT PRIMARY KEY,
    shotSetId TEXT NOT NULL
  );

  CREATE TABLE shot_sets (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sceneReferenceId TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    sourceImageId TEXT
  );

  CREATE TABLE jobs (
    id TEXT PRIMARY KEY
  );

  INSERT INTO jobs (id) VALUES ('legacy-image-job');

  INSERT INTO video_jobs (id, sourceImageId)
  VALUES ('legacy-video-job', 'legacy-image');

  INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES ('image-provider', 'Image Provider', 'https://old.image', 'IMAGE_API_KEY', '', 'gpt-image-2', 'openai-compatible', 1);

  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec)
  VALUES ('video-provider', 'Video Provider', 'jimeng', 'VIDEO_BASE_URL', 'VIDEO_API_KEY', 'VIDEO_MODEL', 'jimeng-2', 1, 5);

  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec)
  VALUES ('jimeng-2', '即梦 1.5 (Seedance)', 'jimeng', 'JIMENG_VIDEO_BASE_URL', 'JIMENG_VIDEO_API_KEY', 'JIMENG_VIDEO_MODEL', 'doubao-seedance-1-5', 1, 5);

  INSERT INTO script_providers (id, name)
  VALUES ('script-provider', 'Script Provider');

  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson)
  VALUES ('legacy-script', 'legacy-project', 'gemini', 'legacy-model', '{}', '{}');

  INSERT INTO shot_sets (id, projectId, name)
  VALUES ('legacy-set', 'legacy-project', '历史分镜组');

  CREATE TABLE video_prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    prompt TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'camera_motion',
    isBuiltin INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO video_prompt_templates (id, name, prompt, isBuiltin)
  VALUES ('legacy-template', '历史模板', '以当前图片为首帧，推进。不要添加文字。', 1);
`);

for (const sql of CORE_DB_MIGRATIONS) {
  try {
    db.exec(sql);
  } catch {
    // Match production migration behavior for columns/tables that do not exist in this old schema.
  }
}

assert.ok(
  CORE_DB_MIGRATIONS.includes(
    `CREATE TRIGGER IF NOT EXISTS projects_default_workflow_type AFTER INSERT ON projects WHEN NEW.workflowType = 'legacy_batch_edit' BEGIN UPDATE projects SET workflowType = 'complex_product' WHERE id = NEW.id; END`,
  ),
  'the workflow default trigger must remain in the append-only core migration stream',
);
assert.equal(
  CORE_DB_MIGRATIONS.at(-1),
  `ALTER TABLE video_jobs ADD COLUMN rejectReason TEXT`,
  'new core migrations must be appended without rewriting published entries',
);
assert.equal(
  CORE_DB_MIGRATIONS.at(-2),
  `ALTER TABLE video_jobs ADD COLUMN rejectedAt TEXT`,
  'the previous rejection migration must keep its position',
);
assert.equal(
  CORE_DB_MIGRATIONS.at(-3),
  `ALTER TABLE projects ADD COLUMN lastOpenedAt TEXT`,
  'the last-opened migration must remain before the rejection migrations',
);
assert.equal(
  CORE_DB_MIGRATIONS.at(-4),
  `ALTER TABLE script_drafts ADD COLUMN generationDurationMs INTEGER`,
  'the previously published tail migration must keep its position',
);
// 老库里已有的模板必须自动入池，否则升级后一键随机填充会突然填不出东西。
const legacyTemplate = db.prepare(
  `SELECT inRandomPool FROM video_prompt_templates WHERE id = 'legacy-template'`,
).get() as { inRandomPool?: number } | undefined;
assert.equal(legacyTemplate?.inRandomPool, 1, '历史运镜模板升级后应默认参与随机填充');
assert.ok(
  CORE_DB_MIGRATIONS.includes(`ALTER TABLE video_jobs ADD COLUMN tailImageId TEXT`),
  'the tail-frame migration must remain in the append-only core migration stream',
);
const workflowTrigger = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'projects_default_workflow_type'`).get() as { name?: string } | undefined;
assert.equal(workflowTrigger?.name, 'projects_default_workflow_type', 'new projects must not default back to legacy workflow');
const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
assert.ok(
  projectColumns.some((column) => column.name === 'videoConcurrency'),
  'projects.videoConcurrency should be added when migrating older installed databases',
);
assert.ok(
  projectColumns.some((column) => column.name === 'exportDirName'),
  'projects.exportDirName should be added when migrating older installed databases',
);
const videoJobColumns = db.prepare(`PRAGMA table_info(video_jobs)`).all() as Array<{ name: string }>;
assert.ok(
  videoJobColumns.some((column) => column.name === 'tailImageId'),
  'video_jobs.tailImageId should be added when migrating older installed databases',
);
const multiShotColumn = videoJobColumns.find((column) => column.name === 'multiShot') as
  | { name: string; type?: string; notnull?: number; dflt_value?: string | null }
  | undefined;
assert.equal(multiShotColumn?.type, 'INTEGER', 'video_jobs.multiShot must be an INTEGER column');
assert.equal(multiShotColumn?.notnull, 0, 'video_jobs.multiShot must remain nullable');
assert.equal(multiShotColumn?.dflt_value, null, 'video_jobs.multiShot must not have a default');
assert.deepEqual(
  db.prepare(`SELECT multiShot FROM video_jobs WHERE id = 'legacy-video-job'`).get(),
  { multiShot: null },
  '历史 video_jobs 行升级后必须保持 multiShot 为 NULL',
);
const usageSnapshotColumn = videoJobColumns.find((column) => column.name === 'usageSnapshotJson') as
  | { name: string; type?: string; notnull?: number; dflt_value?: string | null }
  | undefined;
assert.equal(usageSnapshotColumn?.type, 'TEXT', 'video_jobs.usageSnapshotJson must be TEXT');
assert.equal(usageSnapshotColumn?.notnull, 0, 'video_jobs.usageSnapshotJson must remain nullable');
assert.equal(usageSnapshotColumn?.dflt_value, null, 'video_jobs.usageSnapshotJson must not have a default');
const jobColumns = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
const jobUsageSnapshotColumn = jobColumns.find((column) => column.name === 'usageSnapshotJson') as
  | { name: string; type?: string; notnull?: number; dflt_value?: string | null }
  | undefined;
assert.equal(jobUsageSnapshotColumn?.type, 'TEXT', 'jobs.usageSnapshotJson must be TEXT');
assert.equal(jobUsageSnapshotColumn?.notnull, 0, 'jobs.usageSnapshotJson must remain nullable');
assert.equal(jobUsageSnapshotColumn?.dflt_value, null, 'jobs.usageSnapshotJson must not have a default');
assert.deepEqual(
  db.prepare(`SELECT usageSnapshotJson FROM jobs WHERE id = 'legacy-image-job'`).get(),
  { usageSnapshotJson: null },
  '历史 jobs 行升级后必须保持 usageSnapshotJson 为 NULL',
);
assert.deepEqual(
  db.prepare(`SELECT usageSnapshotJson FROM video_jobs WHERE id = 'legacy-video-job'`).get(),
  { usageSnapshotJson: null },
  '历史 video_jobs 行升级后必须保持 usageSnapshotJson 为 NULL',
);
for (const table of ['providers', 'video_providers', 'script_providers']) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  assert.equal(
    columns.some((column) => column.name === 'usageSnapshotJson'),
    false,
    `${table} must not gain a usage snapshot column`,
  );
}
const shotIndexes = db.prepare(`PRAGMA index_list(shots)`).all() as Array<{ name: string }>;
assert.ok(
  shotIndexes.some((index) => index.name === 'idx_shots_shotset'),
  'the shots lookup index belongs to the core migration stream',
);
const dbSource = fs.readFileSync(path.join(process.cwd(), 'lib/db.ts'), 'utf8');
assert.ok(
  dbSource.indexOf('CREATE TABLE IF NOT EXISTS shots') < dbSource.indexOf('for (const sql of CORE_DB_MIGRATIONS)'),
  'fresh databases must create shots before applying its appended index migration',
);

const columns = db.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>;
assert.ok(
  columns.some((column) => column.name === 'defaultCostPerImage'),
  'providers.defaultCostPerImage should be added when migrating older installed databases',
);

db.prepare(`
  UPDATE providers
  SET name = ?, baseUrl = ?, apiKey = ?, model = ?, type = ?, enabled = ?, defaultCostPerImage = ?
  WHERE id = ?
`).run('Image Provider', 'https://new.image', 'db-image-key', 'gpt-image-2', 'openai-compatible', 1, 0.25, 'image-provider');

db.prepare(`
  UPDATE video_providers
  SET name = ?, type = ?, baseUrl = ?, defaultModel = ?, enabled = ?, defaultDurationSec = ?, apiKey = ?, accessKey = ?, secretKey = ?
  WHERE id = ?
`).run('Video Provider', 'jimeng', 'https://new.video', 'jimeng-2', 1, 5, 'db-video-key', '', '', 'video-provider');

assert.deepEqual(
  db.prepare(`SELECT name, defaultModel FROM video_providers WHERE id = 'jimeng-2'`).get(),
  { name: '即梦 1.5 Pro (Seedance)', defaultModel: 'doubao-seedance-1-5-pro-251215' },
);

db.prepare(`
  UPDATE script_providers
  SET name = ?, type = ?, apiStyle = ?, baseUrl = ?, model = ?, enabled = ?, maxTokens = ?, apiKey = ?
  WHERE id = ?
`).run('Script Provider', 'openai-compatible', 'openai-compatible', 'https://new.script', 'script-model', 1, 8192, 'db-script-key', 'script-provider');

const scriptProviderColumns = db.prepare(`PRAGMA table_info(script_providers)`).all() as Array<{ name: string }>;
assert.ok(
  scriptProviderColumns.some((column) => column.name === 'supportsVision'),
  'script_providers.supportsVision should be added when migrating older installed databases',
);
const scriptDraftColumns = db.prepare(`PRAGMA table_info(script_drafts)`).all() as Array<{ name: string }>;
assert.ok(
  scriptDraftColumns.some((column) => column.name === 'generationDurationMs'),
  'script_drafts.generationDurationMs should be added when migrating older installed databases',
);
assert.deepEqual(
  db.prepare(`SELECT generationDurationMs FROM script_drafts WHERE id = 'legacy-script'`).get(),
  { generationDurationMs: null },
  '历史脚本草稿升级后必须保持 generationDurationMs 为 NULL',
);
assert.deepEqual(
  db.prepare(`SELECT supportsVision FROM script_providers WHERE id = 'script-provider'`).get(),
  { supportsVision: 0 },
  'existing script_providers rows default supportsVision to 0 after migration',
);
assert.deepEqual(
  db.prepare(`SELECT executionScope FROM script_providers WHERE id = 'script-provider'`).get(),
  { executionScope: 'external' },
  '旧供应商迁移后必须默认保持直连，不能被公司运行环境故障影响',
);
db.prepare(`UPDATE script_providers SET executionScope = 'company' WHERE id = 'script-provider'`).run();
assert.deepEqual(
  db.prepare(`SELECT executionScope FROM script_providers WHERE id = 'script-provider'`).get(),
  { executionScope: 'company' },
  '公司供应商作用域必须显式持久化',
);
db.prepare(`UPDATE script_providers SET supportsVision = 1 WHERE id = 'script-provider'`).run();
assert.deepEqual(
  db.prepare(`SELECT supportsVision FROM script_providers WHERE id = 'script-provider'`).get(),
  { supportsVision: 1 },
  'supportsVision should accept and persist an explicit opt-in',
);

// ── shot_sets.kind:新增列、历史数据回填、CHECK 生效、迁移幂等 ──
const shotSetColumns = db.prepare(`PRAGMA table_info(shot_sets)`).all() as Array<{ name: string }>;
assert.ok(
  shotSetColumns.some((column) => column.name === 'kind'),
  'shot_sets.kind should be added when migrating older installed databases',
);

const legacySet = db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('legacy-set') as
  | { kind: string }
  | undefined;
assert.equal(legacySet?.kind, 'storyboard', '历史分镜组必须回填成 storyboard,不能是 NULL');

assert.throws(
  () => db.prepare(
    `INSERT INTO shot_sets (id, projectId, name, kind) VALUES ('bogus-set', 'legacy-project', 'x', 'bogus')`,
  ).run(),
  /CHECK constraint failed/,
  'shot_sets.kind 必须被 CHECK 挡住非法值',
);
db.prepare(
  `INSERT INTO shot_sets (id, projectId, name, kind) VALUES ('free-set', 'legacy-project', '自由素材', 'free')`,
).run();

// 生产环境每次启动都会整条重跑迁移流,必须幂等且不改动已有数据。
for (const sql of CORE_DB_MIGRATIONS) {
  try { db.exec(sql); } catch { /* Match production migration behavior. */ }
}
assert.equal(
  (db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('legacy-set') as { kind: string }).kind,
  'storyboard',
  '重复执行迁移不得改变已有 shot_sets 数据',
);
assert.equal(
  (db.prepare(`SELECT kind FROM shot_sets WHERE id = ?`).get('free-set') as { kind: string }).kind,
  'free',
  '重复执行迁移不得改变自由工位数据',
);

db.close();
console.log('db-migrations tests passed');
