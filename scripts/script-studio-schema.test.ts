import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady, SCRIPT_STUDIO_MIGRATIONS } from '../lib/script-studio/schema.ts';
import {
  createLibraryRevision,
  getCurrentLibraryRevision,
  getLibraryRevision,
  manualEditLibraryRevision,
} from '../lib/script-studio/libraries.ts';
import {
  addProjectScriptRevision,
  createProjectScript,
  getProjectScript,
  listProjectScripts,
} from '../lib/script-studio/scripts.ts';

function createBaseDatabase(root: string, name = 'workbench.db'): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY,
      projectId TEXT,
      role TEXT NOT NULL,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      originalPath TEXT,
      mimeType TEXT NOT NULL,
      originalWidth INTEGER,
      originalHeight INTEGER
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT '',
      inputSnapshot TEXT NOT NULL DEFAULT '{}',
      outputJson TEXT NOT NULL DEFAULT '{}',
      createdAt TEXT NOT NULL DEFAULT '2026-08-31T00:00:00.000Z',
      generationDurationMs INTEGER
    );
    INSERT INTO projects (id, name) VALUES ('p1', '项目一');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss1', 'p1', '组一', '2026-08-31T00:00:00.000Z');
  `);
  return db;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-schema-'));
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });

const db = createBaseDatabase(root);
const migration = await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:05.000Z'),
});

assert.equal(migration.state, 'ready');
const expectedTables = [
  'script_studio_source_sets',
  'script_studio_libraries',
  'script_studio_library_revisions',
  'script_studio_selling_points',
  'script_studio_tasks',
  'script_studio_task_stages',
  'project_scripts',
  'project_script_revisions',
];
for (const table of expectedTables) {
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table), `缺少 ${table}`);
}

db.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('source-1', 'p1', 'fingerprint-1', '["img-1"]', '2026-08-31T00:00:10.000Z')
`).run();

const library = createLibraryRevision(db, {
  projectId: 'p1',
  sourceSetId: 'source-1',
  sourceFingerprint: 'fingerprint-1',
  productName: '测试床',
  category: '家具',
  sellingPoints: [
    { title: '实木框架', factText: '采用实木框架', pointType: 'material', evidenceQuote: '采用实木框架', sourcePageIndex: 0, tileRefs: ['1'], modelConfidence: 'high', usable: true },
  ],
}, () => new Date('2026-08-31T00:01:00.000Z'));
assert.equal(library.revisionNumber, 1);
assert.equal(getCurrentLibraryRevision(db, 'p1')!.id, library.id);
assert.equal(getLibraryRevision(db, 'p1', library.id)!.sellingPoints.length, 1);

const contentBase = {
  version: 3,
  title: '测试方案',
  coverTitleParts: { primary: '实木床', secondary: '安心睡眠', source: 'model' },
  templateId: 'scene_seeding',
  template: '场景种草',
  templateVersion: 1,
  templateRationale: '测试',
  shotSetId: '',
  targetDurationSec: 15,
  targetNarrationDurationSec: 13,
  contentCharacterCount: 40,
  estimatedNarrationDurationSec: 10,
  durationStatus: 'qualified',
  direction: '生活场景',
  creativeBrief: '',
  libraryRevisionId: library.id,
  sellingPointUsage: [],
  segments: [{ id: 's1', narration: '这是一条测试口播脚本。', subtitle: '这是一条测试口播脚本', sellingPointIdRefs: [], sellingPointRefs: [], visualIntent: '', visualKeywords: [] }],
  fullScript: '这是一条测试口播脚本。',
  fullSubtitle: '这是一条测试口播脚本',
};

const first = createProjectScript(db, 'p1', {
  origin: 'ai_generate',
  libraryRevisionId: library.id,
  templateId: 'scene_seeding',
  templateVersion: 1,
  contentJson: contentBase,
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:02:00.000Z'));
const second = createProjectScript(db, 'p1', {
  origin: 'ai_generate',
  libraryRevisionId: library.id,
  templateId: 'feature_showcase',
  templateVersion: 1,
  contentJson: { ...contentBase, title: '测试方案二' },
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:02:10.000Z'));
assert.equal(listProjectScripts(db, 'p1').scripts.length, 2, '不存在项目级唯一采用脚本约束');

const firstAfterRevision = addProjectScriptRevision(db, 'p1', first.id, {
  origin: 'ai_regenerate',
  libraryRevisionId: library.id,
  contentJson: { ...contentBase, title: '测试方案 V2' },
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:03:00.000Z'));
assert.equal(firstAfterRevision.currentRevision?.revisionNumber, 2);
assert.equal(firstAfterRevision.currentRevision?.id, firstAfterRevision.currentRevisionId);
const unchangedSecond = getProjectScript(db, 'p1', second.id)!;
assert.equal(unchangedSecond.currentRevision?.revisionNumber, 1, '方案二不受方案一版本影响');

const manual = addProjectScriptRevision(db, 'p1', first.id, {
  origin: 'manual_edit',
  libraryRevisionId: library.id,
  contentJson: { ...contentBase, title: '人工编辑版' },
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:04:00.000Z'));
assert.equal(manual.currentRevision?.origin, 'manual_edit');
assert.equal(getProjectScript(db, 'p1', first.id)!.currentRevision?.revisionNumber, 3);

const history = db.prepare(`
  SELECT revisionNumber, origin FROM project_script_revisions WHERE scriptId = ? ORDER BY revisionNumber
`).all(first.id) as Array<{ revisionNumber: number; origin: string }>;
assert.deepEqual(history.map((row) => row.revisionNumber), [1, 2, 3]);
assert.deepEqual(history.map((row) => row.origin), ['ai_generate', 'ai_regenerate', 'manual_edit']);

// v2：主题/层级/重要度元数据随修订持久化；缺失字段的旧输入取本地默认值。
const themedLibrary = createLibraryRevision(db, {
  projectId: 'p1',
  sourceSetId: 'source-1',
  sourceFingerprint: 'fingerprint-2',
  sellingPoints: [
    { title: '加宽坐深', factText: '坐深 60cm', pointType: 'spec', evidenceQuote: '坐深 60cm', sourcePageIndex: 0, themeKey: 'comfort', themeTitle: '久坐也舒服', hierarchyRole: 'primary', importance: 90, usable: true },
    { title: '无主题卖点', factText: '普通事实', pointType: 'other', evidenceQuote: '普通事实', sourcePageIndex: 0, usable: true },
  ],
}, () => new Date('2026-08-31T00:05:00.000Z'));
const themedPoint = getLibraryRevision(db, 'p1', themedLibrary.id)!.sellingPoints[0]!;
assert.equal(themedPoint.themeKey, 'p0:久坐也舒服', 'themeKey 由本地按页码+规范化标题生成，不直接采用模型值');
assert.equal(themedPoint.themeTitle, '久坐也舒服');
assert.equal(themedPoint.hierarchyRole, 'primary');
assert.equal(themedPoint.importance, 90);
const plainPoint = themedLibrary.sellingPoints[1]!;
assert.equal(plainPoint.themeKey, 'p0:无主题卖点', '缺失主题时按页码+标题回退生成');
assert.equal(plainPoint.themeTitle, '无主题卖点', '缺失 themeTitle 时回退为卖点标题');
assert.equal(plainPoint.hierarchyRole, 'supporting');
assert.equal(plainPoint.importance, 50);

// 手动编辑创建新修订时，主题与层级元数据必须原样保留。
const edited = manualEditLibraryRevision(db, 'p1', [
  { sellingPointId: themedPoint.id, title: '加宽坐深改' },
], { now: () => new Date('2026-08-31T00:06:00.000Z') });
assert.equal(edited.origin, 'manual_edit');
const editedPoint = edited.sellingPoints.find((point) => point.title === '加宽坐深改')!;
assert.equal(editedPoint.themeKey, 'p0:久坐也舒服');
assert.equal(editedPoint.themeTitle, '久坐也舒服');
assert.equal(editedPoint.hierarchyRole, 'primary');
assert.equal(editedPoint.importance, 90);
assert.deepEqual(
  JSON.parse(editedPoint.evidenceRefsJson),
  [{ pageIndex: 0, tileRef: '' }],
  '手动修订必须原样保留证据定位配对结构',
);

// v3：themeKey 由本地按 pageIndex + 规范化 themeTitle 生成。
const canonicalLibrary = createLibraryRevision(db, {
  projectId: 'p1',
  sourceSetId: 'source-1',
  sourceFingerprint: 'fingerprint-3',
  sellingPoints: [
    // 同页同标题（跨批次格式差异：尾部空格/全角字符）→ 归并为同一主题。
    { title: '批次一卖点', factText: '事实一', pointType: 'spec', evidenceQuote: '事实一', sourcePageIndex: 0, tileRefs: ['tile_1'], themeKey: 'theme-1', themeTitle: '久坐也舒服', usable: true },
    { title: '批次二卖点', factText: '事实二', pointType: 'spec', evidenceQuote: '事实二', sourcePageIndex: 0, tileRefs: ['tile_9'], themeKey: 'theme-2', themeTitle: '久坐也舒服 ', usable: true },
    // 不同页面即使模型返回相同 themeKey 与相同标题，也不得碰撞。
    { title: '另一页卖点', factText: '事实三', pointType: 'spec', evidenceQuote: '事实三', sourcePageIndex: 1, tileRefs: ['tile_1'], themeKey: 'theme-1', themeTitle: '久坐也舒服', usable: true },
    // importance 为 null 时回退 50，Number(null)=0 不得被钳成 1。
    { title: '空重要度卖点', factText: '事实四', pointType: 'other', evidenceQuote: '事实四', sourcePageIndex: 0, usable: true, importance: null as unknown as number },
  ],
}, () => new Date('2026-08-31T00:06:30.000Z'));
const [batchOne, batchTwo, otherPage, nullImportance] = canonicalLibrary.sellingPoints;
assert.equal(batchOne!.themeKey, 'p0:久坐也舒服');
assert.equal(batchTwo!.themeKey, 'p0:久坐也舒服', '同页同规范化标题跨识别批次必须归并为同一主题');
assert.equal(otherPage!.themeKey, 'p1:久坐也舒服', '不同页面相同模型 themeKey/标题不得碰撞');
assert.notEqual(batchOne!.themeKey, otherPage!.themeKey);
assert.equal(nullImportance!.importance, 50, 'importance=null 必须使用默认值 50');
assert.deepEqual(JSON.parse(batchTwo!.evidenceRefsJson), [{ pageIndex: 0, tileRef: 'tile_9' }]);

db.close();

// v1 → v2 迁移：老卖点库没有层级列，升级后获得回退默认值，无需重读图片即可复用。
const legacyRoot = path.join(root, 'legacy');
fs.mkdirSync(path.join(legacyRoot, 'backups'), { recursive: true });
const legacyDb = createBaseDatabase(legacyRoot);
legacyDb.exec(SCRIPT_STUDIO_MIGRATIONS[0]!.sql);
legacyDb.exec(`CREATE TABLE IF NOT EXISTS script_studio_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
legacyDb.prepare(`INSERT INTO script_studio_schema_migrations (version, appliedAt) VALUES (1, '2026-08-30T00:00:00.000Z')`).run();
legacyDb.prepare(`
  INSERT INTO script_studio_source_sets (id, projectId, contentFingerprint, imageAssetIdsJson, createdAt)
  VALUES ('legacy-source', 'p1', 'fp-legacy', '[]', '2026-08-30T00:00:01.000Z')
`).run();
legacyDb.prepare(`
  INSERT INTO script_studio_libraries (id, projectId, currentRevisionId, createdAt, updatedAt)
  VALUES ('legacy-lib', 'p1', NULL, '2026-08-30T00:00:02.000Z', '2026-08-30T00:00:02.000Z')
`).run();
legacyDb.prepare(`
  INSERT INTO script_studio_library_revisions (id, libraryId, revisionNumber, sourceSetId, sourceFingerprint, origin, createdAt)
  VALUES ('legacy-rev', 'legacy-lib', 1, 'legacy-source', 'fp-legacy', 'extraction', '2026-08-30T00:00:03.000Z')
`).run();
legacyDb.prepare(`
  INSERT INTO script_studio_selling_points (id, revisionId, seq, title, factText, pointType, evidenceGate, sourcePageIndex, tileRefsJson)
  VALUES ('legacy-point', 'legacy-rev', 1, '老卖点', '老事实', 'spec', 'passed', 0, '["tile_2"]')
`).run();
const legacyMigration = await ensureScriptStudioSchemaReady({
  db: legacyDb,
  backupRoot: path.join(legacyRoot, 'backups'),
  now: () => new Date('2026-08-31T00:07:00.000Z'),
});
assert.equal(legacyMigration.state, 'ready');
assert.deepEqual(legacyMigration.state === 'ready' ? legacyMigration.appliedVersions : [], [2, 3, 4], '老库只追加新版本，不改写已发布的 v1');
const legacyPoint = legacyDb.prepare(`SELECT * FROM script_studio_selling_points WHERE id = 'legacy-point'`).get() as {
  themeKey: string; themeTitle: string; hierarchyRole: string; importance: number; evidenceRefsJson: string;
};
assert.equal(legacyPoint.themeKey, 'p0:老卖点', 'v3 迁移把老 themeKey 规范化为页码+标题');
assert.equal(legacyPoint.themeTitle, '老卖点', '迁移后老数据 themeTitle 回退为卖点标题');
assert.equal(legacyPoint.hierarchyRole, 'supporting');
assert.equal(legacyPoint.importance, 50);
assert.deepEqual(
  JSON.parse(legacyPoint.evidenceRefsJson),
  [{ pageIndex: 0, tileRef: 'tile_2' }],
  'v3 迁移把旧 sourcePageIndex + tileRefs 回填为配对结构',
);
legacyDb.close();

console.log('script-studio-schema.test.ts: ok');
