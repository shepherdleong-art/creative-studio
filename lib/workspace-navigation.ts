/**
 * 团队版工作区外壳的导航数据（05 号票）。
 *
 * 这里是「端 → 分组 → 导航项」的唯一权威源：侧栏、每页工具栏标题、数量角标都从
 * 这里取，页面本身不再各自硬编码入口名。分组、顺序与文案逐字对齐
 * `docs/superpowers/specs/2026-11-07-林视界面重设计-功能方案.md`「工作区外壳与导航」，
 * 路由地址保持原样（改名不改路由）。
 *
 * 纯数据 + 纯函数，不 import React/Next，可被 Node 单测直接跑。
 */

export type WorkspaceRole = 'employee' | 'admin';

/** 首页新建入口；尚未接入的入口只显示开发中提示。 */
export const WORKSPACE_CREATE_ENTRIES: ReadonlyArray<{
  name: string;
  text: string;
  icon: WorkspaceNavIcon | 'film';
  href?: string;
  requiresCanvas?: boolean;
}> = [
  { name: '常规项目', text: '场景、分镜到成片', icon: 'film', href: '/projects/new' },
  { name: '一键成片', text: '功能开发中，敬请期待', icon: 'grid' },
  { name: '实拍混剪', text: '功能开发中，敬请期待', icon: 'film' },
  { name: '创作画布', text: '连接灵感与生成流程', icon: 'sparkle', href: '/canvas', requiresCanvas: true },
];

/** 侧栏数量角标的取数字段：与对应页面的列表接口一一对应。 */
export type WorkspaceBadgeKey = 'tasks' | 'errors';

export interface WorkspaceNavItem {
  href: string;
  label: string;
  /** Icon.tsx 里的图标名；不引入新图标族。 */
  icon: WorkspaceNavIcon;
  /** 需要显示数量角标的入口。 */
  badge?: WorkspaceBadgeKey;
  /** 只在画布开关打开时出现。 */
  requiresCanvas?: boolean;
}

export interface WorkspaceNavGroup {
  title: string;
  items: WorkspaceNavItem[];
}

/**
 * 复用 `components/ui/Icon.tsx` 已有的图标名。单独声明成联合类型而不是 import，
 * 是为了让本文件保持零依赖、可在 Node 测试里直接 import（`Icon.tsx` 依赖 React）。
 * `scripts/workspace-navigation.test.ts` 会与 Icon 的真实名字核对。
 */
export type WorkspaceNavIcon =
  | 'grid' | 'folder' | 'sparkle' | 'logs' | 'download' | 'alert' | 'table'
  | 'cpu' | 'settings' | 'image' | 'users' | 'monitor';

/** 头像菜单项（侧栏底部）。 */
export interface WorkspaceMenuLink {
  href: string;
  label: string;
  icon: WorkspaceNavIcon | 'key' | 'trash';
}

/**
 * 员工端三组、管理员端五组。画布项由调用方通过 `canvasEnabled` 过滤，
 * 这里保留完整表，避免两处维护两套清单。
 */
const EMPLOYEE_GROUPS: WorkspaceNavGroup[] = [
  {
    title: '创作',
    items: [
      { href: '/', label: '工作台', icon: 'grid' },
      { href: '/projects', label: '我的项目', icon: 'folder' },
      { href: '/canvas', label: '创作画布', icon: 'sparkle', requiresCanvas: true },
    ],
  },
  {
    title: '进度',
    items: [
      { href: '/team/tasks', label: '我的任务', icon: 'logs', badge: 'tasks' },
      { href: '/team/downloads', label: '下载与交付', icon: 'download' },
      { href: '/team/errors', label: '出错的任务', icon: 'alert', badge: 'errors' },
    ],
  },
  {
    title: '账目',
    items: [
      { href: '/usage', label: '我的用量', icon: 'table' },
    ],
  },
];

const ADMIN_GROUPS: WorkspaceNavGroup[] = [
  {
    title: '总览',
    items: [
      { href: '/', label: '运行总览', icon: 'grid' },
    ],
  },
  {
    title: '生产',
    items: [
      { href: '/projects', label: '项目空间', icon: 'folder' },
      { href: '/canvas', label: '创作画布', icon: 'sparkle', requiresCanvas: true },
      { href: '/team/tasks', label: '全员任务', icon: 'logs', badge: 'tasks' },
      { href: '/team/downloads', label: '下载与交付', icon: 'download' },
      { href: '/team/errors', label: '出错的任务', icon: 'alert', badge: 'errors' },
    ],
  },
  {
    title: '资源',
    items: [
      { href: '/team/admin/pools', label: '模型与名额', icon: 'cpu' },
      { href: '/settings', label: '供应商配置', icon: 'settings' },
      { href: '/team/admin/resources', label: '公共资源', icon: 'image' },
    ],
  },
  {
    title: '团队',
    items: [
      { href: '/team/admin/users', label: '成员与账号', icon: 'users' },
      { href: '/usage', label: '团队用量', icon: 'table' },
    ],
  },
  {
    title: '系统',
    items: [
      { href: '/team/admin/operations', label: '版本与备份', icon: 'monitor' },
    ],
  },
];

/** 头像菜单里的两个跳转项；外观与退出登录是交互项，不在这里。 */
export const WORKSPACE_MENU_LINKS: WorkspaceMenuLink[] = [
  { href: '/team/account', label: '修改密码', icon: 'key' },
  { href: '/team/recycle-bin', label: '回收站', icon: 'trash' },
];

/** 不在侧栏导航里、但仍是团队版页面的标题（沿用同一套文案）。 */
const EXTRA_PAGE_TITLES: Array<[RegExp, string]> = [
  [/^\/projects\/new$/, '新建项目'],
  [/^\/projects\/[^/]+$/, '项目工作台'],
  [/^\/canvas\/[^/]+$/, '创作画布'],
  [/^\/team\/recycle-bin$/, '回收站'],
  [/^\/team\/account$/, '修改密码'],
  [/^\/team\/errors\/[^/]+\/task$/, '关联制作任务'],
];

function groupsFor(role: WorkspaceRole): WorkspaceNavGroup[] {
  return role === 'admin' ? ADMIN_GROUPS : EMPLOYEE_GROUPS;
}

/**
 * 构建侧栏分组导航。画布开关关闭时整项消失（不是禁用），两种角色都一样。
 * 返回全新对象，调用方可以安全地加派生字段。
 */
export function buildWorkspaceNavigation(options: { role: WorkspaceRole; canvasEnabled: boolean }): WorkspaceNavGroup[] {
  return groupsFor(options.role).map((group) => ({
    title: group.title,
    items: group.items
      .filter((item) => !item.requiresCanvas || options.canvasEnabled)
      .map((item) => ({ ...item })),
  }));
}

/** 同 `buildWorkspaceNavigation`，命名强调「按角色取清单」的读法。 */
export const workspaceNavigationFor = buildWorkspaceNavigation;

/** 端名：员工端「林视创作台」、管理员端「林视控制台」；无身份时用完整端名。 */
export function workspaceProductName(role: WorkspaceRole | null | undefined): string {
  if (role === 'admin') return '林视控制台';
  if (role === 'employee') return '林视创作台';
  return "林视 Lin's Vision";
}

function matches(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 每页工具栏标题：标题沿用导航名，所以先查导航表，再查导航外的团队版页面。
 * 未匹配时返回 null，由调用方决定不渲染工具栏标题。
 */
export function workspacePageTitle(pathname: string, role: WorkspaceRole | null | undefined): string | null {
  if (role) {
    // 画布开关不影响标题解析：页面本身另有开关闸门。
    const items = groupsFor(role).flatMap((group) => group.items);
    const exact = items.find((item) => item.href === pathname);
    if (exact) return exact.label;
  }
  // 导航外的团队版页面先于前缀匹配（否则 /projects/new 会被「我的项目」抢走）。
  for (const [pattern, title] of EXTRA_PAGE_TITLES) if (pattern.test(pathname)) return title;
  if (role) {
    // 子路径沿用父级导航名，最长前缀优先。
    const byPrefix = groupsFor(role).flatMap((group) => group.items)
      .filter((item) => item.href !== '/' && matches(pathname, item.href))
      .sort((left, right) => right.href.length - left.href.length)[0];
    if (byPrefix) return byPrefix.label;
  }
  return null;
}

/** 当前导航项高亮：首页只在自己的路径高亮，其余按子路径前缀匹配。 */
export function isWorkspaceNavActive(pathname: string, href: string): boolean {
  return matches(pathname, href);
}

/** 页面列表接口的响应形状（只取角标需要的 items 长度）。 */
export interface WorkspaceListPayload { items?: unknown }

/**
 * 从 `/api/team/tasks`、`/api/team/errors` 的响应里取角标数。
 * 口径刻意与页面一致：同一个接口、同一份可见范围——不在这里另算。
 * 接口不可用或形状不对时返回 null（前端不显示角标，不显示 0）。
 */
export function workspaceBadgeCounts(payloads: { tasks?: WorkspaceListPayload | null; errors?: WorkspaceListPayload | null }): {
  tasks: number | null; errors: number | null;
} {
  const count = (payload: WorkspaceListPayload | null | undefined): number | null => {
    if (!payload || typeof payload !== 'object') return null;
    const items = (payload as { items?: unknown }).items;
    return Array.isArray(items) ? items.length : null;
  };
  return { tasks: count(payloads.tasks), errors: count(payloads.errors) };
}

/** 角标文案：0 与未知都不显示。 */
export function formatBadgeCount(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return String(Math.trunc(count));
}
