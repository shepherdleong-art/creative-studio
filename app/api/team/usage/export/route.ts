import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { teamServiceError } from '@/lib/team-service/http-error';
import { exportTeamUsageCsv } from '@/lib/team-service/usage';
import { readTeamUsageScope } from '@/lib/team-service/usage-request';

/**
 * 团队用量 CSV：保留原导出字段与调用账本口径，覆盖**完整筛选范围**。
 *
 * - `page`/`pageSize`/`section` 不参与导出，分页参数不截断导出内容；
 * - 权限与页面一致：员工 403（只有管理员可以导出团队 CSV）；
 * - scope 与页面同一套裁决：`scope=self` 只导出本人，`scope=team` 导出授权团队范围，
 *   管理员不传 scope 时保持既有「团队口径」（成员管理页的「导出本月 CSV」依赖它），
 *   `actorUserId` 仍是管理员按成员下钻。
 */
async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const { filters } = readTeamUsageScope(request, viewer, { defaultSelf: false });
    const csv = exportTeamUsageCsv(getDb(), viewer, filters);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="team-usage.csv"',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return teamServiceError(error, '团队用量导出失败。');
  }
}

export const GET = withTeamRoute('/api/team/usage/export', 'GET', __teamRouteGET);
