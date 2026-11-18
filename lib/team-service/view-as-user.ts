import type { AuthPrincipal, TeamRole } from './auth/types.ts';
import type { WorkspaceRole } from '../workspace-navigation.ts';

/**
 * 管理员「一键查看用户视角」（04 号票）。
 *
 * 这是**纯展示层**的视角切换：会话、账号与权限一律不变，管理员仍是管理员，
 * 因此用户视角里创建/编辑的内容自然归本人账号，返回后管理功能照旧可用。
 * 真实员工没有切换入口；即使手工写这个 Cookie，也只对管理员生效——
 * 员工角色永远按员工界面渲染，也不会因此获得任何管理权限。
 *
 * Cookie 用独立名字而不是塞进会话 token：切换不改登录态，退出登录时一并清除即可。
 */

export const VIEW_AS_USER_COOKIE = 'creative_studio_view_as_user';
export const VIEW_AS_USER_ACTIVE = '1';

export type ViewMode = 'admin' | 'user';

/** 只有管理员可以进入用户视角；员工传什么 Cookie 都不生效。 */
export function resolveViewMode(role: TeamRole, cookieValue: string | null | undefined): ViewMode {
  return role === 'admin' && cookieValue === VIEW_AS_USER_ACTIVE ? 'user' : 'admin';
}

/** 界面按哪个角色渲染：管理员在用户视角里看到的就是员工导航与制作入口。 */
export function effectiveWorkspaceRole(role: TeamRole, viewMode: ViewMode): WorkspaceRole {
  return viewMode === 'user' ? 'employee' : role;
}

/** 视角切换的 Cookie 属性：路径 /、非 HttpOnly（纯展示偏好）、同站严格。 */
export function viewAsUserCookie(active: boolean): string {
  const base = `${VIEW_AS_USER_COOKIE}=${active ? VIEW_AS_USER_ACTIVE : ''}; Path=/; SameSite=Strict`;
  return active ? base : `${base}; Max-Age=0`;
}

export function principalViewMode(principal: AuthPrincipal, cookieValue: string | null | undefined): ViewMode {
  return resolveViewMode(principal.role, cookieValue);
}
