import assert from 'node:assert/strict';

process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'server';
process.env.CREATIVE_STUDIO_DATA_ROOT = process.cwd();
process.env.CREATIVE_STUDIO_PORT = '3400';
process.env.CREATIVE_STUDIO_DEPLOYMENT_ID = 'local-cookie-test';
process.env.CREATIVE_STUDIO_TRUSTED_ORIGIN = 'http://127.0.0.1:3400';
process.env.CREATIVE_STUDIO_TEAM_LOCAL_HTTP = '1';

const {
  teamCookiePolicy,
  issueCsrfToken,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  TEAM_SESSION_COOKIE,
  TEAM_CSRF_COOKIE,
} = await import('../lib/team-service/auth/request.ts');

const local = teamCookiePolicy();
assert.equal(local.secure, false);
assert.equal(TEAM_SESSION_COOKIE, 'creative_studio_team_session_local');
assert.equal(TEAM_CSRF_COOKIE, 'creative_studio_team_csrf_local');
assert.ok(!TEAM_SESSION_COOKIE.startsWith('__Host-'));
assert.ok(!TEAM_CSRF_COOKIE.startsWith('__Host-'));

const csrf = issueCsrfToken();
assert.match(csrf.cookie, /HttpOnly/i);
assert.match(csrf.cookie, /SameSite=Strict/i);
assert.doesNotMatch(csrf.cookie, /Secure/i);
assert.equal(parseCookies(new Request('http://127.0.0.1:3400', {
  headers: { Cookie: csrf.cookie.split(';', 1)[0] },
}))[TEAM_CSRF_COOKIE], csrf.token);

assert.match(sessionCookie('local-session'), /HttpOnly; SameSite=Strict/i);
assert.doesNotMatch(sessionCookie('local-session'), /Secure/i);
assert.doesNotMatch(clearSessionCookie(), /Secure/i);

for (const env of [
  { CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test', CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1' },
  { CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_TRUSTED_ORIGIN: 'http://example.test', CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1' },
  { CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server', CREATIVE_STUDIO_TRUSTED_ORIGIN: 'http://127.0.0.1:3400' },
  { CREATIVE_STUDIO_DEPLOYMENT_MODE: 'local', CREATIVE_STUDIO_TRUSTED_ORIGIN: 'http://127.0.0.1:3400', CREATIVE_STUDIO_TEAM_LOCAL_HTTP: '1' },
]) {
  const policy = teamCookiePolicy({ NODE_ENV: 'test', ...env });
  assert.equal(policy.secure, true, '只有显式本机回环模式可以取消 Secure');
  assert.ok(policy.session.startsWith('__Host-'));
  assert.ok(policy.csrf.startsWith('__Host-'));
}

console.log('team local HTTP auth cookie tests passed');
