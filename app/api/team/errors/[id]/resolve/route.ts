import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { resolveTeamError } from '@/lib/team-service/diagnostics';
import { teamServiceError } from '@/lib/team-service/http-error';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function handlePost(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const access = requireAccessContext();
    const { id } = await context.params;
    return Response.json(resolveTeamError(getDb(), access.actor, id), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return teamServiceError(error, '标记已处理失败。');
  }
}

export const POST = withTeamRoute('/api/team/errors/[id]/resolve', 'POST', handlePost);
