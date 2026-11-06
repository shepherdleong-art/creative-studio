import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamMembers } from '@/lib/team-service/usage';
import { teamServiceError } from '@/lib/team-service/http-error';
import { listTeamModelOptions } from '@/lib/team-service/model-permissions';

async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const params = new URL(request.url).searchParams;
    const members = listTeamMembers(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, {
      search: params.get('search')?.trim() || undefined,
      attentionOnly: params.get('attentionOnly') === '1' || params.get('attentionOnly') === 'true',
    });
    return Response.json({ ...members, modelOptions: listTeamModelOptions(getDb()) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '成员用量读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/members', 'GET', __teamRouteGET);
