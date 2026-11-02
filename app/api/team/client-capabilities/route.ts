import { teamClientCapabilities } from '@/lib/team-service/client-capabilities';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';

async function __teamRouteGET(request: Request): Promise<Response> {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(teamClientCapabilities(config, request), {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export const GET = withTeamRoute('/api/team/client-capabilities', 'GET', __teamRouteGET);
