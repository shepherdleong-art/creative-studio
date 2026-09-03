import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import {
  buildTaskIdentity,
  createScriptStudioTaskRequestKey,
  createTask,
  decideTaskRequest,
  getTask,
  listRecentTasks,
  recoverInterruptedTasks,
  taskStoredIdentity,
  updateTask,
} from '../lib/script-studio/tasks.ts';
import { ScriptStudioError } from '../lib/script-studio/errors.ts';

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

// F2：原子 get-or-create 与 canonical identity。
const atomicA = createTask(db, {
  projectId: 'p1',
  requestKey: 'atomic-1',
  mode: 'reuse',
  libraryRevisionId: 'rev-1',
  inputSnapshot: { targetDurationSec: 30, requestedCount: 6, creativeBrief: 'x' },
  requestedCount: 6,
}, () => new Date('2026-08-31T00:05:00.000Z'));
const atomicADup = createTask(db, {
  projectId: 'p1',
  requestKey: 'atomic-1',
  mode: 'reuse',
  libraryRevisionId: 'rev-1',
  inputSnapshot: { targetDurationSec: 30, requestedCount: 6, creativeBrief: 'x' },
  requestedCount: 6,
}, () => new Date('2026-08-31T00:05:01.000Z'));
assert.equal(atomicA.created, true, '首建必须 created:true');
assert.equal(atomicADup.created, false, '同 key 同 body 必须 created:false');
assert.equal(atomicADup.task.id, atomicA.task.id, '同 key 同 body 必须返回同一任务');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM script_studio_tasks WHERE requestKey = 'atomic-1'`).get() as { n: number }).n,
  1,
  '重复提交不得新增行',
);
// buildTaskIdentity 与 taskStoredIdentity 必须同构（route 预查与原子冲突回读共用同一 comparator）。
const builtIdentity = buildTaskIdentity({
  projectId: 'p1',
  requestKey: 'atomic-1',
  mode: 'reuse',
  libraryRevisionId: 'rev-1',
  requestedCount: 6,
  inputSnapshot: { targetDurationSec: 30, requestedCount: 6, creativeBrief: 'x' },
});
assert.equal(taskStoredIdentity(atomicA.task), builtIdentity, 'stored identity 必须与 build identity 一致');
// 同 key、不同 body：必须 409 conflict，不静默复用旧任务。
assert.throws(
  () => createTask(db, {
    projectId: 'p1',
    requestKey: 'atomic-1',
    mode: 'reuse',
    libraryRevisionId: 'rev-1',
    inputSnapshot: { targetDurationSec: 30, requestedCount: 5, creativeBrief: 'x' },
    requestedCount: 5,
  }),
  (error: unknown) => error instanceof ScriptStudioError && error.code === 'conflict',
  '同 key 不同 body 必须 409 conflict',
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM script_studio_tasks WHERE requestKey = 'atomic-1'`).get() as { n: number }).n,
  1,
  '409 冲突不得新增行',
);
// 串行同 key、不同 body 也必须是 409（与并发语义一致）。
assert.throws(
  () => createTask(db, {
    projectId: 'p1',
    requestKey: 'atomic-1',
    mode: 'reuse',
    libraryRevisionId: 'rev-1',
    inputSnapshot: { targetDurationSec: 45, requestedCount: 6, creativeBrief: 'x' },
    requestedCount: 6,
  }),
  (error: unknown) => error instanceof ScriptStudioError && error.code === 'conflict',
  '串行同 key 不同 body 也必须是 409',
);

// F2 验证 5/6：跨连接真并发。better-sqlite3 单进程同步，事件循环内无法交错两个调用，
// 所以用 worker_threads 各自开连接并发打同一个 SQLite 文件（WAL），让唯一约束的竞争
// 真实发生：同 key/同 body 恰好一个 created:true；同 key/不同 body 胜者 created:true、
// 败者 409 conflict，两种情况下数据库都只有一行、且不出现唯一约束异常。
db.pragma('journal_mode = WAL');
const tasksUrl = pathToFileURL(path.resolve('lib/script-studio/tasks.ts')).href;
const raceWorkerCode = `
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
const { createTask } = await import(workerData.tasksUrl);
let result;
try {
  const out = createTask(db, workerData.input);
  result = { created: out.created, taskId: out.task.id };
} catch (e) {
  result = { error: e?.code ?? String(e?.message) };
}
db.close();
parentPort.postMessage(result);
`;
type RaceResult = { created?: boolean; taskId?: string; error?: string };
const runConcurrentCreate = (input: Record<string, unknown>): Promise<RaceResult> => new Promise((resolve) => {
  const worker = new Worker(raceWorkerCode, {
    eval: true,
    workerData: { dbPath: path.join(root, 'workbench.db'), tasksUrl, input },
    execArgv: ['--experimental-strip-types'],
  });
  worker.on('message', (message: unknown) => resolve(message as RaceResult));
  worker.on('error', (error) => resolve({ error: String(error) }));
});
const raceBase = { projectId: 'p1', requestKey: 'race-same', mode: 'reuse', libraryRevisionId: 'rev-race', requestedCount: 6 };
const raceSameBody = { ...raceBase, inputSnapshot: { targetDurationSec: 30, requestedCount: 6 } };
const raceSameResults = await Promise.all([
  runConcurrentCreate(raceSameBody),
  runConcurrentCreate(raceSameBody),
  runConcurrentCreate(raceSameBody),
]);
assert.equal(raceSameResults.filter((result) => result.created === true).length, 1, '并发同 key/同 body 恰好一个 created:true');
assert.equal(raceSameResults.filter((result) => result.created === false).length, raceSameResults.length - 1, '其余请求必须 created:false');
assert.equal(new Set(raceSameResults.map((result) => result.taskId)).size, 1, '并发同 key/同 body 所有请求指向同一 taskId');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM script_studio_tasks WHERE requestKey = 'race-same'`).get() as { n: number }).n,
  1,
  '并发同 key/同 body 数据库仅一行，不出现唯一约束异常',
);
const raceConflictBase = { ...raceBase, requestKey: 'race-diff' };
const raceConflictResults = await Promise.all([
  runConcurrentCreate({ ...raceConflictBase, inputSnapshot: { targetDurationSec: 30, requestedCount: 6 } }),
  runConcurrentCreate({ ...raceConflictBase, inputSnapshot: { targetDurationSec: 45, requestedCount: 6 } }),
]);
assert.equal(raceConflictResults.filter((result) => result.created === true).length, 1, '并发同 key/不同 body 胜者 created:true');
assert.equal(raceConflictResults.filter((result) => result.error === 'conflict').length, 1, '并发同 key/不同 body 败者返回 409 conflict');
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS n FROM script_studio_tasks WHERE requestKey = 'race-diff'`).get() as { n: number }).n,
  1,
  '并发同 key/不同 body 数据库仅一行',
);

// G3：非唯一冲突的插入失败必须原样上抛，不伪装成 conflict。
const brokenDb = new Database(path.join(root, 'broken.db'));
brokenDb.pragma('journal_mode = WAL');
brokenDb.exec(`CREATE TABLE script_studio_tasks (id TEXT PRIMARY KEY, requestKey TEXT NOT NULL);`);
assert.throws(
  () => createTask(brokenDb, { projectId: 'p1', requestKey: 'broken-1', mode: 'reuse', libraryRevisionId: 'rev-1', inputSnapshot: {}, requestedCount: 2 }),
  (error: unknown) => !(error instanceof ScriptStudioError) || error.code !== 'conflict',
  '插入失败必须抛出底层错误而不是 conflict',
);
assert.throws(
  () => createTask(brokenDb, { projectId: 'p1', requestKey: 'broken-1', mode: 'reuse', libraryRevisionId: 'rev-1', inputSnapshot: {}, requestedCount: 2 }),
  (error: unknown) => error instanceof Error && /no column named|SQLITE/i.test(error.message),
  '错误信息必须包含真实原因（缺列名）',
);
brokenDb.close();

// G5：显式 key 重放不解析当前供应商——供应商不可用也能安全复用。
const g5First = createTask(db, {
  projectId: 'p1',
  requestKey: 'g5-explicit',
  mode: 'reuse',
  libraryRevisionId: 'rev-g5',
  inputSnapshot: { targetDurationSec: 30, requestedCount: 6, creativeBrief: 'g5', providerId: 'vision-e2e', providerModel: 'model-e2e' },
  requestedCount: 6,
});
assert.equal(g5First.created, true);
let g5ResolveCalls = 0;
const g5Decision = decideTaskRequest(db, {
  projectId: 'p1',
  mode: 'reuse',
  libraryRevisionId: 'rev-g5',
  targetDurationSec: 30,
  requestedCount: 6,
  creativeBrief: 'g5',
  providerId: 'vision-e2e',
  explicitRequestKey: 'g5-explicit',
}, () => { g5ResolveCalls += 1; throw new Error('供应商不可用，不应被解析'); });
assert.equal(g5Decision.existing?.id, g5First.task.id, '显式 key 重放必须命中既有任务');
assert.equal(g5Decision.snapshot, null, '重放路径不产生创建快照');
assert.equal(g5ResolveCalls, 0, '重放路径不得调用 resolveProviders');
// 派生 key（无显式 key）才解析供应商，并把冻结结果放进创建快照。
let g5DerivedCalls = 0;
const g5Derived = decideTaskRequest(db, {
  projectId: 'p1',
  mode: 'reuse',
  libraryRevisionId: 'rev-g5',
  targetDurationSec: 30,
  requestedCount: 6,
  creativeBrief: 'g5-derived',
  providerId: 'vision-e2e',
}, (providerId) => { g5DerivedCalls += 1; return { vision: { id: providerId, model: 'model-e2e' } }; });
assert.equal(g5DerivedCalls, 1, '派生 key 必须解析供应商一次');
assert.equal(g5Derived.existing, null, '新参数不应命中旧任务');
assert.ok(g5Derived.snapshot && g5Derived.snapshot.providerId === 'vision-e2e', '创建快照必须冻结供应商');

// 最近任务列表（刷新后恢复运行中任务）：按创建时间倒序，limit 生效。
const recent = listRecentTasks(db, 'p1', 2);
assert.equal(recent.length, 2, 'listRecentTasks 受 limit 约束');
assert.ok(recent[0]!.createdAt >= recent[1]!.createdAt, 'listRecentTasks 必须按创建时间倒序');
assert.ok(recent.every((task) => task.projectId === 'p1'), 'listRecentTasks 只返回本项目任务');
assert.ok(Array.isArray(recent[0]!.stages), 'listRecentTasks 返回带阶段的任务视图（快照可序列化）');

db.close();
console.log('script-studio-tasks.test.ts: ok');
