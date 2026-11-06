import { authError, authJson } from '../../../../../lib/team-service/auth/http.ts';
import {
  assertTrustedWriteRequest,
  clearSessionCookie,
  optionalPrincipal,
} from '../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../lib/team-service/auth/runtime.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const principal = optionalPrincipal(request);
    if (principal) getTeamAuthService().logout(principal);
    return authJson({ loggedOut: true }, { setCookie: clearSessionCookie() });
  } catch (error) {
    return authError(error);
  }
}
export const POST = withTeamRoute('/api/team/auth/logout', 'POST', __teamRoutePOST);
