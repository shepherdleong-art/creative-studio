import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isScriptVisibleInContext } from '../lib/media-core/script-visibility.ts';
import { listReadableProjectScripts } from '../lib/media-core/project-script-reader.ts';
import { isUsableMixcutScriptDraft } from '../lib/media-core/script-draft-usable.ts';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-visibility-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini',
    model TEXT NOT NULL DEFAULT '', inputSnapshot TEXT NOT NULL DEFAULT '{}',
    outputJson TEXT NOT NULL, createdAt TEXT NOT NULL, generationDurationMs INTEGER
  );
  INSERT INTO projects (id, name) VALUES ('p1', '项目一'), ('p2', '项目二');
  INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-a', 'p1', '组A', '2026-08-31T00:00:00.000Z'), ('ss-b', 'p1', '组B', '2026-08-31T00:00:01.000Z'), ('ss-p2', 'p2', '组P2', '2026-08-31T00:00:02.000Z');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:03.000Z'),
});

const projectScriptContent = JSON.stringify({
  version: 3,
  title: '项目级脚本',
  shotSetId: '',
  segments: [{ narration: '项目脚本正文', subtitle: '项目脚本正文', sellingPointRefs: [], visualIntent: '', visualKeywords: [] }],
  fullScript: '项目脚本正文',
});
db.prepare(`
  INSERT INTO project_scripts (id, projectId, shotSetId, currentRevisionId, generationTaskId, archivedAt, createdAt, updatedAt)
  VALUES ('ps-project', 'p1', NULL, 'ps-project-r1', NULL, NULL, '2026-08-31T00:01:00.000Z', '2026-08-31T00:01:00.000Z')
`).run();
db.prepare(`
  INSERT INTO project_script_revisions (id, scriptId, revisionNumber, generationTaskId, libraryRevisionId, templateId, templateVersion, templateRationale, origin, contentJson, targetDurationSec, estimatedDurationSec, validationJson, createdAt)
  VALUES ('ps-project-r1', 'ps-project', 1, NULL, NULL, 'scene_seeding', 1, '', 'ai_generate', ?, 15, 10, '{}', '2026-08-31T00:01:00.000Z')
`).run(projectScriptContent);
db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('legacy-a', 'p1', 'gemini', 'gemini', '{}', ?, '2026-08-31T00:02:00.000Z')
`).run(JSON.stringify({
  version: 3,
  title: '历史A',
  shotSetId: 'ss-a',
  segments: [{ narration: 'A 正文', subtitle: 'A 正文', sellingPointRefs: [], visualIntent: '', visualKeywords: [] }],
  fullScript: 'A 正文',
}));
db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('legacy-b', 'p1', 'gemini', 'gemini', '{}', ?, '2026-08-31T00:02:10.000Z')
`).run(JSON.stringify({
  version: 3,
  title: '历史B',
  shotSetId: 'ss-b',
  segments: [{ narration: 'B 正文', subtitle: 'B 正文', sellingPointRefs: [], visualIntent: '', visualKeywords: [] }],
  fullScript: 'B 正文',
}));

const rows = listReadableProjectScripts(db, 'p1');
assert.equal(rows.length, 3, '新表 ∪ 旧表必须同时可读取');
assert.equal(rows.find((row) => row.id === 'ps-project')?.kind, 'project');
assert.equal(rows.find((row) => row.id === 'legacy-a')?.kind, 'legacy');

const validIds = new Set(['ss-a', 'ss-b']);
assert.equal(isScriptVisibleInContext({ shotSetId: '', validShotSetIds: validIds }), true, '项目级脚本必须全局可见');
assert.equal(isScriptVisibleInContext({ shotSetId: 'ss-a', requestedShotSetId: 'ss-b', validShotSetIds: validIds }), false, '历史脚本禁止跨组');
assert.equal(isScriptVisibleInContext({ shotSetId: 'ss-a', requestedShotSetId: 'ss-a', validShotSetIds: validIds }), true);
assert.equal(isScriptVisibleInContext({ shotSetId: 'ss-a', validShotSetIds: new Set(['ss-b']) }), false, '已删除组隔离');
assert.equal(isScriptVisibleInContext({ shotSetId: 'ss-a', validShotSetIds: validIds }), true, '未指定组时保留旧可见行为');

const parsed = JSON.parse(rows.find((row) => row.id === 'ps-project')!.outputJson);
assert.equal(isUsableMixcutScriptDraft(parsed), true, '空 shotSetId 不再阻止结构可用性');
assert.equal(isScriptVisibleInContext({ shotSetId: '', validShotSetIds: validIds }), true);
assert.equal(isScriptVisibleInContext({ shotSetId: 'ss-p2', requestedShotSetId: 'ss-a', validShotSetIds: new Set(['ss-p2']) }), false);

db.close();
console.log('script-studio-visibility.test.ts: ok');
