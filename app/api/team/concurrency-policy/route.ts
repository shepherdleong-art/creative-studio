import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readTeamConcurrencyPolicy, updateTeamConcurrencyPolicy } from '@/lib/media-core/execution/team-policy';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { teamServiceError } from '@/lib/team-service/http-error';
import { TeamUsageError } from '@/lib/team-service/usage';

function admin() {
  const access = requireAccessContext();
  if (access.actor.role !== 'admin') throw new TeamUsageError(403, 'policy_forbidden', '只有管理员可以配置团队并发策略。');
}

async function __teamRouteGET(): Promise<Response> {
  try {
    admin();
    return Response.json(readTeamConcurrencyPolicy(getDb()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队并发策略读取失败。');
  }
}

async function __teamRoutePATCH(request: Request): Promise<Response> {
  try {
    admin();
    const body = await request.json() as Record<string, unknown>;
    if (!Number.isSafeInteger(body.manualDefaultConcurrency) || Number(body.manualDefaultConcurrency) < 0
      || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0
      || (body.mode !== undefined && body.mode !== 'manual')) {
      throw new TeamUsageError(400, 'invalid_policy', '团队手动默认并发和策略版本必须是非负安全整数；本版本仅支持手动模式。');
    }
    return Response.json(updateTeamConcurrencyPolicy(getDb(), {
      manualDefaultConcurrency: Number(body.manualDefaultConcurrency),
      expectedVersion: Number(body.expectedVersion),
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队并发策略保存失败。');
  }
}

export const GET = withTeamRoute('/api/team/concurrency-policy', 'GET', __teamRouteGET);
export const PATCH = withTeamRoute('/api/team/concurrency-policy', 'PATCH', __teamRoutePATCH);
