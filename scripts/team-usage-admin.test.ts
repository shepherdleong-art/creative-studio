import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { EnqueueInput, ExecutionGrant, ExecutionJournal } from '../lib/media-core/execution/context.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-usage-admin-'));
const previousRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkTeamServiceReadiness } = await import('../lib/team-service/readiness.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { createExecutionFacade } = await import('../lib/media-core/execution/operations.ts');
const { registerExecutionInstance } = await import('../lib/media-core/execution/schema.ts');
const { monthlyCostUsage, updateActorPolicy, upsertExecutionPool } = await import('../lib/media-core/execution/pools.ts');
const { initUsageSchema } = await import('../lib/usage-schema.ts');
const { registerRootScope } = await import('../lib/team-service/resource-scopes.ts');
const { registerTaskPrincipal } = await import('../lib/team-service/task-principals.ts');
const {
  exportTeamUsageCsv,
  listTeamMembers,
  queryTeamUsage,
  queryTeamUsageAnalytics,
  readTeamMemberPolicy,
  updateTeamMemberPolicy,
} = await import('../lib/team-service/usage.ts');

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('foreign_keys = ON');
assert.equal((await checkTeamServiceReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal((await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) })).available, true);
assert.equal(initUsageSchema(db).available, true);
const identity = { instanceId: 'instance-team-usage', fence: 1 };
registerExecutionInstance(db, { ...identity, deploymentId: 'deployment-team-usage' });
const journalRecords: Array<Record<string, unknown>> = [];
const journal = {
  verify: () => ({ valid: true, records: journalRecords }),
  scan: () => journalRecords,
  appendIntent: (input: Record<string, unknown>) => {
    const record = { ...input, schemaVersion: 1, deploymentId: 'deployment-team-usage', eventType: 'submit_intent', seq: journalRecords.length + 1, prevHash: null, hash: `intent-${journalRecords.length + 1}`, at: new Date().toISOString() };
    journalRecords.push(record);
    return record;
  },
  appendReceipt: (input: Record<string, unknown>) => {
    const record = { ...input, schemaVersion: 1, deploymentId: 'deployment-team-usage', eventType: 'receipt', seq: journalRecords.length + 1, prevHash: null, hash: `receipt-${journalRecords.length + 1}`, at: new Date().toISOString() };
    journalRecords.push(record);
    return record;
  },
} as unknown as ExecutionJournal;
const now = new Date('2026-11-02T02:00:00.000Z');
const runtime = createExecutionFacade({
  db,
  deploymentId: 'deployment-team-usage',
  serverReleaseId: 'server-2026.11.02',
  journal,
  now: () => now,
  actorAllowed: () => true,
  scopeAllowed: () => true,
  maintenance: () => false,
});
await runtime.lifecycle.start({ ...identity, deploymentId: 'deployment-team-usage', signal: new AbortController().signal });
const execution = runtime.facade;
upsertExecutionPool(db, {
  poolKey: 'shared', kind: 'remote', capacity: 20, enabled: true,
  mappingSnapshot: { providerId: 'provider-a' }, expectedVersion: 0,
});

function addUser(id: string, employeeId: string, displayName: string, role: 'employee' | 'admin' = 'employee') {
  db.prepare(`
    INSERT INTO team_users (
      id, employeeId, displayName, role, status, passwordHash, mustChangePassword,
      sessionVersion, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, 'active', 'not-used', 0, 1, ?, ?)
  `).run(id, employeeId, displayName, role, now.toISOString(), now.toISOString());
  registerRootScope(db, { resourceType: 'test_resource', resourceId: `${id}-project`, ownerUserId: id });
}
addUser('admin', '0000', '管理员', 'admin');
addUser('alice', '0001', '张三');
addUser('bob', '0002', '=2+3');
addUser('carol', '0003', '王五');
for (const actorId of ['alice', 'bob']) {
  updateActorPolicy(db, { actorId, monthlyLimitMinor: actorId === 'alice' ? 500 : 1_000, personalConcurrency: 5, paused: false, expectedVersion: 0 });
}
updateActorPolicy(db, { actorId: 'carol', monthlyLimitMinor: null, personalConcurrency: 5, paused: false, expectedVersion: 0 });

function operation(taskId: string, actorId: string, options: { module?: string; minor?: number; unpriced?: boolean; clientVersion?: string } = {}): EnqueueInput {
  const moduleName = options.module ?? 'images';
  return {
    operationKey: `${moduleName}/${taskId}/submit/r1`, actor: { userId: actorId },
    scope: { resourceType: 'test_resource', resourceId: `${actorId}-project` },
    module: moduleName, taskId, step: 'submit', inputRevision: 'r1',
    businessAttempt: { id: `${taskId}-business`, number: 1 },
    inputSnapshot: { taskId }, inputHash: `hash-${taskId}`,
    continuationKey: `${moduleName}.submit`,
    providerSnapshot: { providerId: 'provider-a', requestModel: 'image2-medium', coreModelKey: 'company-image2-medium' },
    configVersion: 'config-v7', clientVersion: options.clientVersion,
    requiredPools: ['shared'], quote: options.unpriced
      ? { kind: 'unpriced', pricingSnapshot: null }
      : { kind: 'priced', reserve: { currency: 'CNY', minor: options.minor ?? 100 }, pricingSnapshot: { coreModelKey: 'company-image2-medium', pricingVersion: 'price-v1' } },
  };
}

async function grant(taskId: string, actorId: string, options: Parameters<typeof operation>[2] = {}): Promise<ExecutionGrant> {
  const input = operation(taskId, actorId, options);
  registerTaskPrincipal(db, {
    module: input.module, taskId, actorUserId: actorId,
    scope: input.scope, creationSnapshot: { inputRevision: 'r1' },
  });
  const enqueued = execution.enqueue(input);
  const admitted = execution.admit({ ...identity, operationId: enqueued.operation.id });
  assert.equal(admitted.kind, 'admitted');
  if (admitted.kind !== 'admitted') throw new Error('grant expected');
  return admitted.grant;
}

async function finish(grantValue: ExecutionGrant, outcome: 'succeeded' | 'failed' | 'not_created', actualMinor: number | null, remoteTerminal = true) {
  const intent = await execution.markSubmitting({ grant: grantValue, requestSnapshot: { taskId: grantValue.operation.taskId } });
  await execution.transmit(intent, async () => ({ remoteId: `upstream-${grantValue.operation.taskId}-${intent.transportSeq}`, terminalState: outcome, actualCost: actualMinor === null ? null : { currency: 'CNY', minor: actualMinor } }));
  await execution.settle({
    attemptId: intent.attemptId, outcome, remoteTerminal,
    actualCost: actualMinor === null ? null : { currency: 'CNY', minor: actualMinor },
  });
  return intent;
}

try {
  const settled = await grant('a-settled', 'alice', { minor: 100, clientVersion: '0.7.1' });
  await finish(settled, 'succeeded', 120);

  const retry = await grant('a-retry', 'alice', { module: 'llm', minor: 30 });
  await finish(retry, 'failed', 20, false);
  const fallbackIntent = await execution.markSubmitting({
    grant: retry, requestSnapshot: { taskId: 'a-retry', fallback: true }, retryKind: 'protocol_fallback', quote: operation('a-retry', 'alice', { module: 'llm', minor: 30 }).quote,
  });
  await execution.transmit(fallbackIntent, async () => ({ remoteId: 'upstream-a-retry-2', terminalState: 'succeeded', actualCost: { currency: 'CNY', minor: 80 } }));
  await execution.settle({ attemptId: fallbackIntent.attemptId, outcome: 'succeeded', actualCost: { currency: 'CNY', minor: 80 }, remoteTerminal: true });

  await grant('a-held', 'alice', { minor: 50 });
  updateActorPolicy(db, { actorId: 'alice', monthlyLimitMinor: null, personalConcurrency: 5, paused: false, expectedVersion: 1 });
  await grant('a-unpriced', 'alice', { unpriced: true });
  const uncertain = await grant('a-uncertain', 'alice', { minor: 70 });
  updateActorPolicy(db, { actorId: 'alice', monthlyLimitMinor: 500, personalConcurrency: 5, paused: false, expectedVersion: 2 });
  await finish(uncertain, 'failed', null, false);
  const bobSettled = await grant('b-settled', 'bob', { module: 'video', minor: 400 });
  await finish(bobSettled, 'succeeded', 500);

  const range = { from: '2026-11-01T16:00:00.000Z', to: '2026-11-02T16:00:00.000Z' };
  const adminView = { userId: 'admin', role: 'admin' as const };
  const aliceView = { userId: 'alice', role: 'employee' as const };
  const admin = queryTeamUsage(db, adminView, range);
  assert.equal(admin.items.length, 7, '每个实际 transport attempt 都有一行，包含内部协议回退');
  assert.deepEqual(admin.totals, {
    settledMinor: 720, estimatedMinor: 50, unpricedCount: 1, uncertainCount: 1,
  });
  assert.equal(admin.localAgentIncluded, false);
  const settledRow = admin.items.find((item) => item.taskId === 'a-settled');
  assert.equal(settledRow?.actorUserId, 'alice');
  assert.equal(settledRow?.actualMinor, 120);
  assert.equal(settledRow?.costStatus, 'settled');
  assert.equal(settledRow?.remoteId, 'upstream-a-settled-1');
  assert.equal(settledRow?.configVersion, 'config-v7');
  assert.equal(settledRow?.serverReleaseId, 'server-2026.11.02');
  assert.equal(settledRow?.clientVersion, '0.7.1');
  assert.equal(admin.items.filter((item) => item.taskId === 'a-retry').length, 2);
  assert.equal(admin.items.find((item) => item.taskId === 'a-unpriced')?.costStatus, 'unpriced');
  assert.equal(admin.items.find((item) => item.taskId === 'a-unpriced')?.actualMinor, null);
  assert.equal(admin.items.find((item) => item.taskId === 'a-uncertain')?.costStatus, 'uncertain');
  const analytics = queryTeamUsageAnalytics(db, adminView, range, now);
  const model = analytics.models.find((item) => item.model === 'company-image2-medium');
  assert.equal(model?.callCount, 7);
  assert.equal(model?.chargedMinor, 840);
  assert.equal(model?.settledMinor, 720);
  assert.equal(model?.estimatedMinor, 50);
  assert.equal(model?.unpricedCount, 1);
  assert.equal(model?.uncertainCount, 1);
  assert.equal(model?.percentage, 100);
  assert.equal(analytics.trend.reduce((sum, point) => sum + point.chargedMinor, 0), 840);
  assert.ok(analytics.trend.every((point) => point.chargedMinor === 0 || point.date === '2026-11-02'));
  assert.equal(analytics.teamQuota?.chargedMinor, 840);
  assert.equal(analytics.teamQuota?.settledMinor, 720);
  assert.equal(analytics.teamQuota?.heldMinor, 120);
  assert.equal(analytics.teamQuota?.limitedTotalMinor, 1500);
  assert.equal(analytics.teamQuota?.limitedRemainingMinor, 660);
  assert.equal(analytics.teamQuota?.unlimitedCount, 1);
  assert.equal(analytics.members.find((member) => member.userId === 'bob')?.rangeChargedMinor, 500);

  const alice = queryTeamUsage(db, aliceView, range);
  assert.equal(alice.items.length, 6);
  assert.ok(alice.items.every((item) => item.actorUserId === 'alice'));
  assert.throws(() => queryTeamUsage(db, aliceView, { ...range, actorUserId: 'bob' }), (error: unknown) => (error as { status?: number }).status === 403);
  const bob = queryTeamUsage(db, adminView, { ...range, actorUserId: 'bob', outcome: 'succeeded' });
  assert.equal(bob.items.length, 1);
  assert.equal(bob.items[0].taskId, 'b-settled');
  assert.equal(queryTeamUsage(db, adminView, { ...range, module: 'llm' }).items.length, 2);
  assert.equal(queryTeamUsage(db, adminView, { ...range, model: 'company-image2-medium' }).items.length, 7);

  const members = listTeamMembers(db, adminView, { now });
  const aliceMember = members.items.find((member) => member.userId === 'alice');
  assert.equal(aliceMember?.todayChargedMinor, 340);
  assert.equal(aliceMember?.monthChargedMinor, monthlyCostUsage(db, 'alice', '2026-11'));
  assert.equal(aliceMember?.monthSettledMinor, 220);
  assert.equal(aliceMember?.heldMinor, 120);
  assert.equal(aliceMember?.monthlyLimitMinor, 500);
  assert.equal(aliceMember?.remainingMinor, 160);
  assert.equal(aliceMember?.currentConcurrency, 3);
  assert.equal(aliceMember?.concurrencyLimit, 5);
  assert.equal(aliceMember?.attention, true);
  assert.equal(aliceMember?.modules.find((module) => module.module === 'llm')?.chargedMinor, 100);
  assert.equal(listTeamMembers(db, adminView, { now, search: '0001' }).items.map((member) => member.userId).join(','), 'alice');
  assert.equal(listTeamMembers(db, adminView, { now, search: '张三' }).items.length, 1);
  assert.ok(listTeamMembers(db, adminView, { now, attentionOnly: true }).items.every((member) => member.attention));
  assert.throws(() => listTeamMembers(db, aliceView, { now }), (error: unknown) => (error as { status?: number }).status === 403);

  const csv = exportTeamUsageCsv(db, adminView, range);
  assert.ok(csv.includes('attemptId,operationId,taskId'));
  assert.ok(csv.includes('upstream-a-settled-1'));
  assert.ok(csv.includes("'=2+3"), 'CSV 必须防电子表格公式注入');
  const unknownLine = csv.split(/\r?\n/).find((line) => line.includes('a-unpriced'));
  assert.ok(unknownLine?.includes('unpriced'));
  assert.ok(!unknownLine?.match(/,0(?:,|$)/), '未知或未定价费用不得输出 0 金额');
  assert.throws(() => exportTeamUsageCsv(db, aliceView, range), (error: unknown) => (error as { status?: number }).status === 403);

  assert.throws(() => updateTeamMemberPolicy(db, aliceView, {
    targetUserId: 'alice', monthlyLimitMinor: null, personalConcurrency: 9, paused: false, expectedVersion: 1,
  }), (error: unknown) => (error as { status?: number }).status === 403);
  assert.throws(() => updateTeamMemberPolicy(db, adminView, {
    targetUserId: 'alice', monthlyLimitMinor: null, personalConcurrency: 1, paused: true, expectedVersion: 0,
  }), /version/);
  const heldBefore = db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get();
  const updated = updateTeamMemberPolicy(db, adminView, {
    targetUserId: 'alice', monthlyLimitMinor: null, personalConcurrency: 0, paused: true, expectedVersion: 3,
  });
  assert.equal(updated.monthlyLimitMinor, null);
  assert.equal(updated.paused, true);
  assert.equal(updated.personalConcurrency, 0);
  assert.equal(readTeamMemberPolicy(db, aliceView, 'alice').version, 4);
  assert.throws(() => readTeamMemberPolicy(db, aliceView, 'bob'), (error: unknown) => (error as { status?: number }).status === 403);
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), heldBefore, '降额/暂停不得取消已受理任务');

  execution.enqueue(operation('after-pause', 'alice'));
  const paused = execution.admit(identity);
  assert.equal(paused.kind, 'deferred');
  if (paused.kind === 'deferred') assert.ok(paused.reasons.includes('actor_paused'));
  updateTeamMemberPolicy(db, adminView, {
    targetUserId: 'alice', monthlyLimitMinor: null, personalConcurrency: 0, paused: false, expectedVersion: 4,
  });
  execution.enqueue(operation('after-concurrency-cut', 'alice'));
  const limited = execution.admit(identity);
  assert.equal(limited.kind, 'deferred');
  if (limited.kind === 'deferred') assert.ok(limited.reasons.includes('personal_concurrency'));
  assert.equal(db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE state = 'held'").pluck().get(), heldBefore);

  const unpricedSettled = await grant('c-unpriced-settled', 'carol', { unpriced: true });
  await finish(unpricedSettled, 'succeeded', 123);
  const carolUsage = queryTeamUsage(db, adminView, { ...range, actorUserId: 'carol' });
  assert.equal(carolUsage.items.length, 1);
  assert.equal(carolUsage.items[0].costStatus, 'settled', '后补实际费用必须覆盖最初的未定价报价');
  assert.equal(carolUsage.items[0].actualMinor, 123);
  assert.deepEqual(carolUsage.totals, { settledMinor: 123, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });
  const carolMember = listTeamMembers(db, adminView, { now }).items.find((member) => member.userId === 'carol');
  assert.equal(carolMember?.todayChargedMinor, 123);
  assert.equal(carolMember?.monthChargedMinor, monthlyCostUsage(db, 'carol', '2026-11'));
  assert.equal(carolMember?.monthSettledMinor, 123);
  assert.equal(carolMember?.heldMinor, 0);
  assert.equal(carolMember?.modules.find((module) => module.module === 'images')?.chargedMinor, 123);
  const carolSettledCsvLine = exportTeamUsageCsv(db, adminView, { ...range, actorUserId: 'carol' })
    .split(/\r?\n/).find((line) => line.includes('c-unpriced-settled'));
  assert.ok(carolSettledCsvLine?.includes(',settled,'));
  assert.ok(carolSettledCsvLine?.includes(',123,'), '后补实际费用必须进入管理员 CSV');

  const released = await grant('c-released', 'carol', { minor: 100 });
  await finish(released, 'not_created', null);
  const carolAfterRelease = queryTeamUsage(db, adminView, { ...range, actorUserId: 'carol' });
  const releasedRow = carolAfterRelease.items.find((item) => item.taskId === 'c-released');
  assert.equal(carolAfterRelease.items.length, 2);
  assert.equal(releasedRow?.costStatus, 'released');
  assert.equal(releasedRow?.actualMinor, null);
  assert.deepEqual(carolAfterRelease.totals, { settledMinor: 123, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 0 });
  const carolAfterReleaseMember = listTeamMembers(db, adminView, { now }).items.find((member) => member.userId === 'carol');
  assert.equal(carolAfterReleaseMember?.todayChargedMinor, 123);
  assert.equal(carolAfterReleaseMember?.monthChargedMinor, monthlyCostUsage(db, 'carol', '2026-11'));
  assert.equal(carolAfterReleaseMember?.monthSettledMinor, 123);
  assert.equal(carolAfterReleaseMember?.heldMinor, 0);
  const carolReleasedCsvLine = exportTeamUsageCsv(db, adminView, { ...range, actorUserId: 'carol' })
    .split(/\r?\n/).find((line) => line.includes('c-released'))?.split(',');
  assert.equal(carolReleasedCsvLine?.[21], 'released');
  assert.equal(carolReleasedCsvLine?.[22], '', '已释放预留不得出现在 CSV 预估金额');
  assert.equal(carolReleasedCsvLine?.[23], '', '已释放预留不得伪装成实际费用');

  const unpricedUnknown = await grant('c-unpriced-unknown', 'carol', { unpriced: true });
  await finish(unpricedUnknown, 'failed', null, false);
  const carolFinal = queryTeamUsage(db, adminView, { ...range, actorUserId: 'carol' });
  const unknownRow = carolFinal.items.find((item) => item.taskId === 'c-unpriced-unknown');
  assert.equal(carolFinal.items.length, 3);
  assert.equal(unknownRow?.costStatus, 'uncertain', '已提交但未定价的终态必须显示费用不确定');
  assert.equal(unknownRow?.actualMinor, null);
  assert.deepEqual(carolFinal.totals, { settledMinor: 123, estimatedMinor: 0, unpricedCount: 0, uncertainCount: 1 });
  const carolFinalMember = listTeamMembers(db, adminView, { now }).items.find((member) => member.userId === 'carol');
  assert.equal(carolFinalMember?.monthChargedMinor, monthlyCostUsage(db, 'carol', '2026-11'));
  assert.equal(carolFinalMember?.modules.reduce((sum, module) => sum + module.chargedMinor, 0),
    carolFinalMember?.monthChargedMinor, '模块汇总与月度门禁必须共用 released/settled/unknown 费用口径');
  const carolUnknownCsvLine = exportTeamUsageCsv(db, adminView, { ...range, actorUserId: 'carol' })
    .split(/\r?\n/).find((line) => line.includes('c-unpriced-unknown'))?.split(',');
  assert.equal(carolUnknownCsvLine?.[21], 'uncertain');
  assert.equal(carolUnknownCsvLine?.[22], '', '未知费用不得输出预留 0');
  assert.equal(carolUnknownCsvLine?.[23], '', '未知费用不得伪装成实际 0');

  const canceled = execution.enqueue(operation('c-canceled', 'carol')).operation;
  db.prepare("UPDATE execution_operations SET status = 'failed', waitReason = 'stage_canceled', updatedAt = '2099-01-01' WHERE id = ?").run(canceled.id);
  assert.equal(readTeamMemberPolicy(db, adminView, 'carol').waitingReason, null, '历史取消不能成为当前等待原因');
  assert.equal(listTeamMembers(db, adminView, { now }).items.find(member => member.userId === 'carol')?.waitingReason, null);
  db.prepare("UPDATE execution_operations SET status = 'deferred', waitReason = 'pool_capacity' WHERE id = ?").run(canceled.id);
  assert.equal(readTeamMemberPolicy(db, adminView, 'carol').waitingReason, 'pool_capacity');
  assert.equal(listTeamMembers(db, adminView, { now }).items.find(member => member.userId === 'carol')?.waitingReason, 'pool_capacity');

  const usageBeforeDeletion = queryTeamUsage(db, adminView, { ...range, actorUserId: 'carol' });
  db.prepare("UPDATE team_users SET deletedAt='2026-11-10', status='disabled' WHERE id='carol'").run();
  assert.ok(!listTeamMembers(db, adminView, { now }).items.some(member => member.userId === 'carol'));
  assert.ok(!listTeamMembers(db, adminView, { now, search: 'carol' }).items.some(member => member.userId === 'carol'), '搜索也不得重新显示已删除成员');
  assert.deepEqual(queryTeamUsage(db, adminView, { ...range, actorUserId: 'carol' }), usageBeforeDeletion, '成员移出列表不得删除或改写费用历史');
  console.log('PASS: team attempt usage, member consistency, CSV and versioned policy authorization');
} finally {
  runtime.closeNewWork();
  db.close();
  if (previousRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
}
