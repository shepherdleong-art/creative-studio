import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import WorkspacePageHeader from '@/components/team/WorkspacePageHeader';

export const dynamic = 'force-dynamic';

/**
 * 团队版页面外壳（05 号票）。
 *
 * 团队版里 `app/layout.tsx` 的 <main> 已经去掉 980px 居中栏，这里再给每个团队版页面
 * 接上「每页工具栏」的标题：标题按当前路径从 `lib/workspace-navigation.ts` 解析，
 * 与侧栏导航名同源。各页自己的操作按钮由各页任务补（见 `components/team/PageToolbar.tsx`）；
 * 页面接管工具栏后，这里这条自动让位。
 *
 * 本地版（`requireTeamPageAccess()` 返回 null）不加任何东西，保持原样。
 */
export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const principal = await requireTeamPageAccess();
  if (!principal) return children;
  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col" data-testid="workspace-shell">
      <WorkspacePageHeader role={principal.role} />
      {children}
    </div>
  );
}
