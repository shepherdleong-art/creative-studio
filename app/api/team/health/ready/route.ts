import { getTeamRuntimeState } from '../../../../../lib/team-service/runtime/state.ts';

export function GET(): Response {
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
