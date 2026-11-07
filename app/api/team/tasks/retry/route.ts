import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { findConsoleTask } from '@/lib/team-service/console-overview';
import { teamServiceError } from '@/lib/team-service/http-error';
import { taskIdFromQuery, taskRetryTarget } from '@/lib/team-console-overview';
import { taskWaitLabel } from '@/lib/team-task-labels';
import { readJson } from '@/lib/team-service/auth/http';
import { TeamAuthError } from '@/lib/team-service/auth/types';
import * as imageRetryRoute from '@/app/api/jobs/[id]/retry/route';
import * as videoRetryRoute from '@/app/api/video-jobs/[id]/retry/route';

/**
 * 「重试这一步」（12 号票）。
 *
 * 这里**不重写重试语义**：真正把任务放回队列的是既有两条已验证路径
 * `/api/jobs/[id]/retry`（图片）和 `/api/video-jobs/[id]/retry`（视频）。本路由只做三件
 * 新票该管的事，然后把请求按原样转发过去：
 *
 * 1. 用 `findConsoleTask` 确认这条任务在**当前登录人的可见范围内**（员工只能重试自己的）；
 * 2. 只放行「明确失败」的任务——提交结果待核查（unknown/maybe_sent）重试会重复扣费，
 *    一律拒绝并说明先核对结果；
 * 3. 转发时保留原请求的 Cookie / CSRF / Origin 头，让被转发的路由照常做资源级授权
 *    （图片任务写 `job`、视频任务写 `video_job`），所以这里不会比原入口更宽松。
 *
 * 其它模块（脚本、配音、混剪等）没有通用的「按任务号重试」入口，本路由如实拒绝，
 * 由界面把用户导到项目里的重试按钮。
 */
type RetryHandler = (input: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const viewer = { userId: access.actor.userId, role: access.actor.role };
    const body = await readJson(request).catch(() => ({} as Record<string, unknown>));
    const operationId = taskIdFromQuery(typeof body.operationId === 'string' ? body.operationId : null);
    if (!operationId) throw new TeamAuthError('task_id_invalid', '任务编号无效。');

    const task = findConsoleTask(getDb(), viewer, operationId);
    // 与详情接口同一口径：不暴露「这条任务存在但不属于你」。
    if (!task) throw new TeamAuthError('task_not_found', '没有找到这条任务，可能已被清理或不属于你。', 404);
    if (task.status !== 'failed') {
      throw new TeamAuthError('task_not_retryable',
        task.status === 'unknown' || task.status === 'maybe_sent'
          ? '这一步的结果还没确认。先核对结果再决定是否重试，避免重复扣费。'
          : `${taskWaitLabel(task.waitReason, null) || '当前状态'}，这一步现在不能重试。`);
    }
    const target = taskRetryTarget({ module: String(task.module), taskId: String(task.taskId), status: String(task.status) });
    if (!target) {
      throw new TeamAuthError('task_retry_unsupported',
        '这一步要到项目里重试：打开项目，在对应步骤上点重试。');
    }

    const origin = new URL(request.url).origin;
    const forwardRequest = new Request(`${origin}${target.endpoint}`, {
      method: 'POST',
      headers: request.headers,
    });
    const response = target.endpoint.startsWith('/api/jobs/')
      ? await (imageRetryRoute.POST as RetryHandler)(forwardRequest, { params: Promise.resolve({ id: String(task.taskId) }) })
      : await (videoRetryRoute.POST as RetryHandler)(forwardRequest, { params: Promise.resolve({ id: String(task.taskId) }) });
    if (!response.ok) {
      const text = await response.clone().text();
      let message = '重试没有成功，请稍后再试。';
      try {
        const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim()) message = parsed.message;
        else if (typeof parsed.error === 'string' && parsed.error.trim()) message = `重试没有成功：${parsed.error}`;
      } catch { /* 非 JSON 响应保留默认说明 */ }
      return Response.json({ error: 'task_retry_failed', message }, {
        status: response.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    const body2 = await response.json().catch(() => ({})) as Record<string, unknown>;
    return Response.json({
      ok: true,
      operationId,
      queued: true,
      resumeRequired: body2.resumeRequired === true,
      message: body2.resumeRequired === true
        ? '这一步已有远端任务，已转为「补抓结果」继续查询，不会重复提交。'
        : '已重新加入队列，稍后回到「排队中」。',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof TeamAuthError) {
      return Response.json({ error: error.code, message: error.message }, {
        status: error.status, headers: { 'Cache-Control': 'no-store' },
      });
    }
    return teamServiceError(error, '重试这一步失败。');
  }
}

export const POST = withTeamRoute('/api/team/tasks/retry', 'POST', __teamRoutePOST);
