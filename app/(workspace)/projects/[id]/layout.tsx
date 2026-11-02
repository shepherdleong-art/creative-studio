import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTeamPageAccess({ projectId: id });
  return children;
}
