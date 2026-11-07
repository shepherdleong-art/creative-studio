// 05 号票：外壳的静态契约（不启浏览器，保护那些只能在代码里断言的规则）。
//
// 浏览器行为（分组渲染、菜单、主题、角标、标题、无横向滚动）由
// scripts/team-workspace-shell.playwright.test.mjs 覆盖；这里锁住几条
// 「改坏了浏览器测试也可能悄悄通过」的结构性规则。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const header = read('components/Header.tsx');
const sidebar = read('components/team/TeamWorkspaceNavigation.tsx');
const toolbar = read('components/team/PageToolbar.tsx');
const theme = read('components/ThemeToggle.tsx');
const layout = read('app/layout.tsx');
const workspaceLayout = read('app/(workspace)/layout.tsx');
const css = read('components/team/workspace.module.css');
const navigation = read('lib/workspace-navigation.ts');

// ---- 1. 团队版没有全局顶栏；本地版保留 ----
const serverBranch = header.slice(header.indexOf('if (server) {'), header.indexOf('// ---- 个人本地版'));
assert.ok(serverBranch.includes('TeamWorkspaceNavigation'), '团队版分支必须只挂侧栏');
assert.doesNotMatch(serverBranch, /<header\b/, '团队版分支不得渲染全局顶栏');
assert.match(header, /deploymentMode === 'server'/, '两种模式必须靠 deploymentMode 区分');
// 「停止服务」只属于个人本地版
const localBranch = header.slice(header.indexOf('// ---- 个人本地版'));
assert.match(localBranch, /停止服务/, '本地版必须保留停止服务');
assert.doesNotMatch(serverBranch, /停止服务|handleStop|api\/shutdown/, '团队版不得出现停止服务');
// 本地版显示新名字 + 叶子标志
assert.match(localBranch, /workspaceProductName\(null\)/, '本地版顶栏必须用新端名');
assert.match(localBranch, /WorkspaceLeafMark/, '本地版顶栏必须有叶子标志');

// ---- 2. 团队版不再套 980px 居中栏 ----
assert.match(layout, /data-workspace-shell/, 'layout 必须标记团队版外壳');
assert.match(layout, /max-w-\[980px\]/, '本地版仍保留 980px 居中栏');
assert.match(layout, /team \?/, '980 居中栏必须只在非团队版生效');

// ---- 3. 外观三档：同一个存储键、同一个桌面桥 ----
assert.match(theme, /creative-studio-theme/, '外观偏好键不得改名');
assert.match(theme, /document\.documentElement\.dataset\.theme/, '切换必须落到 html[data-theme]');
assert.match(theme, /setThemePreference/, '桌面壳原生主题必须同步');
assert.match(sidebar, /useThemePreference/, '头像菜单必须复用同一套外观逻辑');
assert.match(sidebar, /THEME_MENU_ORDER/, '头像菜单必须复用三档文案');
// 不得出现第二个存储键
assert.equal((theme.match(/localStorage\.setItem/g) ?? []).length, 1, '外观只应有一个写入点');

// ---- 4. 头像菜单四项 + 提示行 ----
for (const label of ['修改密码', '回收站', '退出登录']) {
  assert.ok(`${sidebar}${navigation}`.includes(label), `头像菜单必须包含「${label}」`);
}
assert.match(sidebar, /关闭窗口不会中断服务器任务/, '头像菜单必须有底部提示行');
assert.match(navigation, /href: '\/team\/account'/, '修改密码指向 /team/account');
assert.match(navigation, /href: '\/team\/recycle-bin'/, '回收站指向 /team/recycle-bin');
assert.match(sidebar, /\/api\/team\/auth\/logout/, '退出登录必须走现有登出接口');
assert.match(sidebar, /\/team\/login/, '退出后回登录页');

// ---- 5. 更新入口与诊断上报沿用现有链路 ----
assert.match(sidebar, /installClientUpdate/, '修复并更新必须走现有 bridge 入口');
assert.match(sidebar, /\/api\/team\/errors\/report/, '更新失败必须走上报告知链路');
assert.match(sidebar, /clientCompatible/, '过旧提示必须由 compatible 闸门控制');
assert.match(sidebar, /修复并更新/, '提示条文案必须是「修复并更新」');

// ---- 6. 侧栏几何：固定左侧 + 主区让位；团队版去 980 ----
assert.match(css, /--workspace-sidebar-width/, '侧栏宽度必须是单一来源');
assert.match(css, /position: fixed/, '侧栏必须固定左侧');
assert.match(css, /margin-left: var\(--workspace-sidebar-width\)/, '主区必须让出侧栏宽度');
assert.match(css, /@media \(max-width: 760px\)/, '保留现有 760px 收图标条行为（完整方案归 15）');

// ---- 7. 导航数据是唯一来源：侧栏不得自建入口清单 ----
assert.match(sidebar, /buildWorkspaceNavigation/, '侧栏必须从导航数据取入口');
// 品牌位固定回首页是唯一允许的硬编码 href；导航行必须全部来自数据。
const hardcodedNavHrefs = [...sidebar.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]).filter((href) => href !== '/');
assert.deepEqual(hardcodedNavHrefs, [], '导航行不得硬编码 href（只允许品牌位回首页）');
// 标题由外壳统一解析（页面工具栏可选覆盖），两处都不得自带一份标题表。
const pageHeader = read('components/team/WorkspacePageHeader.tsx');
assert.match(pageHeader, /workspacePageTitle/, '外壳标题必须沿用导航名');
assert.match(toolbar, /usePageToolbarClaim/, '页面工具栏必须登记，避免与外壳标题条并存');
assert.match(workspaceLayout, /requireTeamPageAccess/, '(workspace) 布局必须保留访问闸门');
// 标题必须挂在根布局的 <main> 里：团队版页面分散在 (workspace)/** 与 app/team/** 两条
// 路由树，只有根布局能一次覆盖全部页面。
const chrome = read('components/team/WorkspacePageChrome.tsx');
assert.match(chrome, /WorkspacePageHeader/, '根布局标题入口必须复用同一个标题组件');
assert.match(chrome, /resolveSession/, '标题入口必须按真实会话取角色');
assert.match(layout, /WorkspacePageChrome/, '根布局必须挂上团队版页面标题');
assert.match(layout, /team && \(/, '标题只在团队版渲染');

// ---- 8. 画布开关关闭时无画布入口（数据层已在单测覆盖，这里锁住过滤逻辑存在） ----
assert.match(navigation, /requiresCanvas/, '导航数据必须标记画布项');
assert.match(navigation, /canvasEnabled/, '导航构建必须吃画布开关');

console.log('team workspace shell contract passed');
