import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { listRecycleBin } from '@/lib/team-service/lifecycle/index';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteGET() {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  const items = listRecycleBin(getDb(), requireAccessContext().actor).map((scope) => ({
    resourceType: scope.resourceType,
    resourceId: scope.resourceId,
    ownerUserId: scope.ownerUserId,
    deletedAt: scope.deletedAt,
    deletedBy: scope.deletedBy,
  }));
  return Response.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export const GET = withTeamRoute('/api/team/recycle-bin', 'GET', __teamRouteGET);
