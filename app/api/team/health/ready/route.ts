import { getTeamRuntimeState } from '../../../../../lib/team-service/runtime/state.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


function __teamRouteGET(): Response {
  const state = getTeamRuntimeState();
  return Response.json(
    {
      ready: state.ready,
      maintenance: state.maintenance,
      phase: state.phase,
    },
    {
      status: state.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
export const GET = withTeamRoute('/api/team/health/ready', 'GET', __teamRouteGET);
