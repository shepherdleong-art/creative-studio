// 03 号票：全员任务服务端分页的公共合同（真实 SQLite + 真实路由）。
//
// 固定数据（功能方案第 8 节）：503 个制作任务 / 505 条执行记录，其中一个统一任务有
// 3 条执行记录。验证：
// - pageSize=25 → 21 页、末页 3 个制作任务；pageSize=50 → 11 页、末页 3 个；
// - 含 3 条执行记录的统一任务放在页边界，整组只在一页出现一次；遍历恰好覆盖授权集合；
// - 总数恒为 503/505，不随页变；搜索覆盖完整历史（关键词/工号/中文步骤/模型/执行 ID）；
// - `%`/`_`/引号是普通文字；同 updatedAt 排序稳定；空结果/非法参数/越界页；
// - 管理员全员/单成员、员工本人、员工指定他人 403、员工详情 404；
// - 500 条之外的旧 operationId 详情可读；本页统一任务费用按 mediaTaskId 定向且完整。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// `@/…` 别名（路由文件用）与无扩展名相对导入都在这里解析，与其他团队路由测试同一套钩子。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-task-pagination-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-task-pagination',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-pagination',
});

const { ensureServerDeploymentMarker } = await import('../lib/team-service/config.ts');
const { getDb, closeDb } = await import('../lib/db.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
const { setTeamAuthServiceForTests } = await import('../lib/team-service/auth/runtime.ts');
const { sessionCookie } = await import('../lib/team-service/auth/request.ts');
const {
  countTeamTasks, findTeamTask, listRecentTeamTasks, listTeamTaskRecords, listTeamTasks, readTeamTaskActivity,
} = await import('../lib/team-service/tasks.ts');
const { queryUnifiedTaskUsageByMediaTaskIds } = await import('../lib/team-service/unified-usage.ts');
const { parseTeamPage, resolveTeamPage, teamTotalPages } = await import('../lib/team-service/pagination.ts');
const { readWorkspaceBadgeCounts } = await import('../lib/team-service/workspace-counts.ts');
const { workspaceBadgeCounts } = await import('../lib/workspace-navigation.ts');
const { consoleMemberActivity, consoleMemberRows, consoleTaskCounts, recentConsoleTasks } = await import('../lib/team-console-overview.ts');
const { taskIdFromQuery } = await import('../lib/team-console-overview.ts');
const { IN_FLIGHT_STATUSES } = await import('../lib/task-progress.ts');

// ── 1. 分页参数合同的纯函数部分（先钉规则，再钉数据） ──────────────────────────
function expectPaginationError(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    const value = error as { status?: number; code?: string; name?: string };
    return value.name === 'TeamPaginationError' && value.status === 400 && value.code === code;
  });
}

assert.deepEqual(parseTeamPage({}), { page: 1, pageSize: 25 }, '缺省 page=1、pageSize=25');
assert.deepEqual(parseTeamPage({ page: ' 3 ', pageSize: '50' }), { page: 3, pageSize: 50 }, '字符串参数去空格后解析');
assert.deepEqual(parseTeamPage({ page: 2, pageSize: 25 }), { page: 2, pageSize: 25 }, '内部调用可直接传数字');
for (const invalid of ['0', '-1', '1.5', '2.0', 'abc', '1e3', '0x10', '9007199254740992', 0, -3, 2.5, Number.MAX_SAFE_INTEGER + 2]) {
  expectPaginationError(() => parseTeamPage({ page: invalid }), 'page_invalid');
}
assert.deepEqual(parseTeamPage({ page: '', pageSize: '' }), { page: 1, pageSize: 25 }, '空串等同未提供');
for (const invalid of ['30', '0', '100', '25.0', 'many', 10]) {
  expectPaginationError(() => parseTeamPage({ pageSize: invalid }), 'page_size_invalid');
}
assert.equal(teamTotalPages(0, 25), 1, '空结果按 1 页');
assert.equal(teamTotalPages(503, 25), 21);
assert.equal(teamTotalPages(503, 50), 11);
assert.deepEqual(
  resolveTeamPage({ page: 1, pageSize: 25 }, 0),
  { pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 }, offset: 0 },
  '空结果 total=0、totalPages=1、page=1',
);
assert.deepEqual(
  resolveTeamPage({ page: 999, pageSize: 25 }, 503),
  { pagination: { page: 21, pageSize: 25, total: 503, totalPages: 21 }, offset: 500 },
  '超出末页归到有效末页并返回实际 page',
);
console.log('PASS: pagination contract parses, clamps and rejects invalid page/pageSize');

// ── 2. 真实 SQLite + 真实会话 ─────────────────────────────────────────────────
ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-task-pagination', trustedOrigin: 'https://studio.example.test',
});
const db = getDb();
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);

const kdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
const passwordParams = { N: 1024, r: 8, p: 1 };
const initialized = await initializeFirstAdministrator({ db, employeeId: '0000', displayName: '管理员', kdf, passwordParams });
const service = createTeamAuthService({ db, kdf, passwordParams });
setTeamAuthServiceForTests(service);
const adminLogin = await service.login({ employeeId: '0000', password: initialized.credential });
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-pagination-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-pagination-password' });
const admin = adminSession.principal;

async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(admin, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-pagination-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-pagination-password` });
  return {
    principal: authenticated.principal,
    cookie: sessionCookie(authenticated.token).split(';', 1)[0],
  };
}
const alice = await account('0001', '张三');
const bob = await account('0002', '李四');
const carol = await account('0999', '王五');
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];

const tasksRoute = await import('../app/api/team/tasks/route.ts');
const detailRoute = await import('../app/api/team/tasks/detail/route.ts');
const adminView = { userId: admin.userId, role: 'admin' as const };
const aliceView = { userId: alice.principal.userId, role: 'employee' as const };
const bobView = { userId: bob.principal.userId, role: 'employee' as const };
const carolView = { userId: carol.principal.userId, role: 'employee' as const };
const now = new Date('2026-11-11T04:00:00.000Z'); // 上海 2026-11-11 12:00

function request(url: string, cookie: string): Request {
  const headers = new Headers();
  headers.set('Cookie', cookie);
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  return new Request(url, { headers });
}
const tasksUrl = (query: string) => `https://studio.example.test/api/team/tasks${query ? `?${query}` : ''}`;
const detailUrl = (query: string) => `https://studio.example.test/api/team/tasks/detail${query}`;

// 基础业务表（core 迁移已建）：项目、供应商、图片资产、统一媒体任务。
const TODAY_BASE = Date.parse('2026-11-11T10:00:00.000Z'); // 上海 18:00，算「今天」
const OLD_BASE = Date.parse('2026-11-09T10:00:00.000Z'); // 上海 11-09，不算今天
const minutes = (count: number) => count * 60_000;
const iso = (time: number) => new Date(time).toISOString();
// 位置 i（从 1 开始，越小越新）：1–100 落在今天，101 之后落在 11-09。
function positionTime(position: number): string {
  return position <= 100
    ? iso(TODAY_BASE - minutes(position))
    : iso(OLD_BASE - minutes(position - 100));
}

db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-fixture', '分页验收供应商', 'http://127.0.0.1:9', 'fixture', 'gpt-image-2')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt, status) VALUES ('project-main', '全员任务分页项目', 'provider-fixture', 'gpt-image-2', '', 'draft')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt, status) VALUES ('project-tail', ?, 'provider-fixture', 'gpt-image-2', '', 'draft')")
  .run("末页专用 50% 折扣 'A店' 项目");
db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES ('asset-tail', 'project-tail', 'input', '末页专用素材.png', 'inputs/tail.png', 'scene_seed')").run();
db.prepare("INSERT INTO image_assets (id, projectId, role, filename, path, usage) VALUES ('asset-unified', 'project-main', 'output', '统一任务原图.png', 'outputs/unified.png', 'shot_source')").run();
db.prepare("INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status, unifiedModel, unifiedTaskId) VALUES ('shared-business-id', 'project-main', 'asset-unified', 'provider-fixture', 'image2-medium', '', 'succeeded', 'image2', 'media-boundary')").run();
db.prepare("INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status) VALUES ('tail_task_503', 'project-tail', 'asset-tail', 'provider-fixture', 'gpt-image-2', '', 'succeeded')").run();
db.prepare("INSERT INTO jobs (id, projectId, inputImageId, providerId, model, prompt, status) VALUES ('task-plain-030', 'project-main', 'asset-unified', 'provider-fixture', 'gpt-image-2', '', 'pending')").run();

let readySeq = 0;
function insertOperation(input: {
  id: string; actorUserId: string; status: string; taskId: string; updatedAt: string;
  module?: string; step?: string; waitReason?: string | null; scopeId?: string;
  mediaTaskId?: string | null; channelKey?: string | null;
  providerSnapshot?: unknown; quoteJson?: string;
}): void {
  readySeq += 1;
  db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
    createdAt, updatedAt, mediaTaskId, channelKey
  ) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, 'r1', ?, 1, ?, '{}',
    'image.submit', ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id, `key-${input.id}`, input.actorUserId, input.scopeId ?? 'project-main',
      input.module ?? 'image', input.taskId, input.step ?? 'submit',
      `business-${input.id}`, `hash-${input.id}`,
      JSON.stringify(input.providerSnapshot ?? { name: '分页验收供应商', model: 'gpt-image-2' }),
      input.quoteJson ?? '{"kind":"priced"}',
      input.status, input.waitReason ?? null, readySeq,
      input.updatedAt, input.updatedAt, input.mediaTaskId ?? null, input.channelKey ?? null,
    );
}

function insertAttempt(input: {
  id: string; operationId: string; actorUserId: string; createdAt: string;
  providerSnapshot?: unknown; costState: 'reserved' | 'unknown' | 'settled' | 'released';
  reservedMinor: number; actualMinor: number | null; terminalState?: string | null;
  submissionState?: string; intentJournalSeq?: number | null; transportSeq?: number;
}): void {
  const transportSeq = input.transportSeq ?? 1;
  db.prepare(`INSERT INTO execution_attempts (
    id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
    providerSnapshotJson, pricingSnapshotJson, submissionState, terminalState,
    instanceId, fence, leaseOwner, leaseUntil, remoteId, receiptJson,
    intentJournalSeq, receiptJournalSeq, errorCode, policyVersion, accountingPeriod,
    currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, NULL, ?, ?, 'pagination-test', 1, 'test', ?, NULL, NULL,
    ?, NULL, NULL, 1, '2026-11', 'CNY', ?, ?, ?, ?, ?)`)
    .run(
      input.id, input.operationId, `permit-${input.id}`, input.actorUserId, transportSeq,
      JSON.stringify(input.providerSnapshot ?? { name: '分页验收供应商', model: 'gpt-image-2' }),
      input.submissionState ?? 'terminal', input.terminalState ?? 'succeeded',
      input.createdAt, input.intentJournalSeq === undefined ? transportSeq : input.intentJournalSeq,
      input.reservedMinor, input.actualMinor, input.costState, input.createdAt, input.createdAt,
    );
}

// ── 统一制作任务：3 条执行记录（放在第 25 个位置——pageSize=25 的页边界） ──
const UNIFIED_LATEST = iso(TODAY_BASE - minutes(25));
db.prepare(`INSERT INTO execution_media_tasks (
  id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
  inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
  status, currentChannelKey, createdAt, updatedAt
) VALUES ('media-boundary', 'image:shared-business-id', ?, 'project', 'project-main', 'image',
  'shared-business-id', 'image2', 'rules-v1', 'hash-unified', '{}', '{}', 'project_scene',
  'project-main', '{}', 'succeeded', 'qiniu', '2026-10-01T00:00:00.000Z', ?)`)
  .run(alice.principal.userId, UNIFIED_LATEST);
for (const [channelKey, channelModel, attemptCost] of [
  ['qiniu', 'qiniuyun/gpt-image-2-medium', { costState: 'released', reservedMinor: 25, actualMinor: null }],
  ['tencent', 'image2-medium', { costState: 'settled', reservedMinor: 158, actualMinor: 158 }],
  ['backup', 'backup-image-model', { costState: 'settled', reservedMinor: 40, actualMinor: 40 }],
] as const) {
  const position = channelKey === 'qiniu' ? 1 : channelKey === 'tencent' ? 2 : 3;
  const operationId = `op-unified-${position}`;
  const operationUpdatedAt = iso(TODAY_BASE - minutes(25 + position - 1));
  insertOperation({
    id: operationId, actorUserId: alice.principal.userId,
    status: channelKey === 'qiniu' ? 'failed' : 'succeeded',
    taskId: 'shared-business-id', module: 'image', step: 'submit',
    mediaTaskId: 'media-boundary', channelKey,
    updatedAt: operationUpdatedAt,
    providerSnapshot: { name: `${channelKey} 通道`, model: channelModel },
  });
  db.prepare(`INSERT INTO execution_media_channels (
    id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
    state, executionRevision, operationId, createdAt, updatedAt
  ) VALUES (?, 'media-boundary', ?, 'providers', ?, ?, ?, ?, 1, ?, '2026-10-01T00:00:00.000Z', ?)`)
    .run(`media-boundary:${channelKey}`, channelKey, `provider-${channelKey}`, channelModel,
      position - 1, channelKey === 'qiniu' ? 'failed' : 'succeeded', operationId, operationUpdatedAt);
  insertAttempt({
    id: `attempt-unified-${position}`, operationId, actorUserId: alice.principal.userId,
    createdAt: operationUpdatedAt,
    providerSnapshot: { name: `${channelKey} 通道`, model: channelModel },
    terminalState: channelKey === 'qiniu' ? 'failed' : 'succeeded',
    intentJournalSeq: position,
    ...attemptCost,
  });
}

// ── 502 个普通制作任务（各 1 条执行记录） ──
const tailOperationId = 'op-tail-503';
const decoyTaskId = 'tailXtaskX503';
const SAME_UPDATED_AT = iso(TODAY_BASE - minutes(40));
for (let position = 1; position <= 503; position += 1) {
  if (position === 25) continue; // 统一任务占位
  const operationId = position === 503 ? tailOperationId : `op-plain-${String(position).padStart(3, '0')}`;
  const taskId = position === 503 ? 'tail_task_503' : position === 300 ? decoyTaskId : `task-plain-${String(position).padStart(3, '0')}`;
  const actor = position === 503 ? carol.principal.userId
    : position === 501 || position === 502 ? bob.principal.userId
      : alice.principal.userId;
  const isRequeued = position === 30;
  const isCanceled = position === 31;
  insertOperation({
    id: operationId,
    actorUserId: actor,
    status: isRequeued ? 'failed' : isCanceled ? 'pending' : 'succeeded',
    taskId,
    step: position === 503 ? 'analyze' : 'submit',
    scopeId: position === 503 ? 'project-tail' : 'project-main',
    waitReason: isCanceled ? 'stage_canceled' : null,
    updatedAt: position >= 40 && position <= 49 ? SAME_UPDATED_AT : positionTime(position),
    providerSnapshot: position === 503
      ? { name: '末页专属供应商', model: 'search-only-model-77' }
      : { name: '分页验收供应商', model: 'gpt-image-2' },
  });
}

// 搜索必须能命中「组内旧通道」：最旧的那条统一任务记录只存在于尝试/记录快照里。
db.prepare("UPDATE execution_operations SET providerSnapshotJson = ? WHERE id = 'op-unified-1'")
  .run(JSON.stringify({ name: '旧通道专属供应商', model: 'legacy-channel-model' }));

// ── 另一条 500 上限 + 重名业务 taskId：501 个更新的统一任务（不产生执行记录） ──
for (let index = 0; index < 501; index += 1) {
  const id = `media-decoy-${String(index).padStart(3, '0')}`;
  const createdAt = iso(Date.parse('2026-10-20T00:00:00.000Z') + index * 1000);
  db.prepare(`INSERT INTO execution_media_tasks (
    id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
    inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
    status, currentChannelKey, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', 'project-main', 'image', 'shared-business-id', 'image2',
    'rules-v1', ?, '{}', '{}', 'project_scene', 'project-main', '{}', 'succeeded', 'tencent', ?, ?)`)
    .run(id, `image:shared-business-id:${id}`, alice.principal.userId, `hash-${id}`, createdAt, createdAt);
  db.prepare(`INSERT INTO execution_media_channels (
    id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
    state, executionRevision, operationId, createdAt, updatedAt
  ) VALUES (?, ?, 'tencent', 'providers', 'provider-tencent', 'image2-medium', 1, 'succeeded', 1, NULL, ?, ?)`)
    .run(`${id}:tencent`, id, createdAt, createdAt);
}

try {
  // ── 3. 分页选组：503 个制作任务 / 505 条执行记录 ─────────────────────────────
  const firstPage = listTeamTasks(db, adminView);
  assert.deepEqual(firstPage.pagination, { page: 1, pageSize: 25, total: 503, totalPages: 21 });
  assert.equal(firstPage.totalRecords, 505, 'totalRecords 是匹配组内执行记录总数');
  assert.equal(firstPage.items.length, 27, '第 1 页有 24 个单记录组 + 统一任务的 3 条执行记录');
  assert.equal(firstPage.localAgentIncluded, false, '保留 localAgentIncluded 字段');
  assert.equal(firstPage.items.filter(item => item.unifiedTaskId === 'media-boundary').length, 3,
    '统一任务整组只出现在一页，且 3 条执行记录都在');

  const byPageSize = (pageSize: 25 | 50) => {
    const pages: Array<ReturnType<typeof listTeamTasks>> = [];
    for (let page = 1; ; page += 1) {
      const result = listTeamTasks(db, adminView, {}, { page, pageSize });
      pages.push(result);
      assert.equal(result.pagination.total, 503, '总数不随页变化');
      assert.equal(result.pagination.totalPages, pageSize === 25 ? 21 : 11);
      assert.equal(result.totalRecords, 505, 'totalRecords 不随页变化');
      if (page >= result.pagination.totalPages) break;
    }
    return pages;
  };

  const pages25 = byPageSize(25);
  assert.equal(pages25.length, 21);
  assert.equal(pages25[20].items.length, 3, 'pageSize=25 末页 3 个制作任务');
  assert.deepEqual(pages25[20].items.map(item => item.operationId).sort(), ['op-plain-501', 'op-plain-502', tailOperationId]);
  const ids25 = pages25.flatMap(page => page.items.map(item => item.operationId));
  assert.equal(ids25.length, 505, '遍历 21 页恰好覆盖 505 条执行记录，无重复');
  assert.equal(new Set(ids25).size, 505, '执行记录 ID 集合恰好等于完整授权集合');
  const unifiedPages = pages25.filter(page => page.items.some(item => item.unifiedTaskId === 'media-boundary'));
  assert.equal(unifiedPages.length, 1, '统一任务整组只在一页出现一次');
  assert.equal(unifiedPages[0].pagination.page, 1, '统一任务按组落在页边界（第 25 个制作任务）');
  assert.equal(unifiedPages[0].items.filter(item => item.unifiedTaskId === 'media-boundary').length, 3);

  const pages50 = byPageSize(50);
  assert.equal(pages50.length, 11);
  assert.equal(pages50[10].items.length, 3, 'pageSize=50 末页 3 个制作任务');
  const ids50 = pages50.flatMap(page => page.items.map(item => item.operationId));
  assert.equal(new Set(ids50).size, 505, '25/50 两档遍历结果相同');
  assert.equal(pages50[0].items.length, 52, '一页 50 个制作任务可返回多于 50 条执行记录');
  console.log('PASS: 503 groups / 505 records paginate into 21 and 11 pages, unified group never splits');

  // ── 4. 同 updatedAt 稳定排序 + 越界页 ────────────────────────────────────────
  const page2 = pages25[1];
  const sameTime = page2.items.filter(item => item.updatedAt === SAME_UPDATED_AT);
  assert.equal(sameTime.length, 10, '10 个制作任务共用同一个 updatedAt');
  assert.deepEqual(
    sameTime.map(item => item.operationId),
    Array.from({ length: 10 }, (_, index) => `op-plain-${String(49 - index).padStart(3, '0')}`),
    '同一时间按稳定组 ID 倒序，不随查询抖动',
  );
  const outOfRange = listTeamTasks(db, adminView, {}, { page: 999, pageSize: 25 });
  assert.equal(outOfRange.pagination.page, 21, '越界页归到有效末页并返回实际 page');
  assert.equal(outOfRange.items.length, 3);
  assert.equal(listTeamTasks(db, adminView, {}, { page: 999, pageSize: 50 }).pagination.page, 11);
  const emptyResult = listTeamTasks(db, adminView, { q: 'ZZZ-没有这个任务' });
  assert.deepEqual(emptyResult.pagination, { page: 1, pageSize: 25, total: 0, totalPages: 1 });
  assert.equal(emptyResult.totalRecords, 0);
  assert.deepEqual(emptyResult.items, []);
  assert.throws(() => listTeamTasks(db, adminView, {}, { page: '0' }), (error: unknown) => (error as { status?: number }).status === 400);
  assert.throws(() => listTeamTasks(db, adminView, {}, { pageSize: 30 }), (error: unknown) => (error as { status?: number }).status === 400);
  console.log('PASS: stable tie ordering, out-of-range clamp and empty/invalid pagination');

  // ── 5. 搜索覆盖完整历史 ─────────────────────────────────────────────────────
  const searchTotals = (q: string) => listTeamTasks(db, adminView, { q });
  for (const [query, expectedOperation] of [
    ['末页专用', tailOperationId],
    ['末页专用素材', tailOperationId],
    ['search-only-model-77', tailOperationId],
    ['素材分析', tailOperationId],
    ['新场景图生成', tailOperationId],
    ['0999', tailOperationId],
    [tailOperationId, tailOperationId],
  ] as const) {
    const result = searchTotals(query);
    assert.equal(result.pagination.total, 1, `关键词「${query}」只能命中第 503 个任务`);
    assert.equal(result.totalRecords, 1);
    assert.deepEqual(result.items.map(item => item.operationId), [expectedOperation], `关键词「${query}」命中正确任务`);
  }
  assert.equal(searchTotals('  SEARCH-ONLY-MODEL-77  ').pagination.total, 1, '大小写不敏感且首尾去空格');
  assert.equal(searchTotals('shared-business-id').pagination.total, 1, '搜索整组业务任务号只命中一个制作任务');
  const unifiedDisplayHit = searchTotals('  IMAGE 2  ');
  assert.equal(unifiedDisplayHit.pagination.total, 1, '统一模型按界面显示名搜索，不要求知道通道模型编号');
  assert.equal(unifiedDisplayHit.totalRecords, 3);
  assert.deepEqual(unifiedDisplayHit.items.map(item => item.operationId).sort(), ['op-unified-1', 'op-unified-2', 'op-unified-3']);
  assert.ok(unifiedDisplayHit.items.every(item => item.model === 'Image 2'), '搜索名称与任务列表模型名称一致');

  // `%`/`_`/引号按普通文字：不转义就会命中一大片或报错。
  assert.equal(searchTotals('50%').pagination.total, 1, '`%` 是普通文字，不是通配符');
  assert.equal(searchTotals("'A店'").pagination.total, 1, '引号按普通文字处理，不破坏 SQL');
  const taskIdSearch = searchTotals('tail_task_503');
  assert.equal(taskIdSearch.pagination.total, 1, '`_` 是普通文字，不是单字符通配符');
  assert.deepEqual(taskIdSearch.items.map(item => item.operationId), [tailOperationId]);
  assert.equal(searchTotals('tailXtaskX503').pagination.total, 1, '名字相近的任务仍各自可搜');

  // 组内旧通道命中 → 返回整组（不裁掉其它通道）。
  const legacyChannelHit = searchTotals('legacy-channel-model');
  assert.equal(legacyChannelHit.pagination.total, 1, '旧通道关键字命中整个制作任务');
  assert.equal(legacyChannelHit.totalRecords, 3);
  assert.deepEqual(legacyChannelHit.items.map(item => item.operationId).sort(), ['op-unified-1', 'op-unified-2', 'op-unified-3']);
  console.log('PASS: search covers full history, treats %/_/quotes literally and returns whole groups');

  // ── 6. 状态筛选与显示口径一致 ────────────────────────────────────────────────
  const pending = listTeamTasks(db, adminView, { status: 'pending' });
  assert.equal(pending.pagination.total, 1);
  assert.deepEqual(pending.items.map(item => item.operationId), ['op-plain-030'], 'failed 但业务任务已回队 → 读成排队中');
  const failed = listTeamTasks(db, adminView, { status: 'failed' });
  assert.equal(failed.pagination.total, 1, '统一任务按最新代表记录的失败状态入选，组整体返回');
  assert.equal(failed.totalRecords, 3, '切筛选不会丢掉组内关联记录');
  assert.deepEqual(failed.items.map(item => item.operationId).sort(), ['op-unified-1', 'op-unified-2', 'op-unified-3']);
  assert.equal(failed.items.find(item => item.operationId === 'op-unified-2')?.status, 'succeeded',
    '筛选只决定组是否入选，组内记录保留真实有效状态');
  const canceled = listTeamTasks(db, adminView, { status: 'canceled' });
  assert.equal(canceled.pagination.total, 1);
  assert.deepEqual(canceled.items.map(item => item.operationId), ['op-plain-031'], '取消在可见状态里是一个独立状态');
  const succeeded = listTeamTasks(db, adminView, { status: 'succeeded' });
  assert.equal(succeeded.pagination.total, 500);
  assert.equal(succeeded.totalRecords, 500, '最新代表记录失败时，旧通道成功不能让整组进入成功筛选');

  // 旧通道失败、新通道成功时，只按代表记录筛选；关键词仍可命中旧通道并返回整组。
  try {
    db.prepare("UPDATE execution_operations SET updatedAt = ? WHERE id = 'op-unified-2'")
      .run(iso(TODAY_BASE - minutes(24)));
    assert.equal(listTeamTasks(db, adminView, { status: 'failed' }).pagination.total, 0,
      '新通道成功后不再把旧通道失败当成任务组当前失败');
    const fallbackSucceeded = listTeamTasks(db, adminView, { status: 'succeeded', q: 'legacy-channel-model' });
    assert.equal(fallbackSucceeded.pagination.total, 1, '状态匹配代表记录、关键词匹配组内任一记录');
    assert.equal(fallbackSucceeded.totalRecords, 3);
    assert.equal(fallbackSucceeded.items[0]?.operationId, 'op-unified-2');
    assert.equal(fallbackSucceeded.items[0]?.status, 'succeeded');
    assert.deepEqual(fallbackSucceeded.items.map(item => item.operationId).sort(), ['op-unified-1', 'op-unified-2', 'op-unified-3']);

    db.prepare("UPDATE execution_operations SET updatedAt = ? WHERE id = 'op-unified-2'").run(UNIFIED_LATEST);
    const tied = listTeamTasks(db, adminView, { status: 'succeeded', q: 'legacy-channel-model' });
    assert.equal(tied.pagination.total, 1);
    assert.equal(tied.items[0]?.operationId, 'op-unified-2', '同 updatedAt 时按 operationId DESC 选代表，与列表顺序一致');
    assert.equal(tied.items[0]?.status, 'succeeded');
    assert.equal(listTeamTasks(db, adminView, { status: 'failed', q: 'legacy-channel-model' }).pagination.total, 0,
      '同时间的旧失败通道不能绕过代表记录状态筛选');
  } finally {
    db.prepare("UPDATE execution_operations SET updatedAt = ? WHERE id = 'op-unified-2'")
      .run(iso(TODAY_BASE - minutes(26)));
  }
  console.log('PASS: status filtering uses effective status and keeps each matched group complete');

  // ── 7. 权限：管理员全员/单成员、员工本人、越权 ──────────────────────────────
  assert.deepEqual(countTeamTasks(db, adminView), { tasks: 503, records: 505 });
  assert.deepEqual(countTeamTasks(db, aliceView), { tasks: 500, records: 502 });
  assert.deepEqual(countTeamTasks(db, bobView), { tasks: 2, records: 2 });
  assert.deepEqual(countTeamTasks(db, carolView), { tasks: 1, records: 1 });
  assert.equal(listTeamTasks(db, adminView, { actorUserId: bob.principal.userId }).pagination.total, 2);
  assert.equal(listTeamTasks(db, aliceView).pagination.total, 500, '员工只看到本人的制作任务');
  assert.equal(listTeamTasks(db, bobView, { q: '0999' }).pagination.total, 0, '搜索不泄漏其他成员的任务');
  assert.equal(listTeamTasks(db, adminView, { q: '0999' }).pagination.total, 1);
  assert.throws(
    () => listTeamTasks(db, aliceView, { actorUserId: bob.principal.userId }),
    (error: unknown) => (error as { status?: number }).status === 403,
    '员工不能按别人筛选',
  );
  assert.deepEqual(readWorkspaceBadgeCounts(db, adminView), { tasks: 505, errors: 0 },
    '侧栏任务角标是全可见范围的执行记录数（505，不是 25/500）');
  assert.equal(readWorkspaceBadgeCounts(db, aliceView).tasks, 502);
  assert.equal(readWorkspaceBadgeCounts(db, bobView).tasks, 2);
  console.log('PASS: admin/member/employee scopes stay correct and badges read full-range counts');

  // ── 8. 总览/首页的独立聚合不依赖当前页 ──────────────────────────────────────
  const activity = readTeamTaskActivity(db, adminView, now);
  assert.deepEqual(activity.counts, { total: 505, running: 0, queued: 1, completedToday: 99, failed: 1, canceled: 1 });
  const allRecords: Awaited<ReturnType<typeof listTeamTasks>>['items'] = [];
  for (const page of pages25) allRecords.push(...page.items);
  allRecords.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || right.operationId.localeCompare(left.operationId));
  const pureCounts = consoleTaskCounts(allRecords, now);
  assert.deepEqual(
    activity.counts,
    { ...pureCounts, canceled: 1 },
    'SQL 分桶聚合与纯函数口径完全一致（含「今天完成」按上海时区）',
  );
  assert.deepEqual(
    consoleMemberRows(activity.members),
    consoleMemberActivity(allRecords, now),
    '成员统计与逐条计算的纯函数一致',
  );
  // 真实 SQLite 执行时计数快照求值，防止 LIMIT 前为全部历史任务读取大快照。
  let snapshotReads = 0;
  db.function('test_recent_snapshot', value => { snapshotReads++; return value; });
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => originalPrepare(sql.replace(
    'o.inputSnapshotJson, o.providerSnapshotJson',
    'test_recent_snapshot(o.inputSnapshotJson) AS inputSnapshotJson, o.providerSnapshotJson',
  ))) as typeof db.prepare;
  let recent: ReturnType<typeof listRecentTeamTasks>['items'];
  try {
    recent = listRecentTeamTasks(db, adminView, 12).items;
    assert.equal(snapshotReads, 12, '最近 12 条只能读取 12 份快照，不能先加载历史明细再排序');
    snapshotReads = 0;
    assert.equal(listRecentTeamTasks(db, bobView, 12).items.length, 2);
    assert.equal(snapshotReads, 2, '员工授权范围先于选取最近记录');
  } finally { db.prepare = originalPrepare; }
  assert.deepEqual(recent.map(item => item.operationId), recentConsoleTasks(allRecords, now).map(row => row.operationId),
    '最近任务是有界查询，且与纯函数同口径同顺序');
  const inFlight = listTeamTaskRecords(db, adminView, {
    actorUserId: alice.principal.userId, statuses: IN_FLIGHT_STATUSES, limit: 5,
  });
  assert.equal(inFlight.total, 1, '首页在飞任务总数由 COUNT 得到');
  assert.deepEqual(inFlight.items.map(item => item.operationId), ['op-plain-030'], 'failed 但已回队 → 算在飞');
  console.log('PASS: overview aggregates and bounded recent lists do not depend on the current page');

  // ── 9. 本页统一任务的费用/通道计数（按 mediaTaskId 定向） ────────────────────
  const unifiedItems = unifiedPages[0].items.filter(item => item.unifiedTaskId === 'media-boundary');
  for (const item of unifiedItems) {
    assert.equal(item.unifiedTaskCostMinor, 198, '费用按 mediaTaskId 定向：不取被 500 截断的其它统一任务');
    assert.equal(item.unifiedTaskCostStatus, 'settled');
    assert.equal(item.unifiedTaskAttemptCount, 3, '3 次真实通道调用');
    assert.equal(item.unifiedTaskChannelCount, 3, '3 条通道');
  }
  const employeeUnified = listTeamTasks(db, aliceView, { q: 'shared-business-id' }).items;
  assert.equal(employeeUnified.length, 3);
  assert.ok(employeeUnified.every(item => item.providerName === 'Image 2' && item.model === 'Image 2'),
    '员工看到的统一任务不展开真实通道路由');
  const directedAdmin = queryUnifiedTaskUsageByMediaTaskIds(db, adminView, ['media-boundary']);
  assert.equal(directedAdmin.size, 1);
  assert.equal(directedAdmin.get('media-boundary')?.chargedMinor, 198);
  assert.equal(directedAdmin.get('media-boundary')?.channels?.length, 3, '管理员定向查询保留通道明细');
  assert.equal(queryUnifiedTaskUsageByMediaTaskIds(db, aliceView, ['media-boundary']).get('media-boundary')?.channels, undefined,
    '员工定向查询同样脱敏');
  assert.equal(queryUnifiedTaskUsageByMediaTaskIds(db, bobView, ['media-boundary']).size, 0,
    '员工不能通过定向查询读到别人的统一任务');
  assert.equal(queryUnifiedTaskUsageByMediaTaskIds(db, adminView, ['media-missing']).size, 0);
  console.log('PASS: page-level unified costs use mediaTaskId and survive the other 500-limit');

  // ── 10. 详情：500 条之外可读、404/400 语义 ──────────────────────────────────
  const oldDetail = findTeamTask(db, adminView, tailOperationId);
  assert.equal(oldDetail?.operationId, tailOperationId, '500 条之外（第 505 条）的旧执行记录可读');
  assert.equal(findTeamTask(db, aliceView, tailOperationId), null, '员工读不到别人的任务（路由按 404）');
  assert.equal(findTeamTask(db, carolView, tailOperationId)?.actorUserId, carol.principal.userId);
  assert.equal(findTeamTask(db, adminView, 'op-does-not-exist'), null);
  assert.equal(taskIdFromQuery('../../etc/passwd'), null, '格式错误的任务号按 400 处理');
  assert.equal(taskIdFromQuery(`  ${tailOperationId}  `), tailOperationId);
  console.log('PASS: detail lookup by operation id ignores page/filters and keeps permissions');

  // ── 11. 路由级合同（真实会话 + 真实响应形状） ───────────────────────────────
  const adminList = await tasksRoute.GET(request(tasksUrl(''), adminCookie));
  assert.equal(adminList.status, 200, await adminList.clone().text());
  const adminBody = await adminList.json() as {
    items: Array<{ operationId: string; status: string; unifiedTaskId: string | null }>;
    localAgentIncluded: boolean; totalRecords: number;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
  assert.equal(adminBody.localAgentIncluded, false);
  assert.deepEqual(adminBody.pagination, { page: 1, pageSize: 25, total: 503, totalPages: 21 });
  assert.equal(adminBody.totalRecords, 505);
  assert.equal(adminBody.items.length, 27);
  const countsRoute = await import('../app/api/team/workspace-counts/route.ts');
  const countsUrl = 'https://studio.example.test/api/team/workspace-counts';
  for (const [cookie, expected] of [[adminCookie, 505], [alice.cookie, 502], [bob.cookie, 2]] as const) {
    const response = await countsRoute.GET(request(countsUrl, cookie));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const counts = await response.json();
    assert.deepEqual(counts, { tasks: expected, errors: 0 }, '角标接口只返回当前身份可见计数');
    assert.equal(workspaceBadgeCounts(counts).tasks, expected);
    assert.ok(JSON.stringify(counts).length < 80, '侧栏不能为计数下载任务快照或列表明细');
  }
  const forgedCounts = await countsRoute.GET(request(`${countsUrl}?actorUserId=${bob.principal.userId}`, alice.cookie));
  assert.deepEqual(await forgedCounts.json(), { tasks: 502, errors: 0 }, '客户端参数不能改变角标授权范围');
  assert.equal((await countsRoute.GET(request(countsUrl, ''))).status, 401);


  const fifty = await (await tasksRoute.GET(request(tasksUrl('pageSize=50&page=11'), adminCookie))).json() as typeof adminBody;
  assert.deepEqual(fifty.pagination, { page: 11, pageSize: 50, total: 503, totalPages: 11 });
  assert.equal(fifty.items.length, 3, '末页 3 个制作任务');

  const clamped = await (await tasksRoute.GET(request(tasksUrl('page=999'), adminCookie))).json() as typeof adminBody;
  assert.equal(clamped.pagination.page, 21, '前端按响应收敛到实际页');
  assert.equal(clamped.items.length, 3);

  const tailSearch = await (await tasksRoute.GET(request(tasksUrl(`q=${encodeURIComponent('末页专用')}`), adminCookie))).json() as typeof adminBody;
  assert.equal(tailSearch.pagination.total, 1);
  assert.deepEqual(tailSearch.items.map(item => item.operationId), [tailOperationId]);

  const statusPending = await (await tasksRoute.GET(request(tasksUrl('status=pending'), adminCookie))).json() as typeof adminBody;
  assert.deepEqual(statusPending.items.map(item => item.operationId), ['op-plain-030']);
  const statusFailed = await (await tasksRoute.GET(request(tasksUrl('status=failed'), adminCookie))).json() as typeof adminBody;
  assert.equal(statusFailed.pagination.total, 1);
  assert.equal(statusFailed.items.length, 3, '路由也返回整组记录');

  const employeeList = await (await tasksRoute.GET(request(tasksUrl(''), alice.cookie))).json() as typeof adminBody;
  assert.equal(employeeList.pagination.total, 500);
  assert.equal(employeeList.totalRecords, 502);
  const bobList = await (await tasksRoute.GET(request(tasksUrl(''), bob.cookie))).json() as typeof adminBody;
  assert.equal(bobList.pagination.total, 2);
  const forbidden = await tasksRoute.GET(request(tasksUrl(`actorUserId=${encodeURIComponent(alice.principal.userId)}`), bob.cookie));
  assert.equal(forbidden.status, 403, '员工不能按别人筛选');

  for (const [query, errorCode] of [['page=0', 'page_invalid'], ['page=-1', 'page_invalid'], ['page=abc', 'page_invalid'], ['pageSize=30', 'page_size_invalid']] as const) {
    const response = await tasksRoute.GET(request(tasksUrl(query), adminCookie));
    assert.equal(response.status, 400, `${query} 必须 400`);
    const body = await response.json() as { error: string };
    assert.equal(body.error, errorCode);
  }
  const emptyBody = await (await tasksRoute.GET(request(tasksUrl(`q=${encodeURIComponent('ZZZ-没有这个任务')}`), adminCookie))).json() as typeof adminBody;
  assert.deepEqual(emptyBody.pagination, { page: 1, pageSize: 25, total: 0, totalPages: 1 });
  assert.deepEqual(emptyBody.items, []);
  console.log('PASS: task route returns pagination/totalRecords and validates parameters');

  const detailAdmin = await detailRoute.GET(request(detailUrl(`?taskId=${tailOperationId}`), adminCookie));
  assert.equal(detailAdmin.status, 200, await detailAdmin.clone().text());
  assert.equal(((await detailAdmin.json()) as { item: { operationId: string } }).item.operationId, tailOperationId);
  const detailAlice = await detailRoute.GET(request(detailUrl(`?taskId=${tailOperationId}`), alice.cookie));
  assert.equal(detailAlice.status, 404, '员工直查他人详情 404');
  const detailMissing = await detailRoute.GET(request(detailUrl('?taskId=op-does-not-exist'), adminCookie));
  assert.equal(detailMissing.status, 404);
  const detailBad = await detailRoute.GET(request(detailUrl('?taskId=%2E%2E%2Fetc%2Fpasswd'), adminCookie));
  assert.equal(detailBad.status, 400, '格式错误的任务编号 400');
  console.log('PASS: detail route reads beyond 500 by taskId and keeps 404/400 semantics');

  console.log('\nteam task pagination contract passed');
} finally {
  adminSession.token = '';
  setTeamAuthServiceForTests(null);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
