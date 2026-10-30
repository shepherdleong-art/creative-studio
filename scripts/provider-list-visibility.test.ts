import assert from 'node:assert/strict';
import { isVisibleImageProvider, isVisibleVideoProvider } from '../lib/provider-list-visibility.ts';

const image = { id: 'custom', name: 'My provider', type: 'openai-compatible', baseUrl: 'https://example.invalid' };
for (const id of ['packy-gpt-image-2', 'packy-nano-banana-2', 'packy-nano-banana-pro', 'gptge-gpt-image-2', 'gptge-nano-banana-2-2k', 'gptge-nano-banana-pro-2k', 'ark-seedream-5-0-pro']) {
  assert.equal(isVisibleImageProvider({ ...image, id }), false);
}
assert.equal(isVisibleImageProvider({ ...image, name: 'GeekAI', type: 'geekai-json', baseUrl: 'https://geekai.co/api/' }), false);
assert.equal(isVisibleImageProvider(image), true);
assert.equal(isVisibleImageProvider({ ...image, id: 'company-gpt-image-2' }), true);
assert.equal(isVisibleVideoProvider({ id: 'jimeng-2-0' }), false);
assert.equal(isVisibleVideoProvider({ id: 'kling-2-5' }), false);
for (const id of ['company-seedance-2-0', 'company-kling-2-5', 'custom']) assert.equal(isVisibleVideoProvider({ id }), true);
console.log('provider list visibility tests passed');
