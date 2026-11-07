import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { readEmployeeDashboard } from '@/lib/team-service/dashboard';
import { teamServiceError } from '@/lib/team-service/http-error';

/**
 * 员工首页（06 号票）。
 *
 * 一个只读聚合，供首页一次拿全「出错的任务 / 接着做 / 正在生产 / 本月用量」。
 * 每块的口径都在 `lib/team-service/dashboard.ts` 里复用页面自己的列表函数，
 * 所以首页数字和「我的任务」「出错的任务」「我的用量」页不会漂移。
 *
 * 关键红线：非渲染阶段不返回百分比。原型里每项都画了百分比只是示意；
 * 这里 `running.items[*].percent` 只有真实渲染任务才非 null。
 */
async function __teamRouteGET(): Promise<Response> {
  try {
    const access = requireAccessContext();
    return Response.json(readEmployeeDashboard(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '工作台状态读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/dashboard', 'GET', __teamRouteGET);
