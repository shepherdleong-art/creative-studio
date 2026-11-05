import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const extensions = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
interface ResolvedModule { url: string; format?: string | null; shortCircuit?: boolean }
type NextResolve = (specifier: string, context?: unknown) => ResolvedModule;
const { registerHooks } = module as unknown as {
  registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: NextResolve) => ResolvedModule }) => void;
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const base = path.join(repoRoot, specifier.slice(2));
      const candidate = fs.existsSync(base) && fs.statSync(base).isFile()
        ? base : extensions.map((extension) => `${base}${extension}`).find((file) => fs.existsSync(file));
      if (candidate) return nextResolve(pathToFileURL(candidate).href, context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
        if (specifier.startsWith('.')) return nextResolve(`${specifier}.ts`, context);
        if (!specifier.startsWith('/')) return nextResolve(`${specifier}.js`, context);
      }
      throw error;
    }
  },
});

// 数据根必须在 import 业务库之前固定，避免写进仓库自己的 data/ 与 storage/。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-task-query-'));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3287',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-task-query',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-task-query',
});
const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { listTeamTasks, listTeamTaskActorOptions } = await import('../lib/team-service/tasks.ts');
const { groupTeamTasksByActor } = await import('../lib/team-task-groups.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3287,
  deploymentId: 'deployment-task-query', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
const paths = schemaUpgradeRuntimePaths(root);
assert.equal((await checkTeamServiceReadiness({ db, ...paths })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...paths })).available, true);

const now = new Date('2026-11-05T03:00:00.000Z');
function member(id: string, employeeId: string, displayName: string, role: 'employee' | 'admin' = 'employee', status = 'active'): void {
  db.prepare(`INSERT INTO team_users (id, employeeId, displayName, role, status, passwordHash, mustChangePassword, sessionVersion, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'not-used', 0, 1, ?, ?)`).run(id, employeeId, displayName, role, status, now.toISOString(), now.toISOString());
}
member('admin', '0000', '管理员', 'admin');
member('user-same-a', '0001', '李四');
member('user-same-b', '0002', '李四');
member('user-low', '0003', '低频成员');
member('user-disabled', '0004', '已停用成员', 'employee', 'disabled');

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled) VALUES ('p', 'p', 'http://127.0.0.1:9', 'k', 'm', 'openai-compatible', 1)").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project-query', '查询测试项目', 'p', 'm', 'prompt')").run();

let sequence = 0;
function operation(actorId: string, updatedAt: Date, status = 'succeeded', waitReason: string | null = null): string {
  sequence += 1;
  const id = `op-${String(sequence).padStart(5, '0')}`;
  db.prepare(`
    INSERT INTO execution_operations (
      id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
      businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
      providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, waitReason, createdAt, updatedAt
    ) VALUES (?, ?, ?, 'project', 'project-query', 'image', ?, 'submit', 'r1', ?, 1, 'h', '{}', 'image.submit', '{}', '[]', '{}', ?, ?, ?, ?, ?)
  `).run(id, `key-${id}`, actorId, `task-${id}`, `business-${id}`, status, sequence, waitReason, updatedAt.toISOString(), updatedAt.toISOString());
  return id;
}

try {
  // 低频成员：任务时间远早于后来制造的 500+ 条较新任务。
  const lowId = operation('user-low', new Date('2026-01-01T00:00:00.000Z'));
  for (let index = 0; index < 520; index += 1) {
    operation('user-same-a', new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + index * 1000));
  }
  operation('user-same-b', new Date('2026-10-02T00:00:00.000Z'), 'failed');
  const disabledWaitingId = operation('user-disabled', new Date('2026-10-03T00:00:00.000Z'), 'deferred', 'actor_disabled');
  // 取消语义：waitReason=stage_canceled 的行在展示与过滤上都必须算 canceled。
  const canceledId = operation('user-same-b', new Date('2026-10-04T00:00:00.000Z'), 'pending', 'stage_canceled');

  const admin = { userId: 'admin', role: 'admin' as const };
  const employee = { userId: 'user-low', role: 'employee' as const };

  // — 截断口径 —
  const all = listTeamTasks(db, admin);
  assert.equal(all.items.length, 500, '最近记录上限是 500 条');
  assert.equal(all.limit, 500, '接口必须显式给出最近记录上限');
  assert.equal(all.truncated, true, '命中上限时必须声明结果被截断，不能冒充全历史');
  assert.equal(all.totalMatching, null, '本轮不提供全历史分页，不虚报总数');

  const ownOnly = listTeamTasks(db, employee);
  assert.equal(ownOnly.truncated, false, '低频成员只有一条任务，不得标成截断');
  assert.equal(ownOnly.items.length, 1);
  assert.equal(ownOnly.items[0].operationId, lowId);

  // — 成员选项不来自最近 500 条任务 —
  const options = listTeamTaskActorOptions(db, admin);
  assert.ok(options.some((option: { actorUserId: string }) => option.actorUserId === 'user-low'),
    '低频成员即使被挤出最近 500 条，也必须在成员选项里');
  assert.ok(options.some((option: { actorUserId: string }) => option.actorUserId === 'user-disabled'),
    '历史停用但仍可能有任务的成员也要可辨认');
  const optionByActor = new Map<string, { actorUserId: string; employeeId: string; displayName: string; accountStatus: string }>(
    options.map((option: { actorUserId: string; employeeId: string; displayName: string; accountStatus: string }) => [option.actorUserId, option]),
  );
  assert.equal(optionByActor.get('user-same-a')?.displayName, '李四');
  assert.equal(optionByActor.get('user-same-b')?.employeeId, '0002',
    '同名成员靠工号区分，不能被姓名合并');
  assert.equal(optionByActor.get('user-disabled')?.accountStatus, 'disabled',
    '停用成员在选项里保留可辨认的账号状态');
  assert.equal(options.filter((option: { displayName: string }) => option.displayName === '李四').length, 2,
    '两位同名成员必须是两个选项');

  const employeeOptions = listTeamTaskActorOptions(db, employee);
  assert.deepEqual(employeeOptions.map((option: { actorUserId: string }) => option.actorUserId), ['user-low'],
    '员工只能拿到自己的选项，不能枚举团队');

  // — 低频成员确实查得到 —
  const lowQuery = listTeamTasks(db, admin, { actorUserId: 'user-low' });
  assert.deepEqual(lowQuery.items.map((entry: { operationId: string }) => entry.operationId), [lowId]);
  assert.equal(lowQuery.truncated, false);

  // — 同名成员按 ID 精确筛选 —
  const sameA = listTeamTasks(db, admin, { actorUserId: 'user-same-a' });
  const sameB = listTeamTasks(db, admin, { actorUserId: 'user-same-b' });
  assert.equal(sameA.items.length, 500);
  assert.ok(sameA.items.every((entry: { actorUserId: string }) => entry.actorUserId === 'user-same-a'));
  assert.ok(sameB.items.every((entry: { actorUserId: string }) => entry.actorUserId === 'user-same-b'));
  assert.equal(sameB.items.some((entry: { operationId: string }) => entry.operationId === lowId), false);
  const sameGroups = groupTeamTasksByActor(sameA.items);
  assert.deepEqual(sameGroups.map((group: { actorUserId: string }) => group.actorUserId), ['user-same-a'],
    '同名成员不能混组');

  // — 取消语义不回归 —
  const canceled = listTeamTasks(db, admin, { status: 'canceled', actorUserId: 'user-same-b' });
  assert.ok(canceled.items.some((entry: { operationId: string }) => entry.operationId === canceledId));
  assert.equal(canceled.items.every((entry: { status: string }) => entry.status === 'canceled'), true);
  const deferred = listTeamTasks(db, admin, { status: 'deferred' });
  assert.equal(deferred.items.some((entry: { operationId: string }) => entry.operationId === canceledId), false,
    'stage_canceled 不能被 deferred 过滤捞回来');
  assert.ok(deferred.items.some((entry: { operationId: string }) => entry.operationId === disabledWaitingId),
    '真正的停用等待仍应出现在 deferred 里');

  // — 权限：员工不能借 actorUserId 越权 —
  assert.throws(() => listTeamTasks(db, employee, { actorUserId: 'user-same-a' }),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === 'task_query_forbidden');
  assert.throws(() => listTeamTaskActorOptions(db, employee, { actorUserId: 'user-same-a' }),
    (error: { status?: number }) => error.status === 403);

  // 员工 + 状态组合仍只在自己范围内。
  const employeeCanceled = listTeamTasks(db, employee, { status: 'canceled' });
  assert.equal(employeeCanceled.items.length, 0);

  console.log('PASS: team task actor options, 500-record truncation, same-name grouping, cancel semantics and permissions');
} finally {
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
