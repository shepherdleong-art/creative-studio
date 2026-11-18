import ProjectsHome from '@/components/ProjectsHome';
import TeamDashboard from '@/components/team/TeamDashboard';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import { canvasFeatureEnabled } from '@/lib/creative-canvas/config';
import { cookies } from 'next/headers';
import { VIEW_AS_USER_COOKIE, resolveViewMode } from '@/lib/team-service/view-as-user';

export default async function HomePage() {
  const principal = await requireTeamPageAccess();
  if (!principal) return <ProjectsHome />;
  // 04 号票：管理员查看用户视角时，首页按员工工作台渲染。
  const viewMode = resolveViewMode(principal.role, (await cookies()).get(VIEW_AS_USER_COOKIE)?.value);
  return <TeamDashboard
    admin={viewMode === 'admin'}
    displayName={principal.displayName}
    canvasEnabled={canvasFeatureEnabled()}
    role={viewMode === 'user' ? 'employee' : principal.role}
    viewingAsUser={viewMode === 'user'}
  />;
}
