// 林视品牌文案与页面标题的唯一来源。
//
// 显示名可以改，内部标识不能改：包名、数据根、CREATIVE_STUDIO_* 环境变量、
// 浏览器存储键、会话 Cookie 名、桌面可执行名、IPC 通道名、路由与项目命名规则
// 都不在这里，也不得因为改名而跟着变（守护测试：scripts/brand-identity-guard.test.ts）。

/** 正式写法：文字里一律用这个，不再用 `Lin's VISION`。 */
export const BRAND_NAME = "林视 Lin's Vision";

/** 副题。 */
export const BRAND_SUBTITLE = 'AI 产品图与短视频创作工作台';

/** 主张：只放在登录页。 */
export const BRAND_CLAIM = '出片交给 AI，眼光留给你。';

/** 登录页底部归属文字（用户已确认）。 */
export const BRAND_ATTRIBUTION = "© 林视 Lin's Vision";

/** 员工端页面标题 / 侧栏品牌。 */
export const EMPLOYEE_WORKSPACE_TITLE = '林视创作台';

/** 管理员端页面标题 / 侧栏品牌。 */
export const ADMIN_CONSOLE_TITLE = '林视控制台';

export type BrandRole = 'employee' | 'admin';

/**
 * 页面标题（浏览器标签、桌面窗口标题）：
 * 员工端「林视创作台」、管理员端「林视控制台」、个人本地版与登录页用正式写法。
 * 未登录时没有身份，不能猜端点，一律退回正式写法。
 */
export function applicationTitle(
  principal: { role: BrandRole } | null,
  mode: 'local' | 'server',
): string {
  if (mode === 'local' || !principal) return BRAND_NAME;
  return principal.role === 'admin' ? ADMIN_CONSOLE_TITLE : EMPLOYEE_WORKSPACE_TITLE;
}

/** Windows 任务栏 / 启动提示里用的短名。 */
export const BRAND_SHORT_NAME = '林视';
