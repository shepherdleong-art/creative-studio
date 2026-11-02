import { authError, authJson } from '../../../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, requirePrincipal } from '../../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../../lib/team-service/auth/runtime.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const actor = requirePrincipal(request, { admin: true });
    const { id } = await context.params;
    return authJson(await getTeamAuthService().resetUserCredential(actor, id));
  } catch (error) {
    return authError(error);
  }
}
export const POST = withTeamRoute('/api/team/users/[id]/reset-credential', 'POST', __teamRoutePOST);
