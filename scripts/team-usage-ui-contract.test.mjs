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
for (const label of ['额度', '预留', '并发', '本地 Agent', '暂停']) assert.ok(usage.includes(label), `员工只读用量必须覆盖 ${label}`);
for (const label of ['制作任务合计', '通道调用明细', '未映射历史记录', '展开真实通道尝试', '待核账', '估算', '混合', '制作任务', '通道调用']) {
  assert.ok(usage.includes(label), `统一模型费用报表必须显示 ${label}`);
}
assert.match(usage, /unifiedTaskId|mediaTaskId/, '制作任务必须按逻辑任务而不是通道调用计数');
assert.match(usage, /legacyAttempts/, '无法映射的历史记录必须单列');
assert.match(usage, /channels/, '管理员可展开真实通道尝试');
assert.match(usage, /WAITING_REASON_LABELS/, '用量页使用共享中文等待标签');
for (const label of ['余额不足', '并发等待', '任务已取消']) assert.ok(waitingLabels.includes(label), `共享等待标签必须覆盖 ${label}`);
assert.match(usage, /\/api\/team\/usage/);
assert.doesNotMatch(usage, /teamWrite\(|method:\s*['"]PATCH/, '员工用量 UI 不得提供策略写入');
assert.match(tasks, /\/api\/team\/tasks/);
assert.match(tasks, /waitReason|等待原因/);
assert.match(tasks, /groupTeamTaskRows/, '任务列表必须把同一制作任务的多条执行记录合并展示');
assert.match(tasks, /unifiedTaskId/, '任务列表必须使用统一任务身份分组');
assert.match(tasks, /同一制作任务/, '任务列表需明确同属一条作品');
assert.match(errors, /\/api\/team\/errors/);
assert.match(errors, /diagnostics/);
assert.match(errors, /下载诊断包/);
for (const source of [members, usage, tasks, errors]) {
  assert.doesNotMatch(source, /原型\s*[ABC]|布局\s*[ABC]/, '不得采用未选定的原型 A/B/C 布局');
}

console.log('PASS: team usage, member, task and diagnostic UI contracts');
