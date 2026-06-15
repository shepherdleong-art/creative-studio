import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildPackyGeminiChatPayload,
  extractPackyGeminiImageSource,
} from '../lib/providers/packy-gemini-image.ts';

const payload = buildPackyGeminiChatPayload({
  model: 'gemini-3.1-flash-image-preview',
  prompt: '生成新的沙发场景图',
  inputImageDataUrl: 'data:image/jpeg;base64,BASE',
  referenceImageDataUrls: ['data:image/png;base64,REF'],
  size: '1728x2304',
});

assert.equal(payload.model, 'gemini-3.1-flash-image-preview');
assert.equal(payload.stream, false);
assert.equal(payload.messages.length, 1);
assert.deepEqual(
  payload.messages[0].content.map((part) => part.type),
  ['text', 'image_url', 'image_url'],
);
assert.match(payload.messages[0].content[0].text ?? '', /1728x2304/);
assert.equal(payload.messages[0].content[1].image_url?.url, 'data:image/jpeg;base64,BASE');
assert.equal(payload.messages[0].content[2].image_url?.url, 'data:image/png;base64,REF');

const png = Buffer.from('fake-png').toString('base64');
assert.equal(
  extractPackyGeminiImageSource({
    choices: [{ message: { content: `![image](data:image/png;base64,${png})` } }],
  }),
  `data:image/png;base64,${png}`,
);
assert.equal(
  extractPackyGeminiImageSource({
    choices: [{ message: { content: 'https://example.com/output.png' } }],
  }),
  'https://example.com/output.png',
);
assert.equal(
  extractPackyGeminiImageSource({
    choices: [{ message: { content: 'https://cdn.packyapi.com/outputs/abc123?format=png&token=1' } }],
  }),
  'https://cdn.packyapi.com/outputs/abc123?format=png&token=1',
);

console.log('packy-gemini-image tests passed');
