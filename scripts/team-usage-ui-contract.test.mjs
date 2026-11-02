import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const header = read('components/Header.tsx');
const members = read('components/team/TeamUsersPanel.tsx');
const usage = read('components/team/TeamUsagePanel.tsx');
const tasks = read('components/team/TeamTasksPanel.tsx');
const errors = read('components/team/TeamErrorsPanel.tsx');

assert.match(header, /href=["']\/team\/tasks["']/);
assert.match(header, /href=["']\/team\/errors["']/);
for (const label of ['今日', '本月', '预留', '剩余', '并发', '需要关注', '模块明细']) assert.ok(members.includes(label), `成员管理必须显示 ${label}`);
assert.match(members, /search/);
assert.match(members, /attentionOnly/);
assert.match(members, /expectedVersion/);
assert.match(members, /monthlyLimitMinor/);
assert.match(members, /paused/);
assert.match(members, /\/api\/team\/members/);
for (const label of ['额度', '预留', '并发', '本地 Agent', '余额不足', '并发等待', '暂停']) assert.ok(usage.includes(label), `员工只读用量必须覆盖 ${label}`);
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
