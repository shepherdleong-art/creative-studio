import assert from 'node:assert/strict';
import {
  isCompanyKlingMultiShotTarget,
  normalizeVideoMultiShotForStorage,
  videoMultiShotFromStorage,
  shouldInjectCompanyKlingMultiShot,
} from '../lib/video-multi-shot.ts';

assert.equal(
  isCompanyKlingMultiShotTarget('openai-video', 'kling-3.0'),
  true,
  'only the exact company Kling 3.0 provider/model pair is managed',
);
for (const [providerType, model] of [
  ['openai-video', 'kling-v3'],
  ['openai-video', 'kling-3.0-fast'],
  ['kling', 'kling-3.0'],
  ['openai-video', 'kling-3.0-Omni'],
]) {
  assert.equal(
    isCompanyKlingMultiShotTarget(providerType, model),
    false,
    `${providerType}/${model} must not be treated as the exact target`,
  );
}

assert.equal(
  normalizeVideoMultiShotForStorage('openai-video', 'kling-3.0', undefined),
  1,
  'the managed target defaults to enabled',
);
assert.equal(
  normalizeVideoMultiShotForStorage('openai-video', 'kling-3.0', false),
  0,
  'an explicit false disables intelligent storyboard',
);
assert.equal(
  normalizeVideoMultiShotForStorage('openai-video', 'kling-3.0', true),
  1,
  'an explicit true enables intelligent storyboard',
);
assert.equal(
  normalizeVideoMultiShotForStorage('kling', 'kling-3.0', false),
  null,
  'direct Kling rows never persist this company-only flag',
);
assert.equal(
  normalizeVideoMultiShotForStorage('openai-video', 'kling-v3', true),
  null,
  'non-exact models never persist this company-only flag',
);

assert.equal(videoMultiShotFromStorage(1), true);
assert.equal(videoMultiShotFromStorage(0), false);
assert.equal(videoMultiShotFromStorage(null), undefined);
assert.equal(videoMultiShotFromStorage(undefined), undefined);

assert.equal(shouldInjectCompanyKlingMultiShot('kling-3.0', undefined), true);
assert.equal(shouldInjectCompanyKlingMultiShot('kling-3.0', true), true);
assert.equal(shouldInjectCompanyKlingMultiShot('kling-3.0', false), false);
assert.equal(shouldInjectCompanyKlingMultiShot('kling-v3', undefined), false);
assert.equal(shouldInjectCompanyKlingMultiShot('kling-3.0-Omni', undefined), false);

console.log('video multi-shot tests passed');
