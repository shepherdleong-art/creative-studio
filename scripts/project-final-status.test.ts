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

// Historical completed work (including pre-v2 final-video jobs) must not be
// reclassified as draft merely because newer preview jobs are kept elsewhere.
insert.run('legacy-success', 'project-4', 'succeeded', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-4'), 'completed');

// 全军覆没:有效任务全部失败、没有成功也没有在跑 → failed(UI 红),不是 partial_failed(UI 黄)
insert.run('all-failed-1', 'project-5', 'failed', '', null);
insert.run('all-failed-2', 'project-5', 'failed', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-5'), 'failed');

// 只要有一条成功就退回 partial_failed
insert.run('some-success', 'project-5', 'succeeded', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-5'), 'partial_failed');

// 还有任务在跑时不下「全灭」的定论
insert.run('running-failed', 'project-6', 'failed', '', null);
insert.run('running-active', 'project-6', 'running', '', null);
assert.equal(getEffectiveProjectFinalStatus(db, 'project-6'), 'partial_failed');

// 被 rework 标记/已被重试取代的失败任务不算数:全灭判定与 partial 用的是同一批有效任务
insert.run('reworked-failed', 'project-7', 'failed', 'rework', null);
insert.run('superseded-failed', 'project-7', 'failed', '', null);
insert.run('retry-success', 'project-7', 'succeeded', '', 'superseded-failed');
assert.equal(getEffectiveProjectFinalStatus(db, 'project-7'), 'completed');

db.close();
console.log('project-final-status tests passed');
