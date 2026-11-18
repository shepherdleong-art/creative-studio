import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import { canvasFeatureEnabled } from '@/lib/creative-canvas/config';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** 画布开关关闭时画布编辑器路由不存在（与列表页同一道闸门）。 */
export default async function CanvasLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  if (!canvasFeatureEnabled()) notFound();
  const { id } = await params;
  await requireTeamPageAccess({ canvasId: id });
  return children;
}
