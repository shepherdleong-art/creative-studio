import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { queryTeamUsage, readTeamMemberPolicy, readTeamMemberSummary } from '@/lib/team-service/usage';
import { readTeamUsageFilters } from '@/lib/team-service/usage-request';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const filters = readTeamUsageFilters(request);
    const teamScope = new URL(request.url).searchParams.get('scope') === 'team' && viewer.role === 'admin';
    if (!teamScope && !filters.actorUserId) filters.actorUserId = viewer.userId;
    const result = queryTeamUsage(getDb(), viewer, filters);
    return Response.json({
      ...result,
      range: { from: filters.from, to: filters.to },
      scope: teamScope ? 'team' : 'self',
      canViewTeam: viewer.role === 'admin',
      policy: readTeamMemberPolicy(getDb(), viewer, viewer.userId),
      member: readTeamMemberSummary(getDb(), viewer, viewer.userId),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队用量读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/usage', 'GET', __teamRouteGET);
