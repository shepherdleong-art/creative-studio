import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { listTeamTasks, listTeamTaskActorOptions } from '@/lib/team-service/tasks';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const params = new URL(request.url).searchParams;
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const actorUserId = params.get('actorUserId')?.trim() || undefined;
    // 成员选项来自成员表而非任务结果：低频成员不会被最近记录上限挤出下拉框。
    // 选项始终返回完整名册，选中某个成员后下拉框仍然可以切回去。
    const actors = listTeamTaskActorOptions(getDb(), viewer);
    return Response.json({
      ...listTeamTasks(getDb(), viewer, {
        actorUserId,
        status: params.get('status')?.trim() || undefined,
      }),
      actors,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '团队任务读取失败。');
  }
}

export const GET = withTeamRoute('/api/team/tasks', 'GET', __teamRouteGET);
