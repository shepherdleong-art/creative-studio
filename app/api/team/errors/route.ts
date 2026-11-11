import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamErrors } from '@/lib/team-service/diagnostics';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const params = new URL(request.url).searchParams;
    const errorId = params.get('errorId')?.trim() || undefined;
    return Response.json(listTeamErrors(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, {
      errorId,
      actorUserId: params.get('actorUserId')?.trim() || undefined,
      actionableOnly: !errorId,
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队错误读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/errors', 'GET', __teamRouteGET);
