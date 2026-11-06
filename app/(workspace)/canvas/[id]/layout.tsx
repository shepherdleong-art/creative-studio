import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export const dynamic = 'force-dynamic';

export default async function CanvasLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireTeamPageAccess({ canvasId: id });
  return children;
}
