import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { handleTeamOperation } from '../../../../../lib/team-service/operations.ts';
import { getTeamRuntimeState } from '../../../../../lib/team-service/runtime/state.ts';

async function __teamRouteGET(request: Request): Promise<Response> {
  return handleTeamOperation(request, 'status', { getState: getTeamRuntimeState });
}
export const GET = withTeamRoute('/api/team/operations/status', 'GET', __teamRouteGET);
