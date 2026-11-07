// 05 号票：侧栏数量角标的口径。
// 角标必须与对应页面的条目数一致，且只算本人可见的条目——因此服务端函数必须复用
// 页面同一套 listTeamTasks / listTeamErrors，不在 SQL 里重写一套可见性判断。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-workspace-badges-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { getDb } = await import('../lib/db.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { listTeamTasks } = await import('../lib/team-service/tasks.ts');
const { listTeamErrors, recordTeamError } = await import('../lib/team-service/diagnostics.ts');
const { readWorkspaceBadgeCounts } = await import('../lib/team-service/workspace-counts.ts');

const db = getDb();
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);

const now = new Date('2026-11-07T03:00:00.000Z');
for (const [id, employeeId, displayName, role] of [
  ['admin', '0000', '管理员', 'admin'],
  ['alice', '0102', '阿林', 'employee'],
  ['bob', '0103', '小周', 'employee'],
] as const) {
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'active', 'not-used', 0, 1, ?, ?)`).run(id, employeeId, displayName, role, now.toISOString(), now.toISOString());
  registerRootScope(db, { resourceType: 'test_resource', resourceId: `${id}-project`, ownerUserId: id });
  db.prepare(`INSERT INTO execution_actor_policies (actorId, currency, personalConcurrency, paused, timezone, version, updatedAt)
    VALUES (?, 'CNY', 2, 0, 'Asia/Shanghai', 1, ?)`).run(id, now.toISOString());
}

let sequence = 0;
function insertOperation({ actorId, status = 'pending', module = 'image', taskId, step = 'submit' }: {
  actorId: string; status?: string; module?: string; taskId: string; step?: string;
}) {
  sequence += 1;
  const id = `op-${sequence}-${actorId}`;
  const at = new Date(now.getTime() + sequence * 60_000).toISOString();
  db.prepare(`INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'test_resource', ?, ?, ?, ?, 'r1', ?, 1, 'hash', '{}', 'image.submit', '{}', '[]', '{}', ?, ?, ?, ?)`)
    .run(id, `key-${sequence}`, actorId, `${actorId}-project`, module, taskId, step,
      `biz-${sequence}`, status, sequence, at, at);
  return id;
}

// alice 有 3 条任务、2 条错误；bob 有 2 条任务、1 条错误。
insertOperation({ actorId: 'alice', taskId: 'task-alice-1', status: 'accepted' });
insertOperation({ actorId: 'alice', taskId: 'task-alice-2', status: 'failed' });
insertOperation({ actorId: 'alice', taskId: 'task-alice-3', status: 'succeeded' });
insertOperation({ actorId: 'bob', taskId: 'task-bob-1', status: 'pending' });
insertOperation({ actorId: 'bob', taskId: 'task-bob-2', status: 'failed' });

for (const [index, actorUserId] of ['alice', 'alice', 'bob'].entries()) {
  recordTeamError(db, {
    actorUserId, module: 'image', taskId: `task-${actorUserId}-${index}`,
    stage: 'remote_submit', code: 'upstream_rejected', safeMessage: `隔离验收错误 ${index}`,
  });
}

const employeeViewer = { userId: 'alice', role: 'employee' as const };
const adminViewer = { userId: 'admin', role: 'admin' as const };

// ---- 员工：只算本人可见 ----
const aliceBadges = readWorkspaceBadgeCounts(db, employeeViewer);
assert.deepEqual(aliceBadges, { tasks: 3, errors: 2 }, '员工角标只统计本人条目');
assert.equal(aliceBadges.tasks, listTeamTasks(db, employeeViewer).items.length, '任务角标 = 我的任务页条目数');
assert.equal(aliceBadges.errors, listTeamErrors(db, employeeViewer).items.length, '错误角标 = 出错的任务页条目数');

// ---- 管理员：与页面（默认未筛选）条目数一致 ----
const adminBadges = readWorkspaceBadgeCounts(db, adminViewer);
assert.deepEqual(adminBadges, { tasks: 5, errors: 3 }, '管理员角标统计全员条目');
assert.equal(adminBadges.tasks, listTeamTasks(db, adminViewer).items.length, '全员任务角标 = 全员任务页条目数');
assert.equal(adminBadges.errors, listTeamErrors(db, adminViewer).items.length, '管理员错误角标 = 出错的任务页条目数');

// ---- 管理员按成员筛选后，页面条目数变化，角标必须跟着变（同一口径） ----
assert.equal(readWorkspaceBadgeCounts(db, adminViewer, { actorUserId: 'alice' }).tasks, 3);
assert.equal(readWorkspaceBadgeCounts(db, adminViewer, { actorUserId: 'alice' }).errors, 2);

// ---- 越权口径不得放宽：员工传别人的 actorUserId 仍然只能看到自己的 ----
const forbidden = readWorkspaceBadgeCounts(db, employeeViewer, { actorUserId: 'bob' });
assert.equal(forbidden.tasks, null, '员工不能通过角标探测他人任务数');
assert.equal(forbidden.errors, null, '员工不能通过角标探测他人错误数');

// ---- 空的读者：没有条目时角标为 0（前端把 0 渲染成不显示） ----
db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
  VALUES ('carol','0199','卡罗尔','employee','active','not-used',0,1,?,?)`).run(now.toISOString(), now.toISOString());
assert.deepEqual(readWorkspaceBadgeCounts(db, { userId: 'carol', role: 'employee' }), { tasks: 0, errors: 0 });

// ---- 未登录/无身份：不返回值，前端不显示角标 ----
assert.deepEqual(readWorkspaceBadgeCounts(db, null), { tasks: null, errors: null });

console.log('workspace badge counts contract passed');
