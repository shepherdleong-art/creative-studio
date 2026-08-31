import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { addProjectScriptRevision, createProjectScript, getProjectScript, listProjectScriptRevisions, setProjectScriptCurrentRevision } from '../lib/script-studio/scripts.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-revisions-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  INSERT INTO projects (id, name) VALUES ('p1', '一');
  INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss1', 'p1', '组一', '2026-08-31T00:00:00.000Z');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:00.000Z'),
});

const content = { title: '方案', segments: [{ id: 's1', narration: '正文', subtitle: '正文', sellingPointIdRefs: [], sellingPointRefs: [], visualIntent: '', visualKeywords: [] }], targetDurationSec: 15, fullScript: '正文', fullSubtitle: '正文' };
const script = createProjectScript(db, 'p1', {
  origin: 'ai_generate',
  contentJson: content,
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:01:00.000Z'));
const v1 = script.currentRevision!;
const v2 = addProjectScriptRevision(db, 'p1', script.id, {
  origin: 'ai_regenerate',
  contentJson: { ...content, title: '方案二' },
  targetDurationSec: 15,
}, () => new Date('2026-08-31T00:02:00.000Z')).currentRevision!;

const history = listProjectScriptRevisions(db, 'p1', v1.scriptId, { limit: 100 });
assert.equal(history.revisions.length >= 2, true, '每个方案保留完整版本历史');
const original = getProjectScript(db, 'p1', v1.scriptId)!.currentRevision;
assert.equal(original?.revisionNumber, 2);
const afterSwitch = setProjectScriptCurrentRevision(db, 'p1', v1.scriptId, history.revisions.at(-1)!.id, () => new Date('2026-08-31T00:03:00.000Z'));
assert.equal(afterSwitch.currentRevision?.id, v1.id);
assert.notEqual(history.revisions.length, 0);
assert.equal(getProjectScript(db, 'p1', v2.scriptId)?.currentRevision?.revisionNumber, 1);

db.close();
console.log('script-studio-revisions.test.ts: ok');
