import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/projects/[id]/final-edit/groups/route.ts', 'utf8');
assert.match(
  route,
  /ORDER BY updatedAt DESC, createdAt DESC/,
  '刷新时必须优先恢复最近更新的 editing draft，不能只按创建时间',
);
assert.match(
  route,
  /getFinalEditWorkspace\(\)\.load\(row\.id\)/,
  'group 列表必须经 workspace.load() 投影，renderRevision 等派生字段不得在路由层另写一份',
);

const jobRoute = fs.readFileSync('app/api/final-edit-jobs/[id]/route.ts', 'utf8');
assert.match(jobRoute, /renderRevision/, '单 job API 必须返回 renderRevision 双 revision 标量');
assert.match(jobRoute, /parseRenderRevisionFromSnapshot/, '单 job API 必须复用统一的快照解析，不得内联第二份解析逻辑');
assert.match(jobRoute, /delete publicRow\.inputSnapshotJson/, '单 job API 不得把整个 inputSnapshotJson 返给前端');

console.log('final-edit groups route contract tests passed');
