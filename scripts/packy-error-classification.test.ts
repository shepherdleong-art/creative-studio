import assert from 'node:assert/strict';
import { getNonRetryablePackyAdvice, isNonRetryablePackyError } from '../lib/packy-errors.ts';

assert.equal(
  isNonRetryablePackyError('Packy API error 500: not supported model for image generation (request id: abc)'),
  true,
);
assert.equal(isNonRetryablePackyError('Packy API error 400: invalid model'), true);
assert.equal(isNonRetryablePackyError('Packy Gemini returned non-JSON response 429: Too Many Requests'), true);
assert.equal(isNonRetryablePackyError('Packy API error 500: submit request timeout'), false);
assert.match(
  getNonRetryablePackyAdvice('Packy API error 429: Resource has been exhausted (e.g. check quota).'),
  /额度|限流/,
);
assert.match(getNonRetryablePackyAdvice('Packy API error 400: invalid model'), /参数|请求/);

console.log('packy-error-classification tests passed');
