import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { findTeamTask } from '@/lib/team-service/tasks';
import { teamServiceError } from '@/lib/team-service/http-error';
import { taskIdFromQuery } from '@/lib/team-console-overview';

/**
 * 任务详情（03 号票：按 operationId 直查）。
 *
 * `findTeamTask` 与列表**同一份授权与投影**，但不受 `page/q/status` 限制：
 * `/team/tasks?taskId=<operationId>` 深链可以打开任意页、500 条之外、当前筛选之外的
 * 合法任务；员工查别人的任务仍然只得到 404（`findTeamTask` 返回 null），不泄露存在性；
 * 编号格式非法仍是 400。
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
    const task = findTeamTask(getDb(), { userId: access.actor.userId, role: access.actor.role }, operationId);
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
