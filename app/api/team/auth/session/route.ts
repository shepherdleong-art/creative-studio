import { authError, authJson, principalBody } from '../../../../../lib/team-service/auth/http.ts';
import { optionalPrincipal } from '../../../../../lib/team-service/auth/request.ts';

export async function GET(request: Request): Promise<Response> {
  try {
    const principal = optionalPrincipal(request);
    return authJson(principal
      ? { authenticated: true, ...principalBody(principal) }
      : { authenticated: false });
  } catch (error) {
    return authError(error);
  }
}
