import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { teamServiceError } from '@/lib/team-service/http-error';
import {
  listTeamUsageAttempts,
  listTeamUsageTasks,
  queryTeamUsageSummary,
  readTeamMemberPolicy,
  readTeamMemberSummary,
} from '@/lib/team-service/usage';
import { readTeamUsageQuery } from '@/lib/team-service/usage-request';

/**
 * 团队用量：`section=summary`（默认）只返回完整范围的摘要；`tasks` / `channels` /
 * `legacy` / `unmapped` 返回各自分页的明细列表。摘要里的金额、排行、趋势、成员
 * 统计与 CSV 永远对完整筛选范围求值，不随页码或 section 变化。
 */
async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const { filters, section, page, teamScope, memberId } = readTeamUsageQuery(request, viewer);
    const db = getDb();
    const common = {
      range: { from: filters.from, to: filters.to },
      scope: teamScope ? 'team' as const : 'self' as const,
      canViewTeam: viewer.role === 'admin',
    };
    if (section === 'summary') {
      return Response.json({
        section,
        ...queryTeamUsageSummary(db, viewer, filters),
        ...common,
        policy: readTeamMemberPolicy(db, viewer, viewer.userId),
        member: readTeamMemberSummary(db, viewer, memberId),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (section === 'tasks') {
      const result = listTeamUsageTasks(db, viewer, filters, page);
      return Response.json({
        section, items: result.items, pagination: result.pagination, ...common,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const result = listTeamUsageAttempts(db, viewer, section, filters, page);
    return Response.json({
      section, items: result.items, pagination: result.pagination, ...common,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队用量读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/usage', 'GET', __teamRouteGET);
