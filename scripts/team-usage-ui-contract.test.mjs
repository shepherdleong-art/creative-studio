import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const header = read('components/Header.tsx');
// 05 号票起团队版导航搬到左侧分组侧栏：任务/错误入口 href 的权威源变成导航数据，
// 侧栏负责渲染。断言不变（入口必须可达、员工不能越权），只是换到新的持有者。
const sidebar = read('components/team/TeamWorkspaceNavigation.tsx');
const navigation = read('lib/workspace-navigation.ts');
const members = read('components/team/TeamUsersPanel.tsx');
const usage = read('components/team/TeamUsagePanel.tsx');
// 05 号票把用量明细拆成「面板 + 展示映射 + 详情对话框」三个文件，另加共用分页控件；
// 文案与结构断言按真实持有者读，避免为了测试把逻辑塞回一个大文件。
const detailDialog = read('components/team/usage-detail-dialog.tsx');
const usageDisplay = read('components/team/usage-display.ts');
const pagination = read('components/ui/Pagination.tsx');
const pageSizeModule = read('lib/team-service/pagination.ts');
const usageSources = [usage, detailDialog, usageDisplay].join('\n');
const waitingLabels = read('lib/team-task-labels.ts');
const tasks = read('components/team/TeamTasksPanel.tsx');
const errors = read('components/team/TeamErrorsPanel.tsx');

assert.match(navigation, /href: '\/team\/tasks'/, '侧栏必须有「我的任务/全员任务」入口');
assert.match(navigation, /href: '\/team\/errors'/, '侧栏必须有「出错的任务」入口');
assert.match(sidebar, /buildWorkspaceNavigation/, '侧栏必须渲染导航数据，而不是自带一份入口清单');
// 团队版不渲染全局顶栏：Header 的 server 分支必须在 <header> 之前返回。
const serverBranch = header.slice(header.indexOf('if (server) {'), header.indexOf('// ---- 个人本地版'));
assert.ok(serverBranch.length > 0, 'Header 必须有独立的团队版分支');
assert.doesNotMatch(serverBranch, /<header\b/, '团队版分支不得渲染全局顶栏');
assert.equal(header.indexOf('<header className="toolbar'), header.lastIndexOf('<header className="toolbar'), '本地版顶栏只应出现一处（团队版走侧栏）');
for (const label of ['今日', '本月', '预留', '剩余', '并发', '需要关注', '模块明细']) assert.ok(members.includes(label), `成员管理必须显示 ${label}`);
assert.match(members, /search/);
assert.match(members, /attentionOnly/);
assert.match(members, /expectedVersion/);
assert.match(members, /teamPolicyDraftInitialized/, '后台刷新不得覆盖正在编辑的自动/手动与个人草稿');
assert.match(members, /teamModeSelect\.current\?\.value/, '保存必须读取当前表单选择，而不是过期状态');
assert.match(members, /monthlyLimitMinor/);
assert.match(members, /paused/);
assert.match(members, /\/api\/team\/members/);

// ---- 员工只读用量：额度、预留、并发、本地 Agent、暂停仍是必须覆盖的字段 ----
for (const label of ['额度', '预留', '并发', '本地 Agent', '暂停']) assert.ok(usageSources.includes(label), `员工只读用量必须覆盖 ${label}`);

// ---- 05 号票：明细分区页签、费用口径与详情入口（文案按新结构断言） ----
for (const label of ['制作任务', '通道调用', '其他记录', '非统一模型记录', '待映射记录', '查看详情', '用量明细']) {
  assert.ok(usageSources.includes(label), `用量明细必须提供 ${label}`);
}
for (const label of ['待核账', '估算', '混合', '未定价', '已释放', '实际已记录']) {
  assert.ok(usageDisplay.includes(label), `费用文案必须保留 ${label} 口径`);
}
assert.match(usageDisplay, /attemptCostLabel/, '单次调用费用必须有统一文案（不把未知/未定价混成 0 元）');
assert.match(usageDisplay, /STANDBY_CHANNEL_NOTE/, '备用未提交通道必须有单列说明');
assert.match(detailDialog, /备用通道，未提交/, '详情里候选未提交通道必须写「备用通道，未提交」');
assert.match(detailDialog, /width="wide"/, '制作任务/调用记录详情必须用共用 Dialog 的 wide 规格');
assert.match(detailDialog, /技术字段/, '详情必须按需展开技术字段');
assert.match(detailDialog, /break-all/, '长文本只在对话框内换行');
assert.match(usage, /requestAnimationFrame\(\(\) => trigger\.focus\(\)\)/, 'Esc 关闭详情后必须把焦点归还给触发按钮');
assert.match(usage, /mediaTaskId/, '制作任务必须按逻辑任务（mediaTaskId）而不是通道调用计数');
assert.match(usage, /legacyAttempts/, '非统一模型记录数必须来自摘要 counts');
assert.match(usage, /channels/, '管理员可查看真实通道调用');
assert.match(usage, /WAITING_REASON_LABELS/, '用量页使用共享中文等待标签');
for (const label of ['余额不足', '并发等待', '任务已取消']) assert.ok(waitingLabels.includes(label), `共享等待标签必须覆盖 ${label}`);

// ---- 摘要与明细分开请求：两个 fetch、各自的 loading/error、翻页只动明细 ----
assert.match(usage, /\/api\/team\/usage/, '用量页必须请求 /api/team/usage');
assert.equal((usage.match(/fetch\(`/g) ?? []).length, 2, '摘要与明细必须各自请求（两个 fetch），不能合成一次全量拉取');
assert.match(usage, /params\.set\('section', section\)/, '明细请求必须带当前页签的 section');
assert.match(usage, /params\.set\('page', String\(page\)\)/, '明细请求必须带页码');
assert.match(usage, /params\.set\('pageSize', String\(pageSize\)\)/, '明细请求必须带每页条数');
assert.doesNotMatch(usage, /section=summary.*page=/, '摘要请求不得携带分页参数');
assert.match(
  usage,
  /\}, \[server, period, from, to, model, outcome, scope, selectedMember, summaryNonce\]\);/,
  '摘要请求不得依赖页码/页签：翻页与切 section 不能重新下载汇总',
);
assert.match(usage, /signal: controller\.signal/, '两个请求都必须可取消（防止旧响应覆盖新页）');
assert.match(usage, /controller\.abort\(\)/, '切换筛选/页签/页码时必须取消在途请求');
assert.match(usage, /if \(body\.pagination\.page !== page\) setPage\(body\.pagination\.page\);/, '越界页只能按响应 pagination.page 收敛一次，不循环重请求');
assert.match(usage, /setListError/, '明细失败必须单独保留错误');
assert.match(usage, /setSummaryError/, '摘要失败必须单独保留错误');
assert.match(usage, /setListNonce/, '明细失败必须提供重试入口');
assert.match(usage, /const changeTab = \(next: DetailTab\) => \{ setTab\(next\); setPage\(1\); \}/, '切页签必须回第 1 页');
assert.match(usage, /const changeOtherKind = \(next: OtherKind\) => \{ setOtherKind\(next\); setPage\(1\); \}/, '切其他记录类型必须回第 1 页');
assert.match(usage, /if \(next\.pageSize !== pageSize\) \{ setPageSize\(next\.pageSize\); setPage\(1\); return; \}/, '改 pageSize 必须回第 1 页');
assert.match(usage, /if \(body\.pagination\.page !== page\)/, '越界页收敛');
assert.ok(!/setSummary\(null\)/.test(usage), '翻页/切页签不得清空摘要（图表与金额不随页变）');
assert.ok(!/setList\(null\)/.test(usage), '刷新/筛选变化不得把列表清成假「0 条」');

// ---- 角色边界：员工不渲染也不请求管理员专用 section ----
assert.match(usage, /isAdminOnlyUsageSection/, '员工/管理员页签边界必须走 04 号票的 section 权限表');
assert.match(usage, /if \(!admin && isAdminOnlyUsageSection\(wanted\)\) return 'legacy';/, '员工的其他记录只能落到 legacy');
assert.match(usage, /if \(tab === 'channels'\) return admin \? 'channels' : 'tasks';/, '员工不得落到 channels');
assert.match(usage, /canViewTeam/, '管理员页签由服务端 canViewTeam 决定');

// ---- 布局顺序：额度卡 → 账期与筛选 → 图表 → 成员统计 → 明细页签 ----
const order = ['<QuotaCards', '<GroupList>', '<ModelAnalysis', '<MemberTable', 'aria-label="用量明细"'];
const positions = order.map((marker) => usage.indexOf(marker));
for (let index = 0; index < positions.length; index += 1) {
  assert.ok(positions[index] >= 0, `布局顺序检查找不到 ${order[index]}`);
  if (index > 0) assert.ok(positions[index] > positions[index - 1], `${order[index]} 必须排在 ${order[index - 1]} 之后（图表固定在所有明细之前）`);
}
assert.equal((usage.match(/<Pagination\b/g) ?? []).length, 2, '分页控件必须同时放在明细列表上方和下方');
assert.match(usage, /uses self\.pagination|pagination\.total/, '统计总数读服务端分页元数据，不用当前页数组长度');
assert.match(usage, /summary\.counts\.generationTasks/, '制作任务总数读摘要 counts');
assert.match(usage, /summary\.counts\.channelCalls/, '通道调用总数读摘要 counts');
assert.match(usage, /summary\.members/, '成员统计读摘要 members');
assert.doesNotMatch(usage, /items\.length\s*\)\s*\}?\s*(个制作任务|条记录)/, '不得用当前页数组长度当总数');

// ---- CSV：完整范围导出（业务筛选 + scope，不带 section/page） ----
assert.match(usage, /\/api\/team\/usage\/export\?\$\{exportParams\}/, 'CSV 导出链接必须沿用业务筛选');
assert.doesNotMatch(usage, /exportParams\.set\('(section|page|pageSize)'/, 'CSV 导出链接不得带 section/page/pageSize');

// ---- 共用分页控件：受控、25/50、页码折叠、跳页、禁用状态，且不写第二套规则 ----
assert.match(pagination, /TEAM_PAGE_SIZE_OPTIONS/, '每页条数选项必须来自 03 号票的公共分页模块');
assert.match(pagination, /DEFAULT_TEAM_PAGE_SIZE|TeamPageSize/, '分页控件的类型必须来自公共分页模块');
assert.match(pageSizeModule, /TEAM_PAGE_SIZE_OPTIONS = \[25, 50\]/, '每页条数只有 25/50 两档');
assert.doesNotMatch(pagination, /\[25,\s*50\]/, '分页控件不得另写一份每页条数选项');
assert.match(pagination, /paginationPages/, '超过 7 页必须收起中间页码');
assert.match(pagination, /'gap'/, '页码折叠用省略号占位');
assert.match(pagination, /上一页/, '分页控件必须有上一页');
assert.match(pagination, /下一页/, '分页控件必须有下一页');
assert.match(pagination, /跳转页码/, '分页控件必须可输入页码跳转');
assert.match(pagination, /disabled=\{atFirst\}/, '首页必须禁用上一页');
assert.match(pagination, /disabled=\{atLast\}/, '末页必须禁用下一页');
assert.match(pagination, /aria-current=/, '当前页必须有 aria-current');
assert.match(pagination, /onChange\(\{ page: 1, pageSize: next \}\)/, '每页条数变化由分页控件统一回第 1 页');
assert.match(usage, /DEFAULT_TEAM_PAGE_SIZE/, '用量明细默认每页条数必须来自公共分页模块');

for (const source of [members, usage, tasks, errors]) {
  assert.doesNotMatch(source, /原型\s*[ABC]|布局\s*[ABC]/, '不得采用未选定的原型 A/B/C 布局');
}
assert.match(usage, /<PageToolbar/, '用量页必须挂每页工具栏（标题由外壳解析）');
assert.doesNotMatch(usage, /<h1\b/, '用量页不得自带 <h1>（会出现两个大标题）');

assert.match(tasks, /\/api\/team\/tasks/);
assert.match(tasks, /waitReason|等待原因/);
assert.match(tasks, /groupTeamTaskRows/, '任务列表必须把同一制作任务的多条执行记录合并展示');
assert.match(tasks, /unifiedTaskId/, '任务列表必须使用统一任务身份分组');
assert.match(tasks, /同一制作任务/, '任务列表需明确同属一条作品');
assert.match(errors, /\/api\/team\/errors/);
assert.match(errors, /diagnostics/);
assert.match(errors, /下载诊断包/);
assert.match(usage, /\/api\/team\/usage/);
assert.doesNotMatch(usageSources, /teamWrite\(|method:\s*['"]PATCH/, '员工用量 UI 不得提供策略写入');

console.log('PASS: team usage, member, task and diagnostic UI contracts');
