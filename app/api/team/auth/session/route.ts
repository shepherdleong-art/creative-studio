import { authError, authJson, principalBody } from '../../../../../lib/team-service/auth/http.ts';
import { optionalPrincipal, parseCookies } from '../../../../../lib/team-service/auth/request.ts';
import { VIEW_AS_USER_COOKIE, resolveViewMode } from '../../../../../lib/team-service/view-as-user.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const principal = optionalPrincipal(request);
    return authJson(principal
      ? {
        authenticated: true,
        ...principalBody(principal),
        // 04 号票：客户端据此按用户视角渲染导航与入口（服务端权限不变）。
        viewMode: resolveViewMode(principal.role, parseCookies(request)[VIEW_AS_USER_COOKIE]),
      }
      : { authenticated: false });
  } catch (error) {
    return authError(error);
  }
}
export const GET = withTeamRoute('/api/team/auth/session', 'GET', __teamRouteGET);
