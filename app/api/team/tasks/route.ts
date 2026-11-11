import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamTasks } from '@/lib/team-service/tasks';
import { parseTeamPage } from '@/lib/team-service/pagination';
import { teamServiceError } from '@/lib/team-service/http-error';

/**
 * 全员任务 / 我的任务列表（03 号票：服务端分页）。
 *
 * 分页与校验由 `lib/team-service/pagination.ts` 统一裁决：`page`（≥1，缺省 1）、
 * `pageSize`（25/50，缺省 25）；非法参数由 `parseTeamPage` 抛 400，响应形状与其它团队
 * 接口一致。查询顺序是「授权 → 筛选/搜索 → 分组选页 → 取该页完整组的执行记录」：
 * `items` 仍是执行记录，但一页 25 个制作任务可以返回多于 25 条记录；`pagination.total`
 * 数制作任务组，`totalRecords` 数这些匹配组内的执行记录。不再保留隐式 500 条上限。
 */
async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const params = new URL(request.url).searchParams;
    const page = parseTeamPage({ page: params.get('page'), pageSize: params.get('pageSize') });
    return Response.json(listTeamTasks(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, {
      actorUserId: params.get('actorUserId')?.trim() || undefined,
      status: params.get('status')?.trim() || undefined,
      q: params.get('q')?.trim() || undefined,
    }, page), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队任务读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/tasks', 'GET', __teamRouteGET);
