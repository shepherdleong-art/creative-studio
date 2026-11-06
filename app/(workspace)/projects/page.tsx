import ProjectsHome from '@/components/ProjectsHome';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export default async function ProjectsPage() {
  const principal = await requireTeamPageAccess();
  return <ProjectsHome team={Boolean(principal)} canManageProviders={!principal || principal.role === 'admin'} />;
}
