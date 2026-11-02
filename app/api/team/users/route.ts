import { authError, authJson, readJson } from '../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, requirePrincipal } from '../../../../lib/team-service/auth/request.ts';
import { getTeamAuthService } from '../../../../lib/team-service/auth/runtime.ts';
import { TeamAuthError, type TeamRole } from '../../../../lib/team-service/auth/types.ts';

export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requirePrincipal(request, { admin: true });
    return authJson({ users: getTeamAuthService().listUsers(actor) });
  } catch (error) {
    return authError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const actor = requirePrincipal(request, { admin: true });
    const body = await readJson(request);
    if (typeof body.employeeId !== 'string' || typeof body.displayName !== 'string'
      || (body.role !== 'employee' && body.role !== 'admin')) {
      throw new TeamAuthError('invalid_request', '建号参数无效。');
    }
    const result = await getTeamAuthService().createUser(actor, {
      employeeId: body.employeeId,
      displayName: body.displayName,
      role: body.role as TeamRole,
    });
    return authJson(result, { status: 201 });
  } catch (error) {
    return authError(error);
  }
}
