import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readRuntimeConfig } from '../config.ts';
import { getTeamAuthService } from './runtime.ts';
import {
  assertIdentityOperationAllowed,
  TeamAuthError,
  type AuthPrincipal,
} from './types.ts';

export const TEAM_SESSION_COOKIE = '__Host-team_session';
export const TEAM_CSRF_COOKIE = '__Host-team_csrf';
export const TEAM_CSRF_HEADER = 'x-csrf-token';

export function parseCookies(request: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

export function assertServerAuthEnabled(): void {
  if (readRuntimeConfig().mode !== 'server') {
    throw new TeamAuthError('not_found', '入口不存在。', 404);
  }
}

export function assertTrustedWriteRequest(request: Request): void {
  assertServerAuthEnabled();
  const config = readRuntimeConfig();
  if (config.mode !== 'server' || request.headers.get('origin') !== config.trustedOrigin) {
    throw new TeamAuthError('origin_invalid', '请求来源不受信任。', 403);
  }
  const cookieToken = parseCookies(request)[TEAM_CSRF_COOKIE];
  const headerToken = request.headers.get(TEAM_CSRF_HEADER);
  if (!cookieToken || !headerToken) throw new TeamAuthError('csrf_invalid', 'CSRF 校验失败。', 403);
  const cookie = Buffer.from(cookieToken);
  const header = Buffer.from(headerToken);
  if (cookie.length !== header.length || !timingSafeEqual(cookie, header)) {
    throw new TeamAuthError('csrf_invalid', 'CSRF 校验失败。', 403);
  }
}

export function issueCsrfToken(): { token: string; cookie: string } {
  assertServerAuthEnabled();
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    cookie: `${TEAM_CSRF_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  };
}

export function sessionCookie(token: string): string {
  return `${TEAM_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
}

export function clearSessionCookie(): string {
  return `${TEAM_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function optionalPrincipal(request: Request): AuthPrincipal | null {
  assertServerAuthEnabled();
  const token = parseCookies(request)[TEAM_SESSION_COOKIE];
  return token ? getTeamAuthService().resolveSession(token) : null;
}

export function requirePrincipal(
  request: Request,
  options: { allowMustChangePassword?: boolean; admin?: boolean } = {},
): AuthPrincipal {
  const principal = optionalPrincipal(request);
  if (!principal) throw new TeamAuthError('session_invalid', '请先登录。', 401);
  if (options.allowMustChangePassword && principal.mustChangePassword) {
    assertIdentityOperationAllowed(principal, 'session');
  } else {
    assertIdentityOperationAllowed(principal, options.admin ? 'users' : 'business');
  }
  if (options.admin && principal.role !== 'admin') {
    throw new TeamAuthError('admin_required', '需要管理员权限。', 403);
  }
  return principal;
}
