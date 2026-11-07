import { cookies } from 'next/headers';
import { connection } from 'next/server';
import WorkspacePageHeader from '@/components/team/WorkspacePageHeader';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';

/**
 * 团队版每页标题（05 号票）的服务端入口。
 *
 * 团队版页面分散在两条路由树里——`app/(workspace)/**` 与 `app/team/**`——只把标题接在
 * `(workspace)/layout.tsx` 会漏掉 tasks/errors/downloads/admin 等页面。所以统一在根布局的
 * `<main>` 里挂：一次覆盖全部团队路由，页面自己接管工具栏时自动让位
 * （见 `components/team/WorkspacePageHeader.tsx`）。
 *
 * 未登录/必须改密/本地版一律不渲染，交给各页原有的重定向与本地版顶栏。
 */
export default async function WorkspacePageChrome() {
  await connection();
  if (readRuntimeConfig().mode !== 'server') return null;
  let role: 'employee' | 'admin' | null = null;
  try {
    const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
    const resolved = token ? getTeamAuthService().resolveSession(token) : null;
    if (resolved && !resolved.mustChangePassword) role = resolved.role;
  } catch {
    // 身份结构不可用时不出标题；业务入口由运行时 readiness 继续关闭。
  }
  if (!role) return null;
  return <WorkspacePageHeader role={role} />;
}
