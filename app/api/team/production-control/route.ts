import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readProductionControl, setProductionPaused } from '@/lib/team-service/production-control';
import { authError, readJson } from '@/lib/team-service/auth/http';
import { TeamAuthError } from '@/lib/team-service/auth/types';

function viewer() { const { actor } = requireAccessContext(); return { userId: actor.userId, role: actor.role }; }
async function read() {
  try { return Response.json(readProductionControl(getDb(), viewer()), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return authError(error); }
}
async function update(request: Request) {
  try {
    const input = await readJson(request);
    if (typeof input.paused !== 'boolean' || typeof input.expectedVersion !== 'number') {
      throw new TeamAuthError('invalid_request', '暂停状态或版本无效。');
    }
    return Response.json(setProductionPaused(getDb(), viewer(), { paused: input.paused, expectedVersion: input.expectedVersion }), { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return authError(error); }
}
export const GET = withTeamRoute('/api/team/production-control', 'GET', read);
export const PATCH = withTeamRoute('/api/team/production-control', 'PATCH', update);
