import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import { getDb } from '@/lib/db';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTeamPageAccess({ projectId: id });
  if (getDb().prepare('SELECT workflowType FROM projects WHERE id = ?').pluck().get(id) === 'one_click_film') {
    redirect(`/one-click-film/${encodeURIComponent(id)}`);
  }
  return children;
}
