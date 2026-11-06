import { TeamAuthError, type AuthPrincipal, type TeamRole } from './types.ts';

export function authJson(
  body: unknown,
  options: { status?: number; setCookie?: string } = {},
): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (options.setCookie) headers.set('Set-Cookie', options.setCookie);
  return Response.json(body, { status: options.status ?? 200, headers });
}

export function authError(error: unknown): Response {
  if (error instanceof TeamAuthError) {
    return authJson({ error: error.code, message: error.message }, { status: error.status });
  }
  return authJson({ error: 'internal_error', message: '身份服务暂时不可用。' }, { status: 500 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new TeamAuthError('invalid_request', '请求 JSON 无效。');
  }
}

export function principalBody(principal: AuthPrincipal): {
  user: { id: string; employeeId: string; displayName: string; role: TeamRole };
  mustChangePassword: boolean;
  absoluteExpiresAt: string;
} {
  return {
    user: {
      id: principal.userId,
      employeeId: principal.employeeId,
      displayName: principal.displayName,
      role: principal.role,
    },
    mustChangePassword: principal.mustChangePassword,
    absoluteExpiresAt: principal.absoluteExpiresAt,
  };
}
