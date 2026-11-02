import { authError, authJson } from '../../../../../lib/team-service/auth/http.ts';
import { issueCsrfToken } from '../../../../../lib/team-service/auth/request.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(): Promise<Response> {
  try {
    const csrf = issueCsrfToken();
    return authJson({ csrfToken: csrf.token }, { setCookie: csrf.cookie });
  } catch (error) {
    return authError(error);
  }
}
export const GET = withTeamRoute('/api/team/auth/csrf', 'GET', __teamRouteGET);
