import { gracefulShutdown } from '../../../../../lib/shutdown.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { handleTeamOperation } from '../../../../../lib/team-service/operations.ts';
import { getTeamRuntimeState } from '../../../../../lib/team-service/runtime/state.ts';

async function __teamRoutePOST(request: Request): Promise<Response> {
  return handleTeamOperation(request, 'shutdown', {
    getState: getTeamRuntimeState,
    shutdown: () => gracefulShutdown({ timeoutMs: 120_000 }),
    scheduleExit: () => setTimeout(() => process.exit(0), 100),
  });
}
export const POST = withTeamRoute('/api/team/operations/shutdown', 'POST', __teamRoutePOST);
