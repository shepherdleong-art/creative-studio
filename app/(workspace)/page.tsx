import ProjectsHome from '@/components/ProjectsHome';
import TeamDashboard from '@/components/team/TeamDashboard';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import { canvasFeatureEnabled } from '@/lib/creative-canvas/config';

export default async function HomePage() {
  const principal = await requireTeamPageAccess();
  if (!principal) return <ProjectsHome />;
  return <TeamDashboard
    admin={principal.role === 'admin'}
    displayName={principal.displayName}
    canvasEnabled={canvasFeatureEnabled()}
    role={principal.role}
  />;
}
