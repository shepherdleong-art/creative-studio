import CanvasListPage from '@/components/creative-canvas/CanvasListPage';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';
import { canvasFeatureEnabled } from '@/lib/creative-canvas/config';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * 创作画布列表。团队版由每页工具栏显示标题，本地版（个人工作台）保留原来的
 * 页内大标题——两边的卡片/表格视图与偏好键完全一致。
 *
 * 画布开关关闭时页面本身不存在：导航里已收起，直接访问地址同样得到 404，
 * 而不是一个空壳列表（开关的权威判断仍在 `lib/creative-canvas/config.ts`）。
 */
export default async function CanvasListRoute() {
  if (!canvasFeatureEnabled()) notFound();
  const principal = await requireTeamPageAccess();
  return <CanvasListPage role={principal?.role} />;
}
