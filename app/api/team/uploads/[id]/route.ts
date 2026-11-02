import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { cancelTeamUpload, getTeamUpload } from '@/lib/team-service/transfers';
import { teamTransferErrorResponse, teamTransferStorageRoot } from '@/lib/team-service/transfers/http';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function __teamRouteGET(_request: Request, { params }: Context) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await params;
    return Response.json(getTeamUpload(getDb(), requireAccessContext().actor, {
      storageRoot: teamTransferStorageRoot(), uploadId: id,
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_read_failed');
  }
}

async function __teamRouteDELETE(_request: Request, { params }: Context) {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const { id } = await params;
    return Response.json(cancelTeamUpload(getDb(), requireAccessContext().actor, {
      storageRoot: teamTransferStorageRoot(), uploadId: id,
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'upload_cancel_failed');
  }
}

export const GET = withTeamRoute('/api/team/uploads/[id]', 'GET', __teamRouteGET);
export const DELETE = withTeamRoute('/api/team/uploads/[id]', 'DELETE', __teamRouteDELETE);
