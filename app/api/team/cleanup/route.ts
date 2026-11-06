import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { requestPermanentCleanup, runPermanentCleanup } from '@/lib/team-service/lifecycle/index';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { resolveStoragePath } from '@/lib/media-core/storage-path';
import { dataRoot } from '@/lib/data-root';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as { resourceType?: unknown; resourceId?: unknown; run?: unknown };
    if (typeof body.resourceType !== 'string' || typeof body.resourceId !== 'string'
      || !body.resourceType.trim() || !body.resourceId.trim()) {
      return Response.json({ error: 'invalid_input', message: '缺少资源身份。' }, { status: 400 });
    }
    const db = getDb();
    const actor = requireAccessContext().actor;
    const requested = requestPermanentCleanup(db, actor, {
      resourceType: body.resourceType, resourceId: body.resourceId,
    });
    const job = body.run === false ? requested : runPermanentCleanup(db, {
      jobId: requested.id,
      storageRoot: resolveStoragePath(dataRoot(), 'storage'),
    });
    return Response.json({ job }, {
      status: job.status === 'deferred' ? 202 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: 'cleanup_failed', message: '永久清理失败，请稍后重试。' }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/team/cleanup', 'POST', __teamRoutePOST);
