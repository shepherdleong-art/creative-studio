import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const header = read('components/Header.tsx');
const members = read('components/team/TeamUsersPanel.tsx');
const usage = read('components/team/TeamUsagePanel.tsx');
const waitingLabels = read('lib/team-task-labels.ts');
const tasks = read('components/team/TeamTasksPanel.tsx');
const errors = read('components/team/TeamErrorsPanel.tsx');

assert.match(header, /href=["']\/team\/tasks["']/);
assert.match(header, /href=["']\/team\/errors["']/);
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
assert.match(usage, /WAITING_REASON_LABELS/, '用量页使用共享中文等待标签');
for (const label of ['余额不足', '并发等待', '任务已取消']) assert.ok(waitingLabels.includes(label), `共享等待标签必须覆盖 ${label}`);
assert.match(usage, /\/api\/team\/usage/);
assert.doesNotMatch(usage, /teamWrite\(|method:\s*['"]PATCH/, '员工用量 UI 不得提供策略写入');
assert.match(tasks, /\/api\/team\/tasks/);
assert.match(tasks, /waitReason|等待原因/);
assert.match(errors, /\/api\/team\/errors/);
assert.match(errors, /diagnostics/);
assert.match(errors, /下载诊断包/);
for (const source of [members, usage, tasks, errors]) {
  assert.doesNotMatch(source, /原型\s*[ABC]|布局\s*[ABC]/, '不得采用未选定的原型 A/B/C 布局');
}

console.log('PASS: team usage, member, task and diagnostic UI contracts');
