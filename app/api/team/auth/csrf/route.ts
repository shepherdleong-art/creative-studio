import { authError, authJson } from '../../../../../lib/team-service/auth/http.ts';
import { issueCsrfToken } from '../../../../../lib/team-service/auth/request.ts';

export async function GET(): Promise<Response> {
  try {
    const csrf = issueCsrfToken();
    return authJson({ csrfToken: csrf.token }, { setCookie: csrf.cookie });
  } catch (error) {
    return authError(error);
  }
}
