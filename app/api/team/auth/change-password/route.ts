import { authError, authJson, principalBody, readJson } from '../../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, requirePrincipal } from '../../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../../lib/team-service/auth/runtime.ts';

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const principal = requirePrincipal(request, { allowMustChangePassword: true });
    const body = await readJson(request);
    const updated = await getTeamAuthService().changeOwnPassword(
      principal,
      typeof body.currentPassword === 'string' ? body.currentPassword : '',
      typeof body.newPassword === 'string' ? body.newPassword : '',
    );
    return authJson(principalBody(updated));
  } catch (error) {
    return authError(error);
  }
}
