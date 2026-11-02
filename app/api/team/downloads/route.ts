import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamDownloads } from '@/lib/team-service/transfers/devices';
import { teamTransferErrorResponse } from '@/lib/team-service/transfers/http';

export const runtime = 'nodejs';

async function __teamRouteGET(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const query = new URL(request.url).searchParams;
    const after = query.get('after');
    const limit = query.get('limit');
    const result = listTeamDownloads(getDb(), requireAccessContext().actor, {
      deviceId: query.get('deviceId') ?? '',
      after: after === null ? undefined : Number(after),
      limit: limit === null ? undefined : Number(limit),
    });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'download_list_failed');
  }
}

export const GET = withTeamRoute('/api/team/downloads', 'GET', __teamRouteGET);
