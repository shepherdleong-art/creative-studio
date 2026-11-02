import { getDb } from '@/lib/db';
import { getPermanentCleanupJob, runPermanentCleanup } from '@/lib/team-service/lifecycle/index';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { resolveStoragePath } from '@/lib/media-core/storage-path';
import { dataRoot } from '@/lib/data-root';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

function errorResponse(error: unknown) {
  if (error instanceof ResourceAccessError) {
    return Response.json({ error: error.code, message: error.message }, { status: error.status });
  }
  return Response.json({ error: 'cleanup_failed', message: '清理任务执行失败。' }, { status: 500 });
}

async function __teamRouteGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    return Response.json({ job: getPermanentCleanupJob(getDb(), (await params).id) }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) { return errorResponse(error); }
}

async function __teamRoutePOST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const job = runPermanentCleanup(getDb(), {
      jobId: (await params).id,
      storageRoot: resolveStoragePath(dataRoot(), 'storage'),
    });
    return Response.json({ job }, {
      status: job.status === 'deferred' ? 202 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) { return errorResponse(error); }
}

export const GET = withTeamRoute('/api/team/cleanup/[id]', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/cleanup/[id]', 'POST', __teamRoutePOST);
