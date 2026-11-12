import assert from 'node:assert/strict';
import { providerErrorMessage } from '../lib/provider-error-message.ts';

const privacy = { error: {
  code: 'InputImageSensitiveContentDetected.PrivacyInformation',
  message: "The request failed because the input image 'content[1]' may contain real person.",
  param: 'content[1]',
} };
const wrapped = JSON.stringify({ error: { message: 'litellm.BadRequestError: OpenAIException - ' +
  JSON.stringify({ code: 'fail_to_fetch_task', message: JSON.stringify(privacy), data: null }) +
  ' Received Model Group=seedance. Available Fallbacks=None' } });
const reason = providerErrorMessage(wrapped)!;
assert.match(reason, /may contain real person/);
assert.match(reason, /InputImageSensitiveContentDetected\.PrivacyInformation/);
assert.match(reason, /content\[1\]/);
assert.equal(reason.includes('fail_to_fetch_task'), false, '优先显示最内层上游原因');
assert.equal(reason.includes('Received Model Group'), false, '不回显代理附言');
assert.equal(reason.includes('{'), false, '不回显完整 JSON');

const credential = 'fixture-credential-short';
const safe = providerErrorMessage({ error: {
  code: 'InvalidParameter', message: `invalid resolution; ${credential}; Bearer fixture-bearer; ` +
    'https://user:password@media.example.test/ref.png?signature=fixture-signed; C:\\private\\input.png',
  request: { api_key: credential, content: 'private-request' },
} }, credential)!;
for (const secret of [credential, 'fixture-bearer', 'fixture-signed', 'media.example.test', 'private-request', 'private']) {
  assert.equal(safe.includes(secret), false, `展示原因不得泄漏 ${secret}`);
}
assert.match(safe, /invalid resolution/);
assert.match(safe, /InvalidParameter/);
assert.equal(providerErrorMessage('{"error":{"message":"truncated'), null);
assert.equal(providerErrorMessage('<html>bad gateway</html>'), null);
assert.equal(providerErrorMessage({ request: { api_key: credential } }), null);
assert.equal(providerErrorMessage(null), null);
assert.equal(providerErrorMessage('bad request'), 'bad request');
assert.equal(providerErrorMessage({ error: 'BadRequest', message: 'invalid resolution' }), 'invalid resolution');
assert.equal(providerErrorMessage({ detail: [{ msg: 'invalid duration', input: 'private request' }] }), 'invalid duration');
assert.equal(providerErrorMessage(new Error('bad request')), 'bad request');
assert.equal(providerErrorMessage({ error: { message: 'x'.repeat(2000) } })?.length, 800);
const lateMessage = providerErrorMessage(JSON.stringify({
  ignored: 'x'.repeat(2000), error: { code: 'InvalidParameter', message: 'invalid duration' },
}));
assert.match(lateMessage ?? '', /invalid duration/, '先解析具体原因，再截断展示文本');
console.log('provider-error-message.test.ts 通过');
