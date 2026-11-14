import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readWorkspaceBadgeCounts } from '@/lib/team-service/workspace-counts';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(): Promise<Response> {
  try {
    const access = requireAccessContext();
    return Response.json(readWorkspaceBadgeCounts(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '侧栏数量读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/workspace-counts', 'GET', __teamRouteGET);
