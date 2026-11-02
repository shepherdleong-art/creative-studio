import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { getTeamErrorDiagnostic } from '@/lib/team-service/diagnostics';
import { teamServiceError } from '@/lib/team-service/http-error';

async function __teamRouteGET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const access = requireAccessContext();
    const { id } = await context.params;
    const diagnostic = getTeamErrorDiagnostic(getDb(), {
      userId: access.actor.userId,
      role: access.actor.role,
    }, id);
    return Response.json(diagnostic, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="diagnostic-${id}.json"`,
      },
    });
  } catch (error) {
    return teamServiceError(error, '诊断包生成失败。');
  }
}

export const GET = withTeamRoute('/api/team/errors/[id]/diagnostics', 'GET', __teamRouteGET);
