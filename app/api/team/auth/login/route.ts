import { authError, authJson, principalBody, readJson } from '../../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, sessionCookie } from '../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../lib/team-service/auth/runtime.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const body = await readJson(request);
    const result = await getTeamAuthService().login({
      employeeId: typeof body.employeeId === 'string' ? body.employeeId : '',
      password: typeof body.password === 'string' ? body.password : '',
    });
    return authJson(principalBody(result.principal), { setCookie: sessionCookie(result.token, body.remember === true) });
  } catch (error) {
    return authError(error);
  }
}
export const POST = withTeamRoute('/api/team/auth/login', 'POST', __teamRoutePOST);
