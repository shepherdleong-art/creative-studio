import { authError, authJson, principalBody } from '../../../../../lib/team-service/auth/http.ts';
import { optionalPrincipal } from '../../../../../lib/team-service/auth/request.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(request: Request): Promise<Response> {
  try {
    const principal = optionalPrincipal(request);
    return authJson(principal
      ? { authenticated: true, ...principalBody(principal) }
      : { authenticated: false });
  } catch (error) {
    return authError(error);
  }
}
export const GET = withTeamRoute('/api/team/auth/session', 'GET', __teamRouteGET);
