import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export const dynamic = 'force-dynamic';

/**
 * 团队版页面布局（05 号票：访问闸门）。
 *
 * 团队版外壳（左侧分组侧栏 + 每页标题 + 去 980px 居中栏）由 `app/layout.tsx` 统一挂载，
 * 因为 `app/team/**` 是另一条路由树，只有根布局能一次覆盖全部团队页面。
 * 这里只保留原有的访问校验和「让页面撑满内容区」的容器约束。
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const principal = await requireTeamPageAccess();
  if (!principal) return children;
  return <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">{children}</div>;
}
