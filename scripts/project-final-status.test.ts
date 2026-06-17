import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getEffectiveProjectFinalStatus } from '../lib/project-status.ts';

const db = new Database(':memory:');

db.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    status TEXT NOT NULL,
    reviewMark TEXT DEFAULT '',
    parentJobId TEXT
  );
`);

const insert = db.prepare(`
  INSERT INTO jobs (id, projectId, status, reviewMark, parentJobId)
  VALUES (?, ?, ?, ?, ?)
`);

insert.run('old-failed', 'project-1', 'failed', 'rework', null);
insert.run('redo-success', 'project-1', 'succeeded', '', 'old-failed');
assert.equal(getEffectiveProjectFinalStatus(db, 'project-1'), 'completed');

insert.run('active-job', 'project-1', 'running', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-1'), 'draft');

insert.run('failed-current', 'project-2', 'failed', '', null);
insert.run('failed-child-success', 'project-2', 'succeeded', '', 'failed-current');
assert.equal(getEffectiveProjectFinalStatus(db, 'project-2'), 'completed');

insert.run('needs-check', 'project-3', 'needs_check', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-3'), 'needs_check');

db.close();
console.log('project-final-status tests passed');
