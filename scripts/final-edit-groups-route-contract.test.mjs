import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/projects/[id]/final-edit/groups/route.ts', 'utf8');
assert.match(
  route,
  /ORDER BY updatedAt DESC, createdAt DESC/,
  '刷新时必须优先恢复最近更新的 editing draft，不能只按创建时间',
);

console.log('final-edit groups route contract tests passed');
