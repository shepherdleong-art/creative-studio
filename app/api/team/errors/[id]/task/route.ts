import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { getTeamErrorTask } from '@/lib/team-service/diagnostics';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const access = requireAccessContext();
    const { id } = await context.params;
    return Response.json({ items: getTeamErrorTask(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, id) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '关联任务读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/errors/[id]/task', 'GET', __teamRouteGET);
