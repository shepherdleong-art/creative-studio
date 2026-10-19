import assert from 'node:assert/strict';

const {
  getImageModelCapabilities,
  imageModelSupportsQuality,
  PACKY_IMAGE_MODEL_OPTIONS,
} = await import('../lib/image-model-capabilities' + '.ts');

assert.equal(imageModelSupportsQuality('gpt-image-2'), true);
assert.equal(imageModelSupportsQuality('gemini-3.1-flash-image-preview'), false);
assert.equal(imageModelSupportsQuality('gemini-3.1-flash-image-2k'), false);
assert.equal(imageModelSupportsQuality('gemini-3-pro-image-preview'), false);
assert.equal(imageModelSupportsQuality('gemini-3-pro-image-2k'), false);

assert.equal(getImageModelCapabilities('unknown-model').supportsQuality, true);

assert.deepEqual(
  PACKY_IMAGE_MODEL_OPTIONS.map((option: { model: string; supportsQuality: boolean }) => ({
    model: option.model,
    supportsQuality: option.supportsQuality,
  })),
  [
    { model: 'gpt-image-2', supportsQuality: true },
    { model: 'gemini-3.1-flash-image-preview', supportsQuality: false },
    { model: 'gemini-3.1-flash-image-2k', supportsQuality: false },
    { model: 'gemini-3-pro-image-preview', supportsQuality: false },
    { model: 'gemini-3-pro-image-2k', supportsQuality: false },
  ]
);
