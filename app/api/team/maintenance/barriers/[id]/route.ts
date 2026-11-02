import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { releaseLifecycleBarrier } from '@/lib/team-service/lifecycle/index';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteDELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  const released = releaseLifecycleBarrier(getDb(), requireAccessContext().actor, (await params).id);
  return Response.json({ success: true, released }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export const DELETE = withTeamRoute('/api/team/maintenance/barriers/[id]', 'DELETE', __teamRouteDELETE);
