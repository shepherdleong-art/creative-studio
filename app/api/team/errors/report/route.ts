import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { reportClientError, TEAM_ERROR_STAGES, type TeamErrorStage } from '@/lib/team-service/diagnostics';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    const access = requireAccessContext();
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.stage !== 'string' || !(TEAM_ERROR_STAGES as readonly string[]).includes(body.stage)
      || typeof body.code !== 'string' || !body.code.trim()) {
      return Response.json({ error: 'invalid_error_report', message: '错误阶段和错误码必填。' }, {
        status: 400,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const result = reportClientError(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, {
      clientEventId: typeof body.clientEventId === 'string' ? body.clientEventId : undefined,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      stage: body.stage as TeamErrorStage,
      code: body.code,
      statusCode: typeof body.statusCode === 'number' ? body.statusCode : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
      actorUserId: typeof body.actorUserId === 'string' ? body.actorUserId : undefined,
      operationId: typeof body.operationId === 'string' ? body.operationId : undefined,
      attemptId: typeof body.attemptId === 'string' ? body.attemptId : undefined,
    }, {
      clientVersion: request.headers.get('x-creative-studio-client-version') || undefined,
      serverReleaseId: process.env.CREATIVE_STUDIO_SERVER_RELEASE_ID?.trim() || 'unknown',
    });
    return Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return teamServiceError(error, '客户端错误上报失败。');
  }
}

export const POST = withTeamRoute('/api/team/errors/report', 'POST', __teamRoutePOST);
