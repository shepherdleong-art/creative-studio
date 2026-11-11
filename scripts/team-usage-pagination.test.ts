// 04 号票：团队用量服务端分页与汇总的合同（真实 SQLite + 真实会话 + 真实路由）。
//
// 固定数据（功能方案第 8 节）：503 个统一制作任务，每个一次已结算 25 分调用
// = 12,575 分；再给其中一个任务增加一次真实调用 40 分 → 仍 503 个制作任务、
// 504 条通道调用、12,615 分，该任务 65 分，备用未提交通道不增加调用数。
// 另造 released/estimated/uncertain/unpriced/mixed/未提交/跨账期父任务/旧非统一
// 模型/孤儿关联/另一成员任务，验证：
// - section=summary 只返回摘要（额度、totals、counts、模型排行、趋势、成员、模型选项），
//   不携带全量任务/尝试数组；翻页/切 section 后摘要与 CSV 金额不变；
// - tasks/channels/legacy/unmapped 各自分页，25/50 两档遍历完整无重复；
// - channels/legacy/unmapped 用数据库真实父任务身份互斥分类：父任务在别页、
//   第 503 条或创建于另一账期都不是未映射；真实缺失父任务才是 unmapped；
// - 摘要/成员/CSV 对完整筛选范围求值，额度卡仍是自然月口径；模型选项取授权范围
//   完整候选，不被当前筛选或分页裁剪；
// - 查询/模型/结果/日期/成员筛选下 section total 与摘要 counts 一致；
// - 同 createdAt 按 ID 稳定排序；空态/越界页/非法 section 与分页参数；
// - 员工只拿本人摘要/明细、任务不带统一通道内部字段，channels/unmapped 直接 403；
// - CSV 保留原字段、忽略 page/pageSize、覆盖第 503 个任务的记录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageDateLabel } from '../lib/usage-date-range.ts';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-usage-pagination-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-usage-pagination',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_SERVER_RELEASE_ID: 'server-release-usage-pagination',
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
  listTeamUsageAttempts,
  queryTeamUsage,
  queryTeamUsageCounts,
  queryTeamUsageSummary,
  queryTeamUsageTotals,
} = await import('../lib/team-service/usage.ts');
const { listTeamUnifiedUsageTasks, queryUnifiedTaskUsage } = await import('../lib/team-service/unified-usage.ts');
const { TEAM_USAGE_SECTIONS } = await import('../lib/team-service/usage-sections.ts');
const usageRoute = await import('../app/api/team/usage/route.ts');
const exportRoute = await import('../app/api/team/usage/export/route.ts');

ensureServerDeploymentMarker({
  mode: 'server', dataRoot: root, hostname: '127.0.0.1', port: 3300,
  deploymentId: 'deployment-usage-pagination', trustedOrigin: 'https://studio.example.test',
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
await service.changeOwnPassword(adminLogin.principal, initialized.credential, 'admin-usage-pagination-password');
const adminSession = await service.login({ employeeId: '0000', password: 'admin-usage-pagination-password' });
const admin = adminSession.principal;
const adminCookie = sessionCookie(adminSession.token).split(';', 1)[0];

async function account(employeeId: string, displayName: string) {
  const created = await service.createUser(admin, { employeeId, displayName, role: 'employee' });
  const login = await service.login({ employeeId, password: created.credential });
  await service.changeOwnPassword(login.principal, created.credential, `${employeeId}-usage-pagination-password`);
  const authenticated = await service.login({ employeeId, password: `${employeeId}-usage-pagination-password` });
  return {
    principal: authenticated.principal,
    cookie: sessionCookie(authenticated.token).split(';', 1)[0],
  };
}
const alice = await account('0001', '张三');
const bob = await account('0002', '李四');

const adminView = { userId: admin.userId, role: 'admin' as const };
const aliceView = { userId: alice.principal.userId, role: 'employee' as const };
const bobView = { userId: bob.principal.userId, role: 'employee' as const };

// 额度卡用例：三人都是不限额（自然月口径只看真实月度预留）。
const { readActorPolicy, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
for (const userId of [admin.userId, alice.principal.userId, bob.principal.userId]) {
  updateActorPolicy(db, {
    actorId: userId, monthlyLimitMinor: null, personalConcurrency: 5,
    paused: false, expectedVersion: readActorPolicy(db, userId).version,
  });
}

function request(url: string, cookie: string): Request {
  const headers = new Headers();
  headers.set('Cookie', cookie);
  headers.set('Origin', 'https://studio.example.test');
  headers.set('x-csrf-token', 'csrf-test');
  headers.set('x-creative-studio-client-version', '0.7.1');
  headers.set('x-creative-studio-client-api', '1');
  return new Request(url, { headers });
}
const usageUrl = (query = '') => `https://studio.example.test/api/team/usage${query ? `?${query}` : ''}`;
const exportUrl = (query = '') => `https://studio.example.test/api/team/usage/export${query ? `?${query}` : ''}`;

// ── 时间与筛选范围（上海时区；显式 from/to，不依赖当前时钟） ────────────────────
const TODAY_BASE = Date.parse('2026-11-11T10:00:00.000Z'); // 上海 11-11 18:00，算「今天」
const OLD_BASE = Date.parse('2026-11-09T10:00:00.000Z'); // 上海 11-09 18:00
const SPECIAL_BASE = Date.parse('2026-11-10T04:00:00.000Z'); // 上海 11-10 12:00
const FIXED_NOW = new Date('2026-11-11T04:00:00.000Z'); // 上海 11-11 12:00
const minutes = (count: number) => count * 60_000;
const iso = (time: number) => new Date(time).toISOString();
const pad = (value: number) => String(value).padStart(3, '0');
// 位置 i（从 1 开始，越小越新）：1–100 落在今天，101 之后落在 11-09。
function positionTime(position: number): string {
  return position <= 100
    ? iso(TODAY_BASE - minutes(position))
    : iso(OLD_BASE - minutes(position - 100));
}
const RANGE_NOV = { from: '2026-10-31T16:00:00.000Z', to: '2026-11-30T16:00:00.000Z' }; // 上海 11 月
const RANGE_OCT = { from: '2026-09-30T16:00:00.000Z', to: '2026-10-31T16:00:00.000Z' }; // 上海 10 月
const RANGE_TODAY = { from: '2026-11-10T16:00:00.000Z', to: '2026-11-11T16:00:00.000Z' }; // 上海 11-11
const CURRENT_PERIOD = usageDateLabel(FIXED_NOW).slice(0, 7);
const PREVIOUS_PERIOD = (() => {
  const date = new Date(`${CURRENT_PERIOD}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
})();

// ── 基础业务表与插入助手（直接写真实结构，造 >500 条历史） ─────────────────────
const PROJECT_ID = 'project-usage';
db.prepare("INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES ('provider-usage', '用量验收供应商', 'http://127.0.0.1:9', 'fixture', 'image2-medium')").run();
db.prepare("INSERT INTO projects (id, name, providerId, model, prompt, status) VALUES (?, '团队用量分页项目', 'provider-usage', 'image2-medium', '', 'draft')").run(PROJECT_ID);

let readySeq = 0;
function insertOperation(input: {
  id: string; actorUserId: string; taskId: string; createdAt: string;
  mediaTaskId?: string | null; channelKey?: string | null;
  status?: string; step?: string; module?: string;
  providerSnapshot?: unknown; quoteJson?: string;
}): void {
  readySeq += 1;
  db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, waitReason, readySeq,
    createdAt, updatedAt, mediaTaskId, channelKey
  ) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, 'r1', ?, 1, ?, '{}', 'image.submit', ?, '[]', ?,
    ?, NULL, ?, ?, ?, ?, ?)`)
    .run(
      input.id, `key-${input.id}`, input.actorUserId, PROJECT_ID,
      input.module ?? 'image', input.taskId, input.step ?? 'submit', `business-${input.id}`,
      `hash-${input.id}`, JSON.stringify(input.providerSnapshot ?? { model: 'image2-medium' }),
      input.quoteJson ?? '{"kind":"priced"}', input.status ?? 'succeeded', readySeq,
      input.createdAt, input.createdAt, input.mediaTaskId ?? null, input.channelKey ?? null,
    );
}

function insertAttempt(input: {
  id: string; operationId: string; actorUserId: string; createdAt: string;
  costState: 'reserved' | 'unknown' | 'settled' | 'released';
  reservedMinor: number; actualMinor: number | null;
  terminalState?: string | null; submissionState?: string;
  intentJournalSeq?: number | null; accountingPeriod?: string;
  providerSnapshot?: unknown;
}): void {
  // 真实账本里尝试会带一份与操作一致的 provider 快照；这里默认继承，保证统一模型可识别。
  const providerSnapshot = input.providerSnapshot ?? JSON.parse(
    db.prepare('SELECT providerSnapshotJson FROM execution_operations WHERE id = ?')
      .pluck().get(input.operationId) as string,
  ) as unknown;
  db.prepare(`INSERT INTO execution_attempts (
    id, operationId, permitId, actorId, businessAttemptNo, submitRound, transportSeq,
    providerSnapshotJson, pricingSnapshotJson, submissionState, terminalState,
    instanceId, fence, leaseOwner, leaseUntil, remoteId, receiptJson,
    intentJournalSeq, receiptJournalSeq, errorCode, policyVersion, accountingPeriod,
    currency, reservedMinor, actualMinor, costState, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, NULL, ?, ?, 'usage-pagination', 1, 'test', '2099-01-01T00:00:00.000Z',
    NULL, NULL, ?, NULL, NULL, 1, ?, 'CNY', ?, ?, ?, ?, ?)`)
    .run(
      input.id, input.operationId, `permit-${input.id}`, input.actorUserId,
      JSON.stringify(providerSnapshot),
      input.submissionState ?? 'terminal', input.terminalState ?? 'succeeded',
      input.intentJournalSeq === undefined ? 1 : input.intentJournalSeq,
      input.accountingPeriod ?? CURRENT_PERIOD,
      input.reservedMinor, input.actualMinor, input.costState, input.createdAt, input.createdAt,
    );
}

function insertMediaTask(input: {
  id: string; taskId: string; actorUserId: string; createdAt: string;
  updatedAt?: string; unifiedModel?: string; status?: string; module?: string;
}): void {
  db.prepare(`INSERT INTO execution_media_tasks (
    id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
    inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
    status, currentChannelKey, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', ?, ?, ?, ?, 'rules-v1', ?, '{}', '{}', 'project_scene',
    ?, '{}', ?, NULL, ?, ?)`)
    .run(
      input.id, `media:${input.id}`, input.actorUserId, PROJECT_ID,
      input.module ?? 'image', input.taskId, input.unifiedModel ?? 'image2',
      `hash-${input.id}`, PROJECT_ID, input.status ?? 'succeeded',
      input.createdAt, input.updatedAt ?? input.createdAt,
    );
}

function insertChannel(input: {
  mediaTaskId: string; channelKey: string; providerModel: string;
  state: string; operationId: string | null; priority: number;
  createdAt: string; remoteId?: string | null;
}): void {
  db.prepare(`INSERT INTO execution_media_channels (
    id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
    state, executionRevision, operationId, remoteId, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'providers', ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(
      `${input.mediaTaskId}:${input.channelKey}`, input.mediaTaskId, input.channelKey,
      `provider-${input.channelKey}`, input.providerModel, input.priority, input.state,
      input.operationId, input.remoteId ?? null, input.createdAt, input.createdAt,
    );
}

function insertCostReservation(input: {
  id: string; actorUserId: string; state: 'held' | 'settled';
  accountingPeriod: string; reservedMinor: number; actualMinor: number | null;
  costState: string;
}): void {
  db.prepare(`INSERT INTO execution_reservations (
    id, permitId, actorId, kind, poolKey, state, accountingPeriod, currency,
    reservedMinor, actualMinor, costState, policyVersion, createdAt
  ) VALUES (?, ?, ?, 'cost', 'fixture-pool', ?, ?, 'CNY', ?, ?, ?, 1, ?)`)
    .run(
      input.id, `permit-${input.id}`, input.actorUserId, input.state, input.accountingPeriod,
      input.reservedMinor, input.actualMinor, input.costState, FIXED_NOW.toISOString(),
    );
}

// 自然月口径：本月两条 + 上月一条，上月不得进入额度卡。
insertCostReservation({ id: 'reservation-alice-month', actorUserId: alice.principal.userId, state: 'settled', accountingPeriod: CURRENT_PERIOD, reservedMinor: 100, actualMinor: 100, costState: 'settled' });
insertCostReservation({ id: 'reservation-bob-held', actorUserId: bob.principal.userId, state: 'held', accountingPeriod: CURRENT_PERIOD, reservedMinor: 30, actualMinor: null, costState: 'reserved' });
insertCostReservation({ id: 'reservation-alice-previous', actorUserId: alice.principal.userId, state: 'settled', accountingPeriod: PREVIOUS_PERIOD, reservedMinor: 200, actualMinor: 200, costState: 'settled' });

// ── Phase A：503 个统一制作任务，每个一次已结算 25 分 ───────────────────────────
const BASE_TASKS = 503;
const SAME_TASK_TIME = iso(TODAY_BASE - minutes(40)); // 位置 40–49 共用同一创建时间
const TAIL_TASK_INDEX = 503;
function seedBaseTask(position: number): void {
  const mediaTaskId = `media-task-${pad(position)}`;
  const taskId = `task-usage-${pad(position)}`;
  const createdAt = position >= 40 && position <= 49 ? SAME_TASK_TIME : positionTime(position);
  insertMediaTask({ id: mediaTaskId, taskId, actorUserId: alice.principal.userId, createdAt });
  insertChannel({
    mediaTaskId, channelKey: 'tencent', providerModel: 'image2-medium', state: 'succeeded',
    operationId: `op-usage-${pad(position)}`, priority: 1, createdAt,
    remoteId: `remote-usage-${pad(position)}`,
  });
  insertOperation({
    id: `op-usage-${pad(position)}`, actorUserId: alice.principal.userId, taskId, createdAt,
    mediaTaskId, channelKey: 'tencent',
    providerSnapshot: {
      providerId: 'company-gateway-image2-medium', name: '腾讯通道',
      model: 'image2-medium', requestModel: 'image2-medium', unifiedModel: 'image2',
    },
  });
  insertAttempt({
    id: `attempt-usage-${pad(position)}`, operationId: `op-usage-${pad(position)}`,
    actorUserId: alice.principal.userId, createdAt,
    costState: 'settled', reservedMinor: 25, actualMinor: 25,
  });
}
db.transaction(() => {
  for (let position = 1; position <= BASE_TASKS; position += 1) seedBaseTask(position);
})();

function walkTaskItems(
  viewer: typeof adminView | typeof aliceView | typeof bobView,
  filters: { from?: string; to?: string; actorUserId?: string; model?: string; outcome?: 'succeeded' | 'failed' },
  pageSize: 25 | 50,
) {
  const items: Array<Awaited<ReturnType<typeof listTeamUnifiedUsageTasks>>['items'][number]> = [];
  let total = -1;
  for (let page = 1; ; page += 1) {
    const result = listTeamUnifiedUsageTasks(db, viewer, filters, { page, pageSize });
    items.push(...result.items);
    if (total === -1) total = result.pagination.total;
    assert.equal(result.pagination.total, total, '制作任务总数不随页变化');
    if (page >= result.pagination.totalPages) break;
  }
  return { items, total };
}

function walkAttemptItems(
  viewer: { userId: string; role: 'admin' | 'employee' },
  section: 'channels' | 'legacy' | 'unmapped',
  filters: { from?: string; to?: string; actorUserId?: string; model?: string; outcome?: 'succeeded' | 'failed'; module?: string },
  pageSize: 25 | 50,
) {
  const items: Array<Awaited<ReturnType<typeof listTeamUsageAttempts>>['items'][number]> = [];
  let total = -1;
  for (let page = 1; ; page += 1) {
    const result = listTeamUsageAttempts(db, viewer, section, filters, { page, pageSize });
    items.push(...result.items);
    if (total === -1) total = result.pagination.total;
    assert.equal(result.pagination.total, total, `${section} 总数不随页变化`);
    assert.ok(result.items.length <= pageSize);
    if (page >= result.pagination.totalPages) break;
  }
  assert.equal(new Set(items.map((item) => item.attemptId)).size, items.length, `${section} 遍历无重复`);
  return { items, total };
}

try {
  // ── 1. 分页参数/非法值复用 03 的公共合同 ──────────────────────────────────────
  assert.deepEqual(TEAM_USAGE_SECTIONS, ['summary', 'tasks', 'channels', 'legacy', 'unmapped']);
  assert.equal(listTeamUsageAttempts(db, adminView, 'channels', RANGE_NOV, { page: 999, pageSize: 25 }).pagination.page, 21,
    '超出末页归到有效末页并返回实际 page');
  assert.throws(
    () => listTeamUsageAttempts(db, adminView, 'channels', RANGE_NOV, { page: '0' }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 400
      && (error as { code?: string }).code === 'page_invalid',
  );
  assert.throws(
    () => listTeamUsageAttempts(db, adminView, 'legacy', RANGE_NOV, { pageSize: '30' }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 400
      && (error as { code?: string }).code === 'page_size_invalid',
  );
  console.log('PASS: usage sections reuse the shared page contract');

  // ── 2. 503 任务 / 503 调用 / 12,575 分：摘要只返回摘要 ────────────────────────
  const summaryAdmin = queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW);
  assert.deepEqual(summaryAdmin.totals, {
    settledMinor: 12_575, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0,
  }, '503 × 25 分已结算合计 12,575 分');
  assert.deepEqual(summaryAdmin.counts, {
    generationTasks: 503, channelCalls: 503, legacyAttempts: 0, unmappedAttempts: 0,
  });
  assert.equal(summaryAdmin.taskCount, 503);
  assert.equal(summaryAdmin.attemptCount, 503);
  assert.equal(summaryAdmin.localAgentIncluded, false);
  assert.equal('items' in summaryAdmin, false, '摘要不得携带全量尝试数组');
  assert.equal('tasks' in summaryAdmin, false, '摘要不得携带全量制作任务数组');
  assert.equal('legacyAttempts' in summaryAdmin, false);
  assert.equal('unmappedAttempts' in summaryAdmin, false);
  assert.equal('channels' in summaryAdmin, false);

  assert.equal(summaryAdmin.models.length, 1);
  assert.equal(summaryAdmin.models[0].model, 'Image 2');
  assert.equal(summaryAdmin.models[0].callCount, 503);
  assert.equal(summaryAdmin.models[0].taskCount, 503);
  assert.equal(summaryAdmin.models[0].chargedMinor, 12_575);
  assert.equal(summaryAdmin.models[0].settledMinor, 12_575);
  assert.equal(summaryAdmin.models[0].percentage, 100);
  assert.deepEqual(summaryAdmin.models[0].modules, ['image']);
  assert.deepEqual(summaryAdmin.modelOptions, ['Image 2']);

  const novTrendTotal = summaryAdmin.trend.reduce((sum, point) => sum + point.chargedMinor, 0);
  assert.equal(novTrendTotal, 12_575, '趋势覆盖完整筛选范围');
  assert.equal(summaryAdmin.trend.length, 30, '上海 11 月自然日 30 个点');
  assert.equal(summaryAdmin.trend.find((point) => point.date === '2026-11-11')?.chargedMinor, 2_500);
  assert.equal(summaryAdmin.trend.find((point) => point.date === '2026-11-09')?.chargedMinor, 10_075);

  const quota = summaryAdmin.teamQuota;
  assert.ok(quota);
  assert.deepEqual(quota, {
    accountingPeriod: CURRENT_PERIOD,
    chargedMinor: 130, // 本月已计 100（已结算）+ 30（预留）
    settledMinor: 100,
    heldMinor: 30,
    limitedCount: 0,
    limitedTotalMinor: 0,
    limitedRemainingMinor: 0,
    unlimitedCount: 3,
  }, '额度卡是北京时间自然月口径，上月预留不计入');
  assert.deepEqual(summaryAdmin.members.map((member) => [member.employeeId, member.callCount, member.rangeChargedMinor]), [
    ['0001', 503, 12_575], ['0000', 0, 0], ['0002', 0, 0],
  ], '成员统计按筛选范围求值');
  console.log('PASS: summary computes 503/503/12,575 from the full range without full arrays');

  // ── 3. tasks 分页：25/50 两档遍历 503 个制作任务 ─────────────────────────────
  const firstTaskPage = listTeamUnifiedUsageTasks(db, adminView, RANGE_NOV, { page: 1, pageSize: 25 });
  assert.deepEqual(firstTaskPage.pagination, { page: 1, pageSize: 25, total: 503, totalPages: 21 });
  assert.equal(firstTaskPage.items[0].mediaTaskId, 'media-task-001');
  assert.equal(firstTaskPage.items[0].generationTaskCount, 1);
  assert.equal(firstTaskPage.items[0].channelCallCount, 1);
  assert.equal(firstTaskPage.items[0].chargedMinor, 25);
  assert.equal(firstTaskPage.items[0].costStatus, 'settled');
  assert.equal(firstTaskPage.items[0].model, 'Image 2');
  assert.equal(firstTaskPage.items[0].channels?.length, 1, '管理员任务项保留通道明细');

  const tasks25 = walkTaskItems(adminView, RANGE_NOV, 25);
  assert.equal(tasks25.total, 503);
  assert.equal(tasks25.items.length, 503);
  assert.equal(new Set(tasks25.items.map((item) => item.mediaTaskId)).size, 503, '21 页遍历完整无重复');
  const tasks50 = walkTaskItems(adminView, RANGE_NOV, 50);
  assert.equal(tasks50.total, 503);
  assert.deepEqual(
    new Set(tasks50.items.map((item) => item.mediaTaskId)),
    new Set(tasks25.items.map((item) => item.mediaTaskId)),
    '25/50 两档遍历结果相同',
  );

  const sameTimeTasks = tasks25.items.filter((item) => item.createdAt === SAME_TASK_TIME);
  assert.equal(sameTimeTasks.length, 10, '10 个制作任务共用同一个 createdAt');
  assert.deepEqual(
    sameTimeTasks.map((item) => item.mediaTaskId),
    Array.from({ length: 10 }, (_, index) => `media-task-${pad(49 - index)}`),
    '同一时间按 mediaTaskId 倒序稳定排序',
  );

  const employeeTasks = listTeamUnifiedUsageTasks(db, aliceView, RANGE_NOV, { page: 1, pageSize: 25 });
  assert.equal(employeeTasks.pagination.total, 503, '员工只统计本人任务');
  assert.ok(employeeTasks.items.every((item) => 'channels' in item === false),
    '员工任务项不得携带真实通道明细');

  const emptyTasks = listTeamUnifiedUsageTasks(db, adminView, { ...RANGE_NOV, model: 'no-such-model' }, { page: 1, pageSize: 25 });
  assert.deepEqual(emptyTasks.pagination, { page: 1, pageSize: 25, total: 0, totalPages: 1 });
  assert.deepEqual(emptyTasks.items, []);
  console.log('PASS: tasks paginate 503 production tasks into 21/11 pages with stable ID tie ordering');

  // ── 4. channels 分页：每个已关联 attempt 一条 ─────────────────────────────────
  const channelsFirst = listTeamUsageAttempts(db, adminView, 'channels', RANGE_NOV, { page: 1, pageSize: 25 });
  assert.deepEqual(channelsFirst.pagination, { page: 1, pageSize: 25, total: 503, totalPages: 21 });
  assert.equal(channelsFirst.items[0].attemptId, 'attempt-usage-001');
  const channels25 = walkAttemptItems(adminView, 'channels', RANGE_NOV, 25);
  assert.equal(channels25.total, 503);
  assert.equal(channels25.items.length, 503);
  assert.equal(queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW).attemptCount, 503);
  assert.equal(walkAttemptItems(adminView, 'channels', RANGE_NOV, 50).items.length, 503);
  assert.equal(listTeamUsageAttempts(db, adminView, 'legacy', RANGE_NOV, { page: 1, pageSize: 25 }).pagination.total, 0);
  assert.equal(listTeamUsageAttempts(db, adminView, 'unmapped', RANGE_NOV, { page: 1, pageSize: 25 }).pagination.total, 0,
    '503 个父任务都在数据库里，没有一条是未映射');

  // 摘要与列表 total 同口径；CSV 覆盖完整范围（503 条尝试 + 表头）。
  const csv503 = await (await exportRoute.GET(request(exportUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&page=999&pageSize=50'), adminCookie))).text();
  assert.equal(csv503.trim().split('\r\n').length, 504, 'CSV 503 条记录不因分页截断');
  assert.equal(csv503.includes('attempt-usage-503'), true, '第 503 个任务的记录都在导出里');
  console.log('PASS: channels paginate every linked attempt and CSV ignores page/pageSize');

  // ── 5. 第二个真实调用 40 分：任务数不变、调用 504、合计 12,615、该任务 65 ─────
  const tailTime = positionTime(TAIL_TASK_INDEX);
  insertChannel({
    mediaTaskId: `media-task-${pad(TAIL_TASK_INDEX)}`, channelKey: 'qiniu',
    providerModel: 'qiniuyun/gpt-image-2-medium', state: 'candidate',
    operationId: null, priority: 0, createdAt: tailTime,
  });
  insertChannel({
    mediaTaskId: `media-task-${pad(TAIL_TASK_INDEX)}`, channelKey: 'backup',
    providerModel: 'backup-image-model', state: 'succeeded',
    operationId: 'op-usage-503-backup', priority: 2, createdAt: tailTime,
  });
  insertOperation({
    id: 'op-usage-503-backup', actorUserId: alice.principal.userId, taskId: `task-usage-${pad(TAIL_TASK_INDEX)}`,
    createdAt: tailTime, mediaTaskId: `media-task-${pad(TAIL_TASK_INDEX)}`, channelKey: 'backup',
    providerSnapshot: { providerId: 'company-gateway-image2-medium', model: 'backup-image-model', unifiedModel: 'image2' },
  });
  insertAttempt({
    id: 'attempt-usage-503-extra', operationId: 'op-usage-503-backup',
    actorUserId: alice.principal.userId, createdAt: tailTime,
    costState: 'settled', reservedMinor: 40, actualMinor: 40,
  });

  const summaryWithExtra = queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW);
  assert.deepEqual(summaryWithExtra.totals, {
    settledMinor: 12_615, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0,
  }, '增加 40 分真实调用后合计 12,615 分');
  assert.deepEqual(summaryWithExtra.counts, {
    generationTasks: 503, channelCalls: 504, legacyAttempts: 0, unmappedAttempts: 0,
  }, '自动兜底仍是 1 个制作任务，真实尝试单独计数');
  assert.equal(summaryWithExtra.taskCount, 503);
  assert.equal(summaryWithExtra.attemptCount, 504);
  assert.equal(listTeamUnifiedUsageTasks(db, adminView, RANGE_NOV, { page: 1, pageSize: 25 }).pagination.total, 503);

  const tailTask = queryUnifiedTaskUsage(db, adminView, RANGE_NOV).tasks
    .find((task) => task.mediaTaskId === `media-task-${pad(TAIL_TASK_INDEX)}`);
  assert.ok(tailTask);
  assert.equal(tailTask.chargedMinor, 65, '该任务合计 65 分');
  assert.equal(tailTask.channelCallCount, 2);
  assert.equal(tailTask.submissionCount, 2);
  assert.equal(tailTask.usedChannelCount, 2, '备用未提交通道不增加调用数');
  assert.equal(tailTask.channels?.length, 3, '未提交的候选通道仍作为通道记录可见');
  assert.equal(tailTask.channels?.find((channel) => channel.channelKey === 'qiniu')?.attempts.length, 0,
    '备用通道没有真实发起记录');
  assert.equal(tailTask.costStatus, 'settled');

  const channelItemsAfterExtra = walkAttemptItems(adminView, 'channels', RANGE_NOV, 25).items;
  const extraIndex = channelItemsAfterExtra.findIndex((item) => item.attemptId === 'attempt-usage-503-extra');
  const baseTailIndex = channelItemsAfterExtra.findIndex((item) => item.attemptId === 'attempt-usage-503');
  assert.equal(extraIndex + 1, baseTailIndex, '同一创建时间按 attemptId 倒序稳定排序');
  console.log('PASS: second real call changes calls to 504 and the task total to 65 without a new task');

  // ── 6. 摘要与金额不随页/页大小/section 变化；模型选项不因筛选裁剪 ─────────────
  const stableA = queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW);
  const stableB = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV }, FIXED_NOW);
  assert.deepEqual(stableB.totals, stableA.totals);
  assert.deepEqual(stableB.models, stableA.models);
  assert.deepEqual(stableB.trend, stableA.trend);
  assert.deepEqual(stableB.members, stableA.members);
  assert.deepEqual(stableB.counts, stableA.counts);
  const summaryRouteNoPage = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team'), adminCookie))).json() as Record<string, unknown>;
  const summaryRoutePaged = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=summary&page=7&pageSize=50'), adminCookie))).json() as Record<string, unknown>;
  for (const key of ['totals', 'models', 'trend', 'members', 'counts', 'teamQuota', 'modelOptions', 'taskCount', 'attemptCount']) {
    assert.deepEqual(summaryRoutePaged[key], summaryRouteNoPage[key], `摘要 ${key} 不随页码变化`);
  }
  // 选择今天/另一账期/模型筛选后，模型选项仍是授权范围完整候选。
  const todaySummary = queryTeamUsageSummary(db, adminView, RANGE_TODAY, FIXED_NOW);
  assert.deepEqual(todaySummary.totals, { settledMinor: 2_500, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });
  assert.deepEqual(todaySummary.counts, { generationTasks: 100, channelCalls: 100, legacyAttempts: 0, unmappedAttempts: 0 });
  assert.deepEqual(todaySummary.teamQuota, stableA.teamQuota, '额度卡不随用量筛选变化');
  assert.deepEqual(queryTeamUsageSummary(db, adminView, RANGE_OCT, FIXED_NOW).teamQuota, stableA.teamQuota);
  const filteredModelOptions = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, model: 'no-such-model' }, FIXED_NOW);
  assert.deepEqual(filteredModelOptions.modelOptions, stableA.modelOptions, '模型选项不被当前已选模型裁剪');
  console.log('PASS: summary/quota/model options stay stable across pages, dates and model filters');

  // ── 7. 分类互斥：真实父任务关联、跨页/跨账期父任务不算未映射 ────────────────────
  // 跨账期父任务：父任务创建于 10 月，真实尝试在 11 月。
  insertMediaTask({ id: 'media-cross-period', taskId: 'task-cross-period', actorUserId: alice.principal.userId, createdAt: '2026-10-15T04:00:00.000Z' });
  insertChannel({
    mediaTaskId: 'media-cross-period', channelKey: 'tencent', providerModel: 'image2-medium',
    state: 'succeeded', operationId: 'op-cross-period', priority: 1, createdAt: '2026-11-10T04:30:00.000Z',
  });
  insertOperation({
    id: 'op-cross-period', actorUserId: alice.principal.userId, taskId: 'task-cross-period',
    createdAt: '2026-11-10T04:30:00.000Z', mediaTaskId: 'media-cross-period', channelKey: 'tencent',
    providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' },
  });
  insertAttempt({
    id: 'attempt-cross-period', operationId: 'op-cross-period', actorUserId: alice.principal.userId,
    createdAt: '2026-11-10T04:30:00.000Z', costState: 'settled', reservedMinor: 15, actualMinor: 15,
    accountingPeriod: '2026-10',
  });

  // 真正缺失父任务的关联；以及声称统一身份但没有 mediaTaskId 的记录。
  insertOperation({
    id: 'op-unmapped-1', actorUserId: alice.principal.userId, taskId: 'task-unmapped-1',
    createdAt: '2026-11-10T05:20:00.000Z', mediaTaskId: 'media-missing-parent', channelKey: 'tencent',
    providerSnapshot: { model: 'gpt-image-2' },
  });
  insertAttempt({
    id: 'attempt-unmapped-1', operationId: 'op-unmapped-1', actorUserId: alice.principal.userId,
    createdAt: '2026-11-10T05:20:00.000Z', costState: 'settled', reservedMinor: 11, actualMinor: 11,
  });
  insertOperation({
    id: 'op-unmapped-2', actorUserId: alice.principal.userId, taskId: 'task-unmapped-2',
    createdAt: '2026-11-10T05:21:00.000Z', mediaTaskId: null, channelKey: null,
    providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' },
  });
  insertAttempt({
    id: 'attempt-unmapped-2', operationId: 'op-unmapped-2', actorUserId: alice.principal.userId,
    createdAt: '2026-11-10T05:21:00.000Z', costState: 'settled', reservedMinor: 13, actualMinor: 13,
    terminalState: 'failed',
  });

  const withOrphans = queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW);
  assert.equal(withOrphans.counts.unmappedAttempts, 2, '只有真实缺失父任务的记录进入未映射');
  assert.equal(withOrphans.counts.channelCalls, 505, '跨账期父任务的真实调用仍是已关联通道记录');
  assert.equal(walkAttemptItems(adminView, 'unmapped', RANGE_NOV, 25).items
    .some((item) => item.attemptId === 'attempt-cross-period'), false, '跨账期父任务不进入未映射');
  const crossChannels = walkAttemptItems(adminView, 'channels', RANGE_NOV, 25).items;
  assert.equal(crossChannels.some((item) => item.attemptId === 'attempt-cross-period'), true);
  const novTasksWithCross = walkTaskItems(adminView, RANGE_NOV, 50).items;
  assert.equal(novTasksWithCross.some((task) => task.mediaTaskId === 'media-cross-period'), true,
    '父任务创建于另一账期但本月有真实调用 → 以任务页加真实调用出现');
  const crossTask = novTasksWithCross.find((task) => task.mediaTaskId === 'media-cross-period');
  assert.equal(crossTask?.chargedMinor, 15);
  assert.equal(crossTask?.channelCallCount, 1);
  // 十月账期：父任务本身在范围内，但调用发生在 11 月 → 任务在、调用不在（保留既有任务/尝试日期归属）。
  const octSummary = queryTeamUsageSummary(db, adminView, RANGE_OCT, FIXED_NOW);
  assert.deepEqual(octSummary.counts, { generationTasks: 1, channelCalls: 0, legacyAttempts: 0, unmappedAttempts: 0 },
    '任务日期与尝试日期归属保留既有账期规则');
  assert.deepEqual(octSummary.totals, { settledMinor: 0, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });
  console.log('PASS: cross-page / cross-period parents stay classified as linked channel records');

  // ── 8. 未提交、两通道、released/estimated/uncertain/unpriced/mixed、旧模型 ────
  insertMediaTask({ id: 'media-released', taskId: 'task-released', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(1)), status: 'failed' });
  insertChannel({ mediaTaskId: 'media-released', channelKey: 'tencent', providerModel: 'image2-medium', state: 'failed', operationId: 'op-released', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(1)) });
  insertOperation({ id: 'op-released', actorUserId: alice.principal.userId, taskId: 'task-released', createdAt: iso(SPECIAL_BASE - minutes(1)), mediaTaskId: 'media-released', channelKey: 'tencent', status: 'failed', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-released', operationId: 'op-released', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(1)), costState: 'released', reservedMinor: 25, actualMinor: null, terminalState: 'not_created' });

  insertMediaTask({ id: 'media-estimated', taskId: 'task-estimated', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(2)), status: 'accepted' });
  insertChannel({ mediaTaskId: 'media-estimated', channelKey: 'tencent', providerModel: 'image2-medium', state: 'accepted', operationId: 'op-estimated', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(2)) });
  insertOperation({ id: 'op-estimated', actorUserId: alice.principal.userId, taskId: 'task-estimated', createdAt: iso(SPECIAL_BASE - minutes(2)), mediaTaskId: 'media-estimated', channelKey: 'tencent', status: 'accepted', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-estimated', operationId: 'op-estimated', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(2)), costState: 'reserved', reservedMinor: 30, actualMinor: null, terminalState: null, submissionState: 'accepted' });

  insertMediaTask({ id: 'media-uncertain', taskId: 'task-uncertain', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(3)), status: 'failed' });
  insertChannel({ mediaTaskId: 'media-uncertain', channelKey: 'tencent', providerModel: 'image2-medium', state: 'failed', operationId: 'op-uncertain', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(3)) });
  insertOperation({ id: 'op-uncertain', actorUserId: alice.principal.userId, taskId: 'task-uncertain', createdAt: iso(SPECIAL_BASE - minutes(3)), mediaTaskId: 'media-uncertain', channelKey: 'tencent', status: 'failed', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-uncertain', operationId: 'op-uncertain', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(3)), costState: 'unknown', reservedMinor: 20, actualMinor: null, terminalState: 'failed' });

  insertMediaTask({ id: 'media-unpriced', taskId: 'task-unpriced', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(4)), status: 'waiting' });
  insertChannel({ mediaTaskId: 'media-unpriced', channelKey: 'tencent', providerModel: 'image2-medium', state: 'pending', operationId: 'op-unpriced', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(4)) });
  insertOperation({ id: 'op-unpriced', actorUserId: alice.principal.userId, taskId: 'task-unpriced', createdAt: iso(SPECIAL_BASE - minutes(4)), mediaTaskId: 'media-unpriced', channelKey: 'tencent', status: 'pending', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' }, quoteJson: '{"kind":"unpriced"}' });
  insertAttempt({ id: 'attempt-unpriced', operationId: 'op-unpriced', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(4)), costState: 'reserved', reservedMinor: 0, actualMinor: null, terminalState: null });

  insertMediaTask({ id: 'media-mixed', taskId: 'task-mixed', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(5)) });
  insertChannel({ mediaTaskId: 'media-mixed', channelKey: 'qiniu', providerModel: 'qiniuyun/gpt-image-2-medium', state: 'pending', operationId: 'op-mixed-released', priority: 0, createdAt: iso(SPECIAL_BASE - minutes(5)) });
  insertChannel({ mediaTaskId: 'media-mixed', channelKey: 'tencent', providerModel: 'image2-medium', state: 'succeeded', operationId: 'op-mixed-settled', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(5)) });
  insertOperation({ id: 'op-mixed-released', actorUserId: alice.principal.userId, taskId: 'task-mixed', createdAt: iso(SPECIAL_BASE - minutes(5)), mediaTaskId: 'media-mixed', channelKey: 'qiniu', status: 'pending', quoteJson: '{"kind":"unpriced"}', providerSnapshot: { model: 'qiniuyun/gpt-image-2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-mixed-unpriced', operationId: 'op-mixed-released', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(5)), costState: 'reserved', reservedMinor: 10, actualMinor: null, terminalState: null });
  insertOperation({ id: 'op-mixed-settled', actorUserId: alice.principal.userId, taskId: 'task-mixed', createdAt: iso(SPECIAL_BASE - minutes(5)), mediaTaskId: 'media-mixed', channelKey: 'tencent', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-mixed-settled', operationId: 'op-mixed-settled', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(5)), costState: 'settled', reservedMinor: 50, actualMinor: 50 });

  insertMediaTask({ id: 'media-unsubmitted', taskId: 'task-unsubmitted', actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(6)), status: 'pending' });

  insertMediaTask({ id: 'media-bob', taskId: 'task-bob', actorUserId: bob.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(7)) });
  insertChannel({ mediaTaskId: 'media-bob', channelKey: 'tencent', providerModel: 'image2-medium', state: 'succeeded', operationId: 'op-bob', priority: 1, createdAt: iso(SPECIAL_BASE - minutes(7)) });
  insertOperation({ id: 'op-bob', actorUserId: bob.principal.userId, taskId: 'task-bob', createdAt: iso(SPECIAL_BASE - minutes(7)), mediaTaskId: 'media-bob', channelKey: 'tencent', providerSnapshot: { model: 'image2-medium', unifiedModel: 'image2' } });
  insertAttempt({ id: 'attempt-bob', operationId: 'op-bob', actorUserId: bob.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(7)), costState: 'settled', reservedMinor: 5, actualMinor: 5 });

  // 旧非统一模型：没有统一模型、没有父任务，正常计入 legacy。
  for (const [id, taskId, model, actualMinor, terminalState] of [
    ['op-legacy-a', 'task-legacy-a', 'legacy-model-a', 7, 'succeeded'],
    ['op-legacy-b', 'task-legacy-b', 'legacy-model-b', 9, 'failed'],
  ] as const) {
    insertOperation({ id, actorUserId: alice.principal.userId, taskId, createdAt: iso(SPECIAL_BASE - minutes(10) + 1000), module: 'llm', providerSnapshot: { model } });
    insertAttempt({ id: `attempt-${id}`, operationId: id, actorUserId: alice.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(10) + 1000), costState: 'settled', reservedMinor: actualMinor, actualMinor, terminalState });
  }
  insertOperation({ id: 'op-bob-legacy', actorUserId: bob.principal.userId, taskId: 'task-bob-legacy', createdAt: iso(SPECIAL_BASE - minutes(9)), module: 'llm', providerSnapshot: { model: 'bob-only-model' } });
  insertAttempt({ id: 'attempt-bob-legacy', operationId: 'op-bob-legacy', actorUserId: bob.principal.userId, createdAt: iso(SPECIAL_BASE - minutes(9)), costState: 'settled', reservedMinor: 3, actualMinor: 3 });

  const full = queryTeamUsageSummary(db, adminView, RANGE_NOV, FIXED_NOW);
  assert.deepEqual(full.totals, {
    settledMinor: 12_728, estimatedMinor: 30, unpricedCount: 2, uncertainCount: 1,
  }, '已结算/估算/未定价/不确定分别统计，未定价与待核账不混成 0 元已结算');
  assert.deepEqual(full.counts, {
    generationTasks: 511, channelCalls: 512, legacyAttempts: 3, unmappedAttempts: 2,
  });
  assert.equal(full.attemptCount, 517);
  assert.equal(full.taskCount, 514, '511 个统一制作任务 + 3 个旧非统一任务；未映射不重复计任务');
  assert.deepEqual(full.modelOptions, ['Image 2', 'bob-only-model', 'gpt-image-2', 'legacy-model-a', 'legacy-model-b']);
  const imageModel = full.models.find((model) => model.model === 'Image 2');
  assert.equal(imageModel?.chargedMinor, 12_748);
  assert.equal(imageModel?.callCount, 513);
  assert.equal(imageModel?.taskCount, 511);
  const modelNames = full.models.map((model) => model.model);
  assert.deepEqual(modelNames, ['Image 2', 'gpt-image-2', 'legacy-model-b', 'legacy-model-a', 'bob-only-model'],
    '模型排行按已计费用倒序，未映射的旧模型不会显示成制作任务数');
  assert.equal(full.models.find((model) => model.model === 'gpt-image-2')?.taskCount, 0,
    '未映射尝试计入费用但不计制作任务');
  const fullTrendTotal = full.trend.reduce((sum, point) => sum + point.chargedMinor, 0);
  assert.equal(fullTrendTotal, 12_778, '趋势合计覆盖所有真实尝试');
  assert.equal(full.trend.find((point) => point.date === '2026-11-10')?.chargedMinor, 163);
  assert.deepEqual(full.members.map((member) => [member.employeeId, member.callCount, member.rangeChargedMinor]), [
    ['0001', 515, 12_770], ['0002', 2, 8], ['0000', 0, 0],
  ]);
  assert.deepEqual(full.teamQuota, quota, '额度卡口径与筛选无关');
  assert.deepEqual(queryTeamUsageTotals(db, adminView, RANGE_NOV), queryTeamUsage(db, adminView, RANGE_NOV).totals,
    'SQL 金额聚合与逐条投影同口径');
  assert.deepEqual(queryTeamUsageCounts(db, adminView, RANGE_NOV), full.counts,
    'SQL 分类计数与摘要 counts 同口径');

  // 三个调用分类互斥，且并集恰好等于该筛选下的全部真实尝试。
  const channelsAll = walkAttemptItems(adminView, 'channels', RANGE_NOV, 50).items;
  const legacyAll = walkAttemptItems(adminView, 'legacy', RANGE_NOV, 50).items;
  const unmappedAll = walkAttemptItems(adminView, 'unmapped', RANGE_NOV, 50).items;
  const flatAttempts = queryTeamUsage(db, adminView, RANGE_NOV).items;
  const classes = new Map<string, string>();
  for (const [name, list] of [['channels', channelsAll], ['legacy', legacyAll], ['unmapped', unmappedAll]] as const) {
    for (const item of list) {
      assert.equal(classes.has(item.attemptId), false, `${item.attemptId} 只能属于一个分类`);
      classes.set(item.attemptId, name);
    }
  }
  assert.equal(classes.size, 517, '三个分类并集等于全部真实尝试，无遗漏无重复');
  assert.deepEqual(new Set(classes.keys()), new Set(flatAttempts.map((item) => item.attemptId)));
  assert.equal(channelsAll.length, full.counts.channelCalls);
  assert.equal(legacyAll.length, full.counts.legacyAttempts);
  assert.equal(unmappedAll.length, full.counts.unmappedAttempts);
  assert.equal(unmappedAll.find((item) => item.attemptId === 'attempt-unmapped-2')?.model, 'image2-medium');
  assert.equal(unmappedAll.find((item) => item.attemptId === 'attempt-unmapped-1')?.model, 'gpt-image-2');

  // 逐类任务状态：未提交、released/estimated/uncertain/unpriced/mixed。
  const fullTasks = walkTaskItems(adminView, RANGE_NOV, 50).items;
  assert.equal(fullTasks.length, 511);
  const taskStatus = (id: string) => fullTasks.find((task) => task.mediaTaskId === id);
  assert.equal(taskStatus('media-unsubmitted')?.costStatus, 'unpriced');
  assert.equal(taskStatus('media-unsubmitted')?.channelCallCount, 0);
  assert.equal(taskStatus('media-unsubmitted')?.chargedMinor, 0);
  assert.equal(taskStatus('media-released')?.costStatus, 'released');
  assert.equal(taskStatus('media-released')?.chargedMinor, 0);
  assert.equal(taskStatus('media-released')?.releasedCount, 1);
  assert.equal(taskStatus('media-estimated')?.costStatus, 'estimated');
  assert.equal(taskStatus('media-estimated')?.estimatedMinor, 30);
  assert.equal(taskStatus('media-uncertain')?.costStatus, 'uncertain');
  assert.equal(taskStatus('media-uncertain')?.uncertainMinor, 20);
  assert.equal(taskStatus('media-unpriced')?.costStatus, 'unpriced');
  assert.equal(taskStatus('media-unpriced')?.unpricedCount, 1);
  assert.equal(taskStatus('media-mixed')?.costStatus, 'mixed');
  assert.equal(taskStatus('media-mixed')?.chargedMinor, 50);
  assert.equal(taskStatus('media-mixed')?.settledMinor, 50);
  assert.equal(taskStatus('media-mixed')?.unpricedCount, 1);
  assert.equal(taskStatus('media-bob')?.actorUserId, bob.principal.userId);
  console.log('PASS: released/estimated/uncertain/unpriced/mixed/unsubmitted/legacy/unmapped all classify correctly');

  // ── 9. 筛选：列表 total 与该 section 实际集合一致，摘要同口径 ─────────────────
  const failedSummary = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, outcome: 'failed' }, FIXED_NOW);
  assert.deepEqual(failedSummary.totals, { settledMinor: 22, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 1 });
  assert.deepEqual(failedSummary.counts, { generationTasks: 1, channelCalls: 1, legacyAttempts: 1, unmappedAttempts: 1 });
  assert.equal(listTeamUnifiedUsageTasks(db, adminView, { ...RANGE_NOV, outcome: 'failed' }, { page: 1, pageSize: 25 }).pagination.total, 1);
  assert.equal(walkAttemptItems(adminView, 'channels', { ...RANGE_NOV, outcome: 'failed' }, 25).items.length, 1);
  assert.equal(walkAttemptItems(adminView, 'legacy', { ...RANGE_NOV, outcome: 'failed' }, 25).items.length, 1);
  assert.equal(walkAttemptItems(adminView, 'unmapped', { ...RANGE_NOV, outcome: 'failed' }, 25).items.length, 1);

  const llmSummary = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, module: 'llm' }, FIXED_NOW);
  assert.deepEqual(llmSummary.totals, { settledMinor: 19, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });
  assert.deepEqual(llmSummary.counts, { generationTasks: 0, channelCalls: 0, legacyAttempts: 3, unmappedAttempts: 0 });
  assert.equal(walkAttemptItems(adminView, 'legacy', { ...RANGE_NOV, module: 'llm' }, 25).items.length, 3);

  const imageFilterSummary = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, model: 'Image 2' }, FIXED_NOW);
  assert.deepEqual(imageFilterSummary.totals, { settledMinor: 12_698, estimatedMinor: 30, unpricedCount: 2, uncertainCount: 1 });
  assert.deepEqual(imageFilterSummary.counts, { generationTasks: 511, channelCalls: 512, legacyAttempts: 0, unmappedAttempts: 1 });
  assert.equal(imageFilterSummary.attemptCount, 513);
  assert.equal(listTeamUnifiedUsageTasks(db, adminView, { ...RANGE_NOV, model: 'Image 2' }, { page: 1, pageSize: 25 }).pagination.total, 511);
  assert.equal(walkAttemptItems(adminView, 'channels', { ...RANGE_NOV, model: 'image2' }, 25).items.length, 512);

  const legacyModelSummary = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, model: 'legacy-model-a' }, FIXED_NOW);
  assert.deepEqual(legacyModelSummary.counts, { generationTasks: 0, channelCalls: 0, legacyAttempts: 1, unmappedAttempts: 0 });
  assert.deepEqual(legacyModelSummary.totals, { settledMinor: 7, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });

  const aliceFiltered = queryTeamUsageSummary(db, adminView, { ...RANGE_NOV, actorUserId: alice.principal.userId }, FIXED_NOW);
  assert.deepEqual(aliceFiltered.counts, { generationTasks: 510, channelCalls: 511, legacyAttempts: 2, unmappedAttempts: 2 });
  assert.deepEqual(aliceFiltered.totals, { settledMinor: 12_720, estimatedMinor: 30, unpricedCount: 2, uncertainCount: 1 });
  assert.deepEqual(aliceFiltered.teamQuota, quota, '成员筛选不改变自然月额度卡');
  assert.equal(aliceFiltered.members.find((member) => member.userId === bob.principal.userId)?.rangeChargedMinor, 0,
    '成员筛选只统计选中成员的范围费用');
  assert.equal(listTeamUnifiedUsageTasks(db, adminView, { ...RANGE_NOV, actorUserId: alice.principal.userId }, { page: 1, pageSize: 25 }).pagination.total, 510);
  console.log('PASS: result/module/model/member filters keep list totals and summary counts in sync');

  // ── 10. 权限：员工本人、管理员个人/团队/成员，直接访问与 CSV 同样受限 ─────────
  const aliceSummary = queryTeamUsageSummary(db, aliceView, RANGE_NOV, FIXED_NOW);
  assert.deepEqual(aliceSummary.totals, { settledMinor: 12_720, estimatedMinor: 30, unpricedCount: 2, uncertainCount: 1 });
  assert.deepEqual(aliceSummary.counts, { generationTasks: 510, channelCalls: 511, legacyAttempts: 2, unmappedAttempts: 2 });
  assert.equal(aliceSummary.teamQuota, null);
  assert.deepEqual(aliceSummary.members, []);
  assert.equal(aliceSummary.modelOptions.includes('bob-only-model'), false, '员工模型选项不包含他人模型');
  assert.equal(aliceSummary.models.some((model) => model.model === 'bob-only-model'), false);
  assert.equal(listTeamUnifiedUsageTasks(db, aliceView, RANGE_NOV, { page: 1, pageSize: 25 }).pagination.total, 510);
  assert.equal(walkAttemptItems(aliceView, 'legacy', RANGE_NOV, 25).items.length, 2);
  assert.throws(() => listTeamUsageAttempts(db, aliceView, 'channels', RANGE_NOV, { page: 1, pageSize: 25 }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 403,
    '员工直接请求通道调用必须 403，不能只在 UI 隐藏');
  assert.throws(() => listTeamUsageAttempts(db, aliceView, 'unmapped', RANGE_NOV, { page: 1, pageSize: 25 }),
    (error: unknown) => (error as { status?: number }).status === 403);
  assert.throws(() => queryTeamUsageSummary(db, aliceView, { ...RANGE_NOV, actorUserId: bob.principal.userId }, FIXED_NOW),
    (error: unknown) => (error as { status?: number }).status === 403, '员工不能按他人筛选');
  assert.throws(() => listTeamUnifiedUsageTasks(db, bobView, { ...RANGE_NOV, actorUserId: alice.principal.userId }, { page: 1 }),
    (error: unknown) => (error as { status?: number }).status === 403);

  // 路由层：默认 section=summary、员工无数组字段、他人 actorUserId 403、员工 CSV 403。
  const noAuthUsage = await usageRoute.GET(request(usageUrl(''), ''));
  assert.equal(noAuthUsage.status, 401, '直接访问必须鉴权');
  const employeeSummaryRoute = await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01'), alice.cookie));
  assert.equal(employeeSummaryRoute.status, 200, await employeeSummaryRoute.clone().text());
  const employeeSummaryBody = await employeeSummaryRoute.json() as Record<string, unknown>;
  assert.equal(employeeSummaryBody.section, 'summary');
  assert.equal(employeeSummaryBody.scope, 'self');
  assert.equal(employeeSummaryBody.canViewTeam, false);
  assert.deepEqual(employeeSummaryBody.range, { from: RANGE_NOV.from, to: RANGE_NOV.to });
  assert.equal('items' in employeeSummaryBody, false);
  assert.equal('tasks' in employeeSummaryBody, false);
  assert.equal(JSON.stringify(employeeSummaryBody).includes('"channels"'), false, '员工摘要没有统一通道内部字段');
  assert.deepEqual(employeeSummaryBody.counts, { generationTasks: 510, channelCalls: 511, legacyAttempts: 2, unmappedAttempts: 2 });
  assert.equal((employeeSummaryBody.member as { userId: string }).userId, alice.principal.userId);
  for (const section of ['channels', 'unmapped']) {
    const forbidden = await usageRoute.GET(request(usageUrl(`period=custom&from=2026-11-01&to=2026-12-01&section=${section}`), alice.cookie));
    assert.equal(forbidden.status, 403, `员工请求 section=${section} 必须 403`);
  }
  const employeeLegacy = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&section=legacy'), alice.cookie))).json() as { items: Array<{ model: string }>; pagination: { total: number } };
  assert.equal(employeeLegacy.pagination.total, 2);
  assert.equal(employeeLegacy.items.some((item) => item.model === 'bob-only-model'), false);
  const employeeCrossActor = await usageRoute.GET(request(usageUrl(`period=custom&from=2026-11-01&to=2026-12-01&actorUserId=${bob.principal.userId}`), alice.cookie));
  assert.equal(employeeCrossActor.status, 403);

  // 管理员个人 / 团队 / 成员切换。
  const adminSelf = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01'), adminCookie))).json() as { scope: string; counts: unknown; tasks?: unknown };
  assert.equal(adminSelf.scope, 'self');
  assert.deepEqual(adminSelf.counts, { generationTasks: 0, channelCalls: 0, legacyAttempts: 0, unmappedAttempts: 0 });
  const adminTeam = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team'), adminCookie))).json() as { scope: string; counts: unknown; canViewTeam: boolean };
  assert.equal(adminTeam.scope, 'team');
  assert.equal(adminTeam.canViewTeam, true);
  assert.deepEqual(adminTeam.counts, { generationTasks: 511, channelCalls: 512, legacyAttempts: 3, unmappedAttempts: 2 });
  const adminMember = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=tasks&actorUserId=' + bob.principal.userId), adminCookie))).json() as { pagination: { total: number }; scope: string };
  assert.equal(adminMember.pagination.total, 1);
  assert.equal(adminMember.scope, 'team');

  // ── 11. 路由级 section 合同、越界页、非法参数、CSV 合同 ─────────────────────
  const taskRoute = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=tasks&page=2&pageSize=25'), adminCookie))).json() as {
    section: string; items: Array<{ mediaTaskId: string; channels?: unknown[] }>; pagination: { page: number; pageSize: number; total: number; totalPages: number };
    range: { from: string; to: string }; scope: string; canViewTeam: boolean;
  };
  assert.equal(taskRoute.section, 'tasks');
  assert.deepEqual(taskRoute.pagination, { page: 2, pageSize: 25, total: 511, totalPages: 21 });
  assert.deepEqual(taskRoute.range, { from: RANGE_NOV.from, to: RANGE_NOV.to });
  assert.equal(taskRoute.scope, 'team');
  assert.equal(taskRoute.canViewTeam, true);
  assert.equal(taskRoute.items.length, 25);
  assert.ok(taskRoute.items.every((item) => Array.isArray(item.channels)), '管理员任务项保留通道明细');

  const clamped = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=tasks&page=999&pageSize=50'), adminCookie))).json() as { pagination: { page: number } };
  assert.equal(clamped.pagination.page, 11, '越界页按响应收敛到有效末页');

  const channelsRoute = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=channels&pageSize=50&page=11'), adminCookie))).json() as { items: unknown[]; pagination: { total: number; page: number } };
  assert.equal(channelsRoute.pagination.total, 512);
  assert.equal(channelsRoute.pagination.page, 11);
  assert.equal(channelsRoute.items.length, 12);
  const legacyRoute = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=legacy'), adminCookie))).json() as { pagination: { total: number } };
  assert.equal(legacyRoute.pagination.total, 3);
  const unmappedRoute = await (await usageRoute.GET(request(usageUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=team&section=unmapped'), adminCookie))).json() as { pagination: { total: number } };
  assert.equal(unmappedRoute.pagination.total, 2);

  for (const [query, code] of [
    ['section=attempts', 'invalid_usage_section'],
    ['section=', undefined],
    ['page=0', 'page_invalid'],
    ['page=abc', 'page_invalid'],
    ['pageSize=30', 'page_size_invalid'],
  ] as const) {
    const response = await usageRoute.GET(request(usageUrl(`period=custom&from=2026-11-01&to=2026-12-01&scope=team&${query}`), adminCookie));
    if (code === undefined) {
      assert.equal(response.status, 200, '空 section 等同未提供（默认 summary）');
      continue;
    }
    assert.equal(response.status, 400, `${query} 必须 400`);
    assert.equal((await response.json() as { error: string }).error, code);
  }
  const reversedRange = await usageRoute.GET(request(usageUrl('period=custom&from=2026-12-01&to=2026-11-01'), adminCookie));
  assert.equal(reversedRange.status, 400, '开始时间晚于结束时间必须 400');
  assert.equal((await reversedRange.json() as { error: string }).error, 'invalid_usage_query');

  const csvUrlBase = 'period=custom&from=2026-11-01&to=2026-12-01&scope=team';
  const csvResponse = await exportRoute.GET(request(exportUrl(`${csvUrlBase}&page=3&pageSize=50&section=channels`), adminCookie));
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type') ?? '', /text\/csv/);
  assert.equal(csvResponse.headers.get('cache-control'), 'no-store');
  const csv = await csvResponse.text();
  assert.ok(csv.startsWith('attemptId,operationId,taskId,actorUserId,employeeId,actorDisplayName,module,step,model,businessAttemptNo,submitRound,transportSeq,submissionState,outcome,remoteId,accountingPeriod,policyVersion,configVersion,clientVersion,serverReleaseId,errorId,costStatus,reservedMinor,actualMinor,usageMirrorStatus,createdAt,unifiedModel,reportingModel'),
    'CSV 保留原导出字段');
  const csvRows = csv.trim().split('\r\n');
  assert.equal(csvRows.length, 518, 'CSV 覆盖完整筛选范围（517 条尝试）并忽略 section/page/pageSize');
  assert.equal(csvRows.some((line) => line.includes('attempt-usage-503')), true, '第 503 个任务的记录在导出里');
  assert.equal(csvRows.some((line) => line.includes('attempt-usage-503-extra')), true);
  const csvWithoutPage = await (await exportRoute.GET(request(exportUrl(csvUrlBase), adminCookie))).text();
  assert.equal(csv, csvWithoutPage, '分页/页大小/section 不改变导出内容');
  const failedCsv = await (await exportRoute.GET(request(exportUrl(`${csvUrlBase}&outcome=failed`), adminCookie))).text();
  assert.equal(failedCsv.trim().split('\r\n').length, 4, 'CSV 遵守业务筛选（3 条失败尝试 + 表头）');
  assert.equal(failedCsv.includes('attempt-uncertain'), true);
  assert.equal(failedCsv.includes('attempt-bob'), false, 'scope=team + actorUserId 缺失时导出全团队');
  const employeeCsv = await exportRoute.GET(request(exportUrl(csvUrlBase), alice.cookie));
  assert.equal(employeeCsv.status, 403, '员工不能导出团队 CSV，直接访问同样受限');
  const adminSelfCsv = await exportRoute.GET(request(exportUrl('period=custom&from=2026-11-01&to=2026-12-01&scope=self'), adminCookie));
  assert.equal(adminSelfCsv.status, 200);
  assert.equal((await adminSelfCsv.text()).trim().split('\r\n').length, 1, '管理员 scope=self 只导出本人记录（空）');
  console.log('PASS: usage route serves sections with pagination, 400/403 semantics and full-range CSV');

  console.log('\nteam usage pagination and summary contract passed');
} finally {
  adminSession.token = '';
  setTeamAuthServiceForTests(null);
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}
