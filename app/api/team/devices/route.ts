import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamDevices, registerTeamDevice } from '@/lib/team-service/transfers/devices';
import { readTransferJson, teamTransferErrorResponse } from '@/lib/team-service/transfers/http';

export const runtime = 'nodejs';

async function __teamRouteGET() {
  if (readRuntimeConfig().mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ items: listTeamDevices(getDb(), requireAccessContext().actor) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

async function __teamRoutePOST(request: Request) {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    const body = await readTransferJson(request);
    const device = registerTeamDevice(getDb(), requireAccessContext().actor, {
      deploymentId: config.deploymentId,
      clientDeviceId: body.clientDeviceId as string,
      displayName: body.displayName as string,
      platform: body.platform as string,
    });
    return Response.json(device, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamTransferErrorResponse(error, 'device_register_failed');
  }
}

export const GET = withTeamRoute('/api/team/devices', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/devices', 'POST', __teamRoutePOST);
