import assert from 'node:assert/strict';
import { getEffectiveImageConcurrency } from '../lib/provider-concurrency.ts';

assert.equal(getEffectiveImageConcurrency('packy-gemini-image', 3), 1);
assert.equal(getEffectiveImageConcurrency('packy-gemini-image', 1), 1);
assert.equal(getEffectiveImageConcurrency('packy-images', 3), 3);
assert.equal(getEffectiveImageConcurrency('geekai-json', 4), 4);
assert.equal(getEffectiveImageConcurrency('openai-compatible', 0), 1);

console.log('provider-concurrency tests passed');
