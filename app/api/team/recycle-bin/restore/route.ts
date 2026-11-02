import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { restoreResource } from '@/lib/team-service/lifecycle/index';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as { resourceType?: unknown; resourceId?: unknown };
    if (typeof body.resourceType !== 'string' || typeof body.resourceId !== 'string'
      || !body.resourceType.trim() || !body.resourceId.trim()) {
      return Response.json({ error: 'invalid_input', message: '缺少资源身份。' }, { status: 400 });
    }
    const restored = restoreResource(getDb(), requireAccessContext().actor, {
      resourceType: body.resourceType, resourceId: body.resourceId,
    });
    return Response.json({ success: true, ...restored }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: 'restore_failed', message: '恢复失败，请稍后重试。' }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/team/recycle-bin/restore', 'POST', __teamRoutePOST);
