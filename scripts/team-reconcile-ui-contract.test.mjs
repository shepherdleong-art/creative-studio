import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const panel = fs.readFileSync(path.join(repoRoot, 'components/team/TeamReconcilePanel.tsx'), 'utf8');
const page = fs.readFileSync(path.join(repoRoot, 'app/team/admin/reconcile/page.tsx'), 'utf8');
const nav = fs.readFileSync(path.join(repoRoot, 'lib/workspace-navigation.ts'), 'utf8');
const route = fs.readFileSync(path.join(repoRoot, 'app/api/team/reconcile/route.ts'), 'utf8');

assert.match(nav, /href: '\/team\/admin\/reconcile', label: '待核对'/);
assert.match(page, /principal\.role !== 'admin'/);
assert.match(route, /withTeamRoute\('\/api\/team\/reconcile', 'GET'/);
assert.match(route, /withTeamRoute\('\/api\/team\/reconcile', 'POST'/);
for (const text of ['补远端 ID', '确认未创建', '确认成功', '确认失败', '仍无法确认', 'expectedVersion', 'idempotencyKey']) {
  assert.ok(panel.includes(text), `待核对页面缺少 ${text}`);
}
assert.ok(panel.includes('也不会在这里发起新的付费生成'));
assert.ok(panel.includes('原结果地址'));
assert.equal(/强制失败|强制重发|超时释放/.test(panel), false, '页面不得提供绕过证据的强制动作');

console.log('team reconcile UI contract passed');
