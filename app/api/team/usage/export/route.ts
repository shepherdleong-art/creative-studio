import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { exportTeamUsageCsv } from '@/lib/team-service/usage';
import { readTeamUsageFilters } from '@/lib/team-service/usage-request';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const filters = readTeamUsageFilters(request);
    const csv = exportTeamUsageCsv(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, filters);
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
