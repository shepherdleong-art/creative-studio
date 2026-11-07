import CanvasListPage from '@/components/creative-canvas/CanvasListPage';
import { requireTeamPageAccess } from '@/lib/team-service/page-guard';

export const dynamic = 'force-dynamic';

/**
 * 创作画布列表。团队版由每页工具栏显示标题，本地版（个人工作台）保留原来的
 * 页内大标题——两边的卡片/表格视图与偏好键完全一致。
 */
export default async function CanvasListRoute() {
  const principal = await requireTeamPageAccess();
  return <CanvasListPage role={principal?.role} />;
}
