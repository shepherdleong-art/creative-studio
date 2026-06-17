import assert from 'node:assert/strict';

const { DEFAULT_IMAGE_PROVIDER_PRESETS } = await import('../lib/image-provider-presets' + '.ts');

const gptGeGptImage2 = DEFAULT_IMAGE_PROVIDER_PRESETS.find(
  (provider: { id: string }) => provider.id === 'gptge-gpt-image-2',
);

assert.ok(gptGeGptImage2, 'GPT.ge GPT-Image-2 preset should exist');
assert.equal(gptGeGptImage2.name, 'GPT.ge GPT-Image-2');
assert.equal(gptGeGptImage2.baseUrl, 'https://api.gpt.ge');
assert.equal(gptGeGptImage2.apiKeyEnv, 'GPTGE_API_KEY');
assert.equal(gptGeGptImage2.apiKey, '');
assert.equal(gptGeGptImage2.model, 'gpt-image-2');
assert.equal(gptGeGptImage2.type, 'openai-compatible');
assert.equal(gptGeGptImage2.enabled, 0);
assert.equal(gptGeGptImage2.defaultCostPerImage, 0.12);

console.log('image-provider-presets tests passed');
