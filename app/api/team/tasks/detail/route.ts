import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { findConsoleTask } from '@/lib/team-service/console-overview';
import { teamServiceError } from '@/lib/team-service/http-error';
import { taskIdFromQuery } from '@/lib/team-console-overview';

/**
 * 任务详情（12 号票）：`/team/tasks?taskId=<operationId>` 背后的数据。
 *
 * 可见范围与列表**同一函数**（`listTeamTasks` → `findConsoleTask`）：员工传别人的任务号
 * 只会得到 404，不用另写一套权限判断。
 */
async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const operationId = taskIdFromQuery(new URL(request.url).searchParams.get('taskId'));
    if (!operationId) {
      return Response.json({ error: 'task_id_invalid', message: '任务编号无效。' }, {
        status: 400, headers: { 'Cache-Control': 'no-store' },
      });
    }
    const task = findConsoleTask(getDb(), { userId: access.actor.userId, role: access.actor.role }, operationId);
    if (!task) {
      return Response.json({ error: 'task_not_found', message: '没有找到这条任务，可能已被清理或不属于你。' }, {
        status: 404, headers: { 'Cache-Control': 'no-store' },
      });
    }
    return Response.json({ item: task }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return teamServiceError(error, '任务详情读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/tasks/detail', 'GET', __teamRouteGET);
