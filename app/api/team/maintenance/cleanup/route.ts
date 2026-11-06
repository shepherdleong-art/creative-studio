import { requirePrincipal } from '@/lib/team-service/auth/request';
import { getCleanupPreviewForAdministrator, scanCleanupForAdministrator } from '@/lib/team-service/maintenance/control';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { MaintenanceControlError } from '@/lib/team-service/maintenance/jobs';

export const dynamic = 'force-dynamic';

async function __teamRoutePOST(request: Request) {
  const principal = requirePrincipal(request, { admin: true });
  try { await request.json(); } catch { /* 扫描不接受也不依赖请求路径或任意对象。 */ }
  try { return Response.json(await scanCleanupForAdministrator(principal), { status: 201, headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) {
    if (error instanceof MaintenanceControlError && error.code === 'maintenance_conflict') return Response.json({ error: error.code, message: error.message }, { status: 409 });
    return Response.json({ error: 'cleanup_scan_failed', message: '无法安全扫描受管候选，未删除任何文件。' }, { status: 503 });
  }
}
async function __teamRouteGET(request: Request) {
  const principal = requirePrincipal(request, { admin: true });
  const previewId = new URL(request.url).searchParams.get('previewId');
  if (!previewId) return Response.json({ error: 'invalid_target', message: '需要受管预览标识。' }, { status: 400 });
  try { return Response.json(getCleanupPreviewForAdministrator(principal, previewId), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch { return Response.json({ error: 'preview_not_found', message: '清理预览不存在。' }, { status: 404 }); }
}

export const POST = withTeamRoute('/api/team/maintenance/cleanup', 'POST', __teamRoutePOST);
export const GET = withTeamRoute('/api/team/maintenance/cleanup', 'GET', __teamRouteGET);
