// 05 号票：团队版外壳的导航数据结构、页面标题与数量角标口径。
// 纯函数优先，页面级由 team-workspace-shell.playwright.test.mjs 覆盖。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildWorkspaceNavigation,
  workspaceProductName,
  workspacePageTitle,
  workspaceBadgeCounts,
  formatBadgeCount,
  isWorkspaceNavActive,
  workspaceNavigationFor,
  WORKSPACE_MENU_LINKS,
} from '../lib/workspace-navigation.ts';

// ---- 员工端：三组，分组名与顺序逐字对齐规格 ----
const employee = buildWorkspaceNavigation({ role: 'employee', canvasEnabled: true });
assert.deepEqual(employee.map((group) => group.title), ['创作', '进度', '账目']);
assert.deepEqual(employee.map((group) => group.items.map((item) => item.label)), [
  ['工作台', '我的项目', '创作画布'],
  ['我的任务', '下载与交付', '出错的任务'],
  ['我的用量'],
]);
assert.deepEqual(employee.flatMap((group) => group.items.map((item) => item.href)), [
  '/', '/projects', '/canvas', '/team/tasks', '/team/downloads', '/team/errors', '/usage',
]);
assert.deepEqual(employee.flatMap((group) => group.items.filter((item) => item.badge).map((item) => [item.label, item.badge])), [
  ['我的任务', 'tasks'], ['出错的任务', 'errors'],
]);

// ---- 管理员端：五组，分组名与顺序逐字对齐规格 ----
const admin = buildWorkspaceNavigation({ role: 'admin', canvasEnabled: true });
assert.deepEqual(admin.map((group) => group.title), ['总览', '生产', '资源', '团队', '系统']);
assert.deepEqual(admin.map((group) => group.items.map((item) => item.label)), [
  ['运行总览'],
  ['项目空间', '创作画布', '全员任务', '下载与交付', '出错的任务'],
  ['模型与名额', '供应商配置', '公共资源'],
  ['成员与账号', '团队用量'],
  ['版本与备份'],
]);
assert.deepEqual(admin.flatMap((group) => group.items.map((item) => item.href)), [
  '/', '/projects', '/canvas', '/team/tasks', '/team/downloads', '/team/errors',
  '/team/admin/pools', '/settings', '/team/admin/resources',
  '/team/admin/users', '/usage',
  '/team/admin/operations',
]);

// ---- 画布开关关闭时不出现画布入口（两种角色） ----
for (const role of ['employee', 'admin'] as const) {
  const labels = buildWorkspaceNavigation({ role, canvasEnabled: false }).flatMap((group) => group.items.map((item) => item.label));
  assert.equal(labels.includes('创作画布'), false, `${role} 关闭画布时不应出现创作画布`);
  // 去掉画布只少一项，其余入口与分组原样保留
  const withCanvas = buildWorkspaceNavigation({ role, canvasEnabled: true });
  assert.deepEqual(
    labels,
    withCanvas.flatMap((group) => group.items.map((item) => item.label)).filter((label) => label !== '创作画布'),
    `${role} 去掉画布不应影响其余入口`,
  );
  assert.deepEqual(buildWorkspaceNavigation({ role, canvasEnabled: false }).map((group) => group.title), withCanvas.map((group) => group.title));
}
assert.equal(buildWorkspaceNavigation({ role: 'employee', canvasEnabled: false }).length, 3, '关闭画布仍保留三组');

// ---- 改名（路由不变）：旧名字一律不得再出现在导航数据里 ----
const serialized = JSON.stringify({ employee, admin });
for (const banned of ['异常中心', '模型与并发', '团队生产控制台', '我的创作空间', '错误中心']) {
  assert.equal(serialized.includes(banned), false, `导航数据不得再出现旧名字「${banned}」`);
}

// ---- 端名 ----
assert.equal(workspaceProductName('employee'), '林视创作台');
assert.equal(workspaceProductName('admin'), '林视控制台');
assert.equal(workspaceProductName(null), '林视 Lin\'s Vision', '未登录/本地版用完整端名');

// ---- 每页工具栏标题：沿用导航名 ----
const titleCases: Array<[string, 'employee' | 'admin', string | null]> = [
  ['/', 'employee', '工作台'],
  ['/', 'admin', '运行总览'],
  ['/projects', 'employee', '我的项目'],
  ['/projects', 'admin', '项目空间'],
  ['/canvas', 'employee', '创作画布'],
  ['/team/tasks', 'employee', '我的任务'],
  ['/team/tasks', 'admin', '全员任务'],
  ['/team/downloads', 'employee', '下载与交付'],
  ['/team/errors', 'employee', '出错的任务'],
  ['/team/errors', 'admin', '出错的任务'],
  ['/usage', 'employee', '我的用量'],
  ['/usage', 'admin', '团队用量'],
  ['/team/admin/pools', 'admin', '模型与名额'],
  ['/settings', 'admin', '供应商配置'],
  ['/team/admin/resources', 'admin', '公共资源'],
  ['/team/admin/users', 'admin', '成员与账号'],
  ['/team/admin/operations', 'admin', '版本与备份'],
  ['/projects/new', 'employee', '新建项目'],
  ['/team/recycle-bin', 'employee', '回收站'],
  ['/team/account', 'employee', '修改密码'],
  ['/team/errors/abc/task', 'employee', '关联制作任务'],
];
for (const [pathname, role, expected] of titleCases) {
  assert.equal(workspacePageTitle(pathname, role), expected, `${role} ${pathname}`);
}
// 画布关闭时页面标题仍可解析（页面本身有开关闸门），但导航里没有入口
assert.equal(workspacePageTitle('/canvas', 'employee'), '创作画布');

// ---- 当前项判定：精确匹配 + 子路径前缀，但 / 只精确匹配 ----
assert.equal(isWorkspaceNavActive('/', '/'), true);
assert.equal(isWorkspaceNavActive('/projects', '/'), false, '首页只在自己的路径高亮');
assert.equal(isWorkspaceNavActive('/projects/new', '/projects'), true);
assert.equal(isWorkspaceNavActive('/team/tasks', '/team/tasks'), true);
assert.equal(isWorkspaceNavActive('/team/errors/abc/task', '/team/errors'), true);

// ---- 数量角标口径：与对应页面条目数一致（同一接口、同一可见范围） ----
assert.deepEqual(
  workspaceBadgeCounts({
    tasks: { items: [{ operationId: 'a' }, { operationId: 'b' }] },
    errors: { items: [{ errorId: 'e1' }] },
  }),
  { tasks: 2, errors: 1 },
);
// 接口不可用时宁可不显示，也不显示 0 或猜测值
assert.deepEqual(workspaceBadgeCounts({}), { tasks: null, errors: null });
assert.deepEqual(workspaceBadgeCounts({ tasks: { items: 'bad' }, errors: null }), { tasks: null, errors: null });
// 角标文案：0 不显示，其余用十进制数字
assert.equal(formatBadgeCount(0), null);
assert.equal(formatBadgeCount(null), null);
assert.equal(formatBadgeCount(7), '7');
assert.equal(formatBadgeCount(500), '500');

// ---- 导航项按 badge 键查找（外壳据此取数） ----
const navKeys = workspaceNavigationFor({ role: 'admin', canvasEnabled: true });
assert.ok(navKeys.length > 0);
const badgeItems = navKeys.flatMap((group) => group.items).filter((item) => item.badge);
assert.deepEqual(badgeItems.map((item) => item.badge), ['tasks', 'errors']);
assert.deepEqual(badgeItems.map((item) => item.href), ['/team/tasks', '/team/errors']);

// ---- 图标名必须真的是 Icon.tsx 里已有的名字（不引入新图标族） ----
const iconSource = fs.readFileSync(new URL('../components/ui/Icon.tsx', import.meta.url), 'utf8');
const iconUnion = iconSource.slice(iconSource.indexOf('export type IconName'), iconSource.indexOf('const PATHS'));
const knownIcons = new Set([...iconUnion.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]));
const usedIcons = new Set([
  ...buildWorkspaceNavigation({ role: 'employee', canvasEnabled: true }).flatMap((group) => group.items.map((item) => item.icon)),
  ...buildWorkspaceNavigation({ role: 'admin', canvasEnabled: true }).flatMap((group) => group.items.map((item) => item.icon)),
  ...WORKSPACE_MENU_LINKS.map((link) => link.icon),
]);
for (const icon of usedIcons) assert.ok(knownIcons.has(icon), `组件/ui/Icon.tsx 里没有图标「${icon}」`);

console.log('workspace navigation contract passed');

