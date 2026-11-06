import { authError, authJson, readJson } from '../../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, requirePrincipal } from '../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../lib/team-service/auth/runtime.ts';
import { TeamAuthError } from '../../../../../lib/team-service/auth/types.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const actor = requirePrincipal(request, { admin: true });
    const body = await readJson(request);
    const { id } = await context.params;
    const service = getTeamAuthService();
    if (body.role !== undefined && body.status !== undefined) {
      throw new TeamAuthError('invalid_request', '角色与账号状态请分别修改。');
    }
    if (body.role === 'employee' || body.role === 'admin') {
      return authJson({ user: service.setUserRole(actor, id, body.role) });
    }
    if (body.status === 'active' || body.status === 'disabled') {
      return authJson({ user: service.setUserStatus(actor, id, body.status) });
    }
    throw new TeamAuthError('invalid_request', '没有可应用的账号变更。');
  } catch (error) {
    return authError(error);
  }
}
export const PATCH = withTeamRoute('/api/team/users/[id]', 'PATCH', __teamRoutePATCH);
