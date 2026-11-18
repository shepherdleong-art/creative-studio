import { authError } from '../../../../../lib/team-service/auth/http.ts';
import {
  assertTrustedWriteRequest,
  clearSessionCookie,
  optionalPrincipal,
} from '../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../lib/team-service/auth/runtime.ts';
import { viewAsUserCookie } from '../../../../../lib/team-service/view-as-user.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const principal = optionalPrincipal(request);
    if (principal) getTeamAuthService().logout(principal);
    // 退出时一并清掉视角 Cookie，避免下次登录沿用上一位管理员的用户视角。
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', clearSessionCookie());
    headers.append('Set-Cookie', viewAsUserCookie(false));
    return new Response(JSON.stringify({ loggedOut: true }), { status: 200, headers });
  } catch (error) {
    return authError(error);
  }
}
export const POST = withTeamRoute('/api/team/auth/logout', 'POST', __teamRoutePOST);
