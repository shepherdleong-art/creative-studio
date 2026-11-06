import assert from 'node:assert/strict';
import { TeamAuthError } from '../lib/team-service/auth/types.ts';
import { authError } from '../lib/team-service/auth/http.ts';

// Next emits independent server bundles while sharing one auth service on globalThis.
// Load an independent copy of the actual error module to reproduce this boundary.
const otherModule = new URL('../lib/team-service/auth/types.ts', import.meta.url);
otherModule.searchParams.set('bundle', 'server-component');
const { TeamAuthError: OtherBundleError } = await import(otherModule.href);
assert.notEqual(TeamAuthError, OtherBundleError);
const response = authError(new OtherBundleError('invalid_credentials', '工号或凭据无效。', 401));
assert.equal(response.status, 401, '跨页面错误不得退化为“身份服务暂时不可用”');
assert.deepEqual(await response.json(), { error: 'invalid_credentials', message: '工号或凭据无效。' });
assert.equal(authError(new OtherBundleError('credential_consumed', '一次性密码已使用', 401)).status, 401);
assert.equal(authError(new Error('private internal details')).status, 500);
assert.equal(authError({ name: 'TeamAuthError', status: 401, code: 'forged', message: 'not trusted' }).status, 500);
console.log('cross-bundle auth error tests passed');
