import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CORE_DB_MIGRATIONS } from '../lib/db-migrations.ts';
import {
  sortProjectJobsByCreation,
  sqliteTimestampMs,
  type ProjectJobOrderRow,
} from '../lib/project-job-order.ts';

// C4：场景结果稳定排序。fixture：批次 A（3 个，先创建）、批次 B（2 个，后创建）、
// 一个没有任何时间列的 legacy job。规则：最新创建批次在前，批内按提交顺序，
// 状态变化不改变位置，历史行有确定位置，重生成作为新批次出现在最前。

assert.equal(sqliteTimestampMs(''), null, '空字符串不得解析出时间');
assert.equal(sqliteTimestampMs(null), null, 'null 不得解析出时间');
assert.equal(sqliteTimestampMs('not-a-date'), null, '非法字符串不得解析出时间');
assert.equal(sqliteTimestampMs('2026-09-01 08:00:00'), sqliteTimestampMs('2026-09-01T08:00:00Z'), '空格格式必须与 ISO T 格式等价');
assert.equal(
  sqliteTimestampMs('2026-09-01T08:00:00.000Z'),
  sqliteTimestampMs('2026-09-01 08:00:00.000'),
  '带毫秒的两种格式也必须等价',
);
assert.equal(sqliteTimestampMs('2026-09-01T08:00:00+08:00'), sqliteTimestampMs('2026-09-01T00:00:00Z'), '带时区的 ISO 字符串必须正确解析');

// ---- 纯函数排序：批内顺序、批次顺序、状态无关、legacy 回退 ----
const batchATime = '2026-09-01T08:00:00.000Z';
const batchBTime = '2026-09-01T09:30:00.000Z';
const sortedPure = sortProjectJobsByCreation<ProjectJobOrderRow>([
  { id: 'legacy-none' },
  { id: 'a-0', createdAt: batchATime, creationIndex: 0 },
  { id: 'b-1', createdAt: batchBTime, creationIndex: 1 },
  { id: 'a-2', createdAt: batchATime, creationIndex: 2 },
  { id: 'a-1', createdAt: batchATime, creationIndex: 1 },
  { id: 'legacy-submitted', submittedAt: '2026-08-31 10:00:00' },
  { id: 'b-0', createdAt: batchBTime, creationIndex: 0 },
]);
assert.deepEqual(
  sortedPure.map((row) => row.id),
  ['b-0', 'b-1', 'a-0', 'a-1', 'a-2', 'legacy-submitted', 'legacy-none'],
  '批次 B 在 A 前，批内 index 升序，legacy 行按旧时间列回退且无时间行垫底',
);
// 「状态不参与排序」的真实覆盖在下方内存库集成段：UPDATE jobs SET
// status='succeeded' 后重查，顺序不变。

// ---- 内存库集成：与真实 jobs 表结构一起验证 ----
const db = new Database(':memory:');
db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, projectId TEXT, inputImageId TEXT, status TEXT, startedAt TEXT, finishedAt TEXT)`);
for (const sql of CORE_DB_MIGRATIONS) {
  try { db.exec(sql); } catch { /* 与生产迁移行为一致：跳过已应用/不适用条目 */ }
}
const insertJob = db.prepare(`
  INSERT INTO jobs (id, projectId, inputImageId, status, createdAt, creationIndex, submittedAt, startedAt, finishedAt)
  VALUES (?, 'project-1', 'input-1', 'pending', ?, ?, ?, ?, ?)
`);
insertJob.run('legacy-job', null, 0, '2026-08-31 10:00:00', null, null);
insertJob.run('a-0', batchATime, 0, null, null, null);
insertJob.run('a-1', batchATime, 1, null, null, null);
insertJob.run('a-2', batchATime, 2, null, null, null);
insertJob.run('b-0', batchBTime, 0, null, null, null);
insertJob.run('b-1', batchBTime, 1, null, null, null);

function orderedIds(): string[] {
  const rows = db.prepare(`
    SELECT j.*, j.rowid AS creationSequence FROM jobs j WHERE j.projectId = 'project-1'
  `).all() as Array<ProjectJobOrderRow & Record<string, unknown>>;
  return sortProjectJobsByCreation(rows).map((row) => row.id);
}

assert.deepEqual(
  orderedIds(),
  ['b-0', 'b-1', 'a-0', 'a-1', 'a-2', 'legacy-job'],
  '批次 B 的 2 个在 A 前；B 内部 index 0 → 1，A 内部 0 → 1 → 2；legacy 行可见且有确定位置',
);

// 状态从 pending 变为 succeeded 后，顺序完全不变。
db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE id = 'a-1'`).run();
assert.deepEqual(
  orderedIds(),
  ['b-0', 'b-1', 'a-0', 'a-1', 'a-2', 'legacy-job'],
  '任务状态变化不得改变场景卡片位置',
);

// 重新生成的单条任务作为新批次出现在前面。
insertJob.run('regen-1', '2026-09-01T11:00:00.000Z', 0, null, null, null);
assert.deepEqual(
  orderedIds(),
  ['regen-1', 'b-0', 'b-1', 'a-0', 'a-1', 'a-2', 'legacy-job'],
  '重新生成的单条任务必须作为新批次出现在最前',
);

// 重复跑迁移不修改历史数据。
for (const sql of CORE_DB_MIGRATIONS) {
  try { db.exec(sql); } catch { /* 与生产迁移行为一致 */ }
}
assert.deepEqual(
  db.prepare(`SELECT id, createdAt, creationIndex, submittedAt FROM jobs WHERE id = 'legacy-job'`).get(),
  { id: 'legacy-job', createdAt: null, creationIndex: 0, submittedAt: '2026-08-31 10:00:00' },
  '重复执行迁移不得改写历史 jobs 数据',
);
assert.deepEqual(orderedIds(), ['regen-1', 'b-0', 'b-1', 'a-0', 'a-1', 'a-2', 'legacy-job'], '重复迁移后排序保持不变');

db.close();
console.log('project job order tests passed');
