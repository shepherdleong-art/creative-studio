import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readTeamMemberPolicy, updateTeamMemberPolicy } from '@/lib/team-service/usage';
import { teamServiceError } from '@/lib/team-service/http-error';
import { TeamUsageError } from '@/lib/team-service/usage';

function viewer() {
  const access = requireAccessContext();
  return { userId: access.actor.userId, role: access.actor.role };
}

async function __teamRouteGET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json(readTeamMemberPolicy(getDb(), viewer(), id), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '成员策略读取失败。');
  }
}

async function __teamRoutePATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    const monthlyLimitMinor = body.unlimited === true ? null : body.monthlyLimitMinor;
    if (body.allowedModels !== undefined && body.allowedModels !== null
      && (!Array.isArray(body.allowedModels) || body.allowedModels.length > 500
        || body.allowedModels.some(model => typeof model !== 'string' || !model.trim() || model.length > 200))) {
      throw new TeamUsageError(400, 'invalid_policy', '模型权限列表无效。');
    }
    if ((monthlyLimitMinor !== null && (!Number.isSafeInteger(monthlyLimitMinor) || Number(monthlyLimitMinor) < 0))
      || !Number.isSafeInteger(body.personalConcurrency) || Number(body.personalConcurrency) < 0
      || typeof body.paused !== 'boolean' || !Number.isSafeInteger(body.expectedVersion)) {
      throw new TeamUsageError(400, 'invalid_policy', '额度、并发、暂停状态或策略版本无效。');
    }
    return Response.json(updateTeamMemberPolicy(getDb(), viewer(), {
      targetUserId: id,
      monthlyLimitMinor: monthlyLimitMinor as number | null,
      personalConcurrency: Number(body.personalConcurrency),
      paused: body.paused,
      expectedVersion: Number(body.expectedVersion),
      allowedModels: body.allowedModels as string[] | null | undefined,
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '成员策略保存失败。');
  }
}

export const GET = withTeamRoute('/api/team/members/[id]/policy', 'GET', __teamRouteGET);
export const PATCH = withTeamRoute('/api/team/members/[id]/policy', 'PATCH', __teamRoutePATCH);
