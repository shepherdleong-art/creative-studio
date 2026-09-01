import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import {
  createScriptStudioTaskRequestKey,
  createTask,
  getTask,
  recoverInterruptedTasks,
  updateTask,
} from '../lib/script-studio/tasks.ts';

const modelARequestKey = createScriptStudioTaskRequestKey({
  projectId: 'p1',
  mode: 'reuse',
  sourceSetId: null,
  libraryRevisionId: 'revision-1',
  targetDurationSec: 15,
  requestedCount: 2,
  creativeBrief: '自然表达',
  providerId: 'gemini',
  providerModel: 'gemini-model-a',
});
const modelBRequestKey = createScriptStudioTaskRequestKey({
  projectId: 'p1',
  mode: 'reuse',
  sourceSetId: null,
  libraryRevisionId: 'revision-1',
  targetDurationSec: 15,
  requestedCount: 2,
  creativeBrief: '自然表达',
  providerId: 'gemini',
  providerModel: 'gemini-model-b',
});
assert.notEqual(
  modelARequestKey,
  modelBRequestKey,
  '同一供应商切换实际模型后必须形成新任务身份，不能复用旧模型任务',
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-studio-tasks-'));
const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL);
  INSERT INTO projects (id, name) VALUES ('p1', '一');
`);
await ensureScriptStudioSchemaReady({
  db,
  backupRoot: path.join(root, 'backups'),
  now: () => new Date('2026-08-31T00:00:00.000Z'),
});

const first = createTask(db, {
  projectId: 'p1',
  requestKey: 'request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-missing',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2 },
  requestedCount: 2,
}, () => new Date('2026-08-31T00:01:00.000Z'));
const duplicate = createTask(db, {
  projectId: 'p1',
  requestKey: 'request-1',
  mode: 'first_extraction',
  sourceSetId: 'source-missing',
  inputSnapshot: { targetDurationSec: 15, requestedCount: 2 },
  requestedCount: 2,
}, () => new Date('2026-08-31T00:01:01.000Z'));
assert.equal(first.task.id, duplicate.task.id);
assert.equal(duplicate.created, false, '重复 requestKey 只创建一个任务');
assert.equal(getTask(db, 'p1', first.task.id)?.requestedCount, 2);

updateTask(db, 'p1', first.task.id, {
  status: 'running',
  leaseUntil: '2026-08-30T00:00:00.000Z',
}, () => new Date('2026-08-31T00:02:00.000Z'));
assert.equal(recoverInterruptedTasks(db, () => new Date('2026-08-31T00:02:01.000Z')), 1);
assert.equal(getTask(db, 'p1', first.task.id)?.status, 'queued');
assert.equal(getTask(db, 'p1', first.task.id)?.leaseUntil, null);

db.close();
console.log('script-studio-tasks.test.ts: ok');
