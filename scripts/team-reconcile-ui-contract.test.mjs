// 02 号票：待核对页面合同（文本/结构层）。
//
// 这里只钉「页面必须保留的核对语义」和「这次要求的通俗文案」：
//   - 权限与接口入口不变；
//   - 五个合法核对动作、证据必填、版本校验、幂等字段仍在；
//   - 默认只看待核对，全部记录写明包含已完成任务；
//   - 空态区分「没有待核对项」与「没有历史记录」；
//   - 技术字段和人工表单默认折叠；
//   - 页面不得出现「强制重发 / 超时释放 / 自动查询 / 保证成功」这类越权或空头承诺。
//
// 运行：node scripts/team-reconcile-ui-contract.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const panel = fs.readFileSync(path.join(repoRoot, 'components/team/TeamReconcilePanel.tsx'), 'utf8');
const display = fs.readFileSync(path.join(repoRoot, 'components/team/reconcile-display.ts'), 'utf8');
const page = fs.readFileSync(path.join(repoRoot, 'app/team/admin/reconcile/page.tsx'), 'utf8');
const nav = fs.readFileSync(path.join(repoRoot, 'lib/workspace-navigation.ts'), 'utf8');
const route = fs.readFileSync(path.join(repoRoot, 'app/api/team/reconcile/route.ts'), 'utf8');

// ---------- 权限与接口入口：不能被展示改版碰掉 ----------
assert.match(nav, /href: '\/team\/admin\/reconcile', label: '待核对'/);
assert.match(page, /principal\.role !== 'admin'/);
assert.match(route, /withTeamRoute\('\/api\/team\/reconcile', 'GET'/);
assert.match(route, /withTeamRoute\('\/api\/team\/reconcile', 'POST'/);

// ---------- 原有合法核对动作与安全字段：一个都不能少 ----------
for (const text of [
  '补远端 ID',
  '确认未创建',
  '确认成功',
  '确认失败',
  '仍无法确认',
  'expectedVersion',
  'idempotencyKey',
  '原结果地址',
  '也不会在这里发起新的付费生成',
]) {
  assert.ok(panel.includes(text), `待核对页面缺少 ${text}`);
}
// 证据必填（至少 4 个字符）与目标尝试选择仍在。
assert.match(panel, /draft\.evidence\.trim\(\)\.length < 4/);
assert.match(panel, /目标尝试/);
assert.match(panel, /核对依据（必填/);

// ---------- 这次要求的通俗文案 ----------
assert.match(panel, /useState<'attention' \| 'all'>\('attention'\)/, '默认必须仍是只看待核对');
for (const text of [
  '只看待核对',
  '全部记录',
  '包含已完成的统一模型任务',
  '目前无需人工处理',
  '以下是历史记录，无需逐条核对',
  '没有待核对项',
  '没有历史记录',
  '核对详情',
  '人工核对',
  '费用状态',
]) {
  assert.ok(panel.includes(text), `待核对页面缺少新文案 ${text}`);
}
assert.equal(panel.includes('全部统一任务'), false, '旧标签「全部统一任务」必须改掉');
// 通俗原因由纯展示映射给出，不把派生说明写回业务状态。
assert.match(panel, /from '\.\/reconcile-display'/);
assert.match(panel, /describeReconcileTask/);
assert.match(display, /备用通道，未提交/);
assert.match(display, /当前没有向这条通道提交，也不会产生额外费用。/);

// ---------- 折叠结构：技术字段与人工表单默认不展开 ----------
for (const testId of [
  'data-testid="reconcile-details"',
  'data-testid="reconcile-form"',
  'data-testid="reconcile-reason"',
]) {
  assert.ok(panel.includes(testId), `待核对页面缺少 ${testId}`);
}
const detailsIndex = panel.indexOf('data-testid="reconcile-details"');
const detailsGuardIndex = panel.indexOf('expandedDetails[task.mediaTaskId]');
assert.ok(detailsGuardIndex >= 0 && detailsGuardIndex < detailsIndex, '核对详情必须由展开状态守卫');
const formIndex = panel.indexOf('data-testid="reconcile-form"');
const formGuardIndex = panel.indexOf('expandedForm[task.mediaTaskId]');
assert.ok(formGuardIndex >= 0 && formGuardIndex < formIndex, '人工核对表单必须由展开状态守卫');
// 技术字段（任务 ID / 规则版本 / 原始错误）只在核对详情里出现。
assert.ok(panel.includes('task.taskId'), '核对详情仍需保留任务 ID 供排查');
assert.ok(panel.includes('task.ruleVersion'), '核对详情仍需保留规则版本');
assert.ok(panel.includes('attempt.errorCode'), '核对详情仍需保留原始技术错误');

// ---------- legacy 未知记录入口保留 ----------
assert.ok(panel.includes('旧执行证据（无法关联统一任务）'));
assert.ok(panel.includes('data?.legacyItems.length'));

// ---------- 禁止越权动作与空头承诺 ----------
assert.equal(/强制失败|强制重发|超时释放/.test(panel + display), false, '页面不得提供绕过证据的强制动作');
assert.equal(/自动查询|自动重试|稍微成功|稍后成功|保证成功|预计成功/.test(panel + display), false, '页面不得承诺自动查询或保证成功');
assert.equal(/推定失败|重新提交|释放占用/.test(panel), false, '展示改版不得出现重发 / 推定失败 / 释放占用的入口');

console.log('team reconcile UI contract passed');
