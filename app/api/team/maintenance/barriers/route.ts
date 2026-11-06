import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { acquireLifecycleBarrier } from '@/lib/team-service/lifecycle/index';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await request.json() as { kind?: unknown; metadata?: unknown };
    if (!['backup', 'release', 'config'].includes(String(body.kind))) {
      return Response.json({ error: 'invalid_input', message: '维护屏障类型无效。' }, { status: 400 });
    }
    const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown> : {};
    const barrier = acquireLifecycleBarrier(
      getDb(), requireAccessContext().actor, body.kind as 'backup' | 'release' | 'config', metadata,
    );
    return Response.json({ barrier }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return Response.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return Response.json({ error: 'barrier_failed', message: '无法建立维护屏障。' }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/team/maintenance/barriers', 'POST', __teamRoutePOST);
