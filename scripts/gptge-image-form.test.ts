import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editImage } from '../lib/providers/openai-compatible.ts';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptge-image-form-'));
const inputPath = path.join(tmpDir, 'input.png');
fs.writeFileSync(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

let capturedUrl = '';
let capturedForm: FormData | undefined;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  capturedUrl = String(url);
  capturedForm = init?.body as FormData;
  return {
    ok: true,
    json: async () => ({
      data: [{ b64_json: Buffer.from('ok').toString('base64') }],
    }),
  } as Response;
}) as typeof fetch;

try {
  await editImage(
    {
      provider: {
        id: 'gptge-gpt-image-2',
        name: 'GPT.ge GPT-Image-2',
        baseUrl: 'https://api.gpt.ge',
        apiKeyEnv: 'GPTGE_API_KEY',
        model: 'gpt-image-2',
        type: 'openai-compatible',
        enabled: true,
        defaultCostPerImage: 0.12,
      },
      model: 'gpt-image-2',
      prompt: '让小狗微笑',
      inputImagePath: inputPath,
      inputMimeType: 'image/png',
      referenceImagePaths: [],
      referenceMimeTypes: [],
      size: '1024x1024',
      quality: 'auto',
    },
    'test-key',
    'https://api.gpt.ge',
  );
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

assert.equal(capturedUrl, 'https://api.gpt.ge/v1/images/edits');
assert.ok(capturedForm, 'expected multipart FormData body');

const keys = Array.from(capturedForm!.keys());
assert.ok(keys.includes('image'), 'GPT.ge image edits should use FormData field "image"');
assert.ok(!keys.includes('image[]'), 'GPT.ge docs do not use image[] for edits');
assert.ok(!keys.includes('response_format'), 'GPT.ge image edits should not force response_format=b64_json');
assert.equal(capturedForm!.get('model'), 'gpt-image-2');
assert.equal(capturedForm!.get('prompt'), '让小狗微笑');
assert.equal(capturedForm!.get('size'), '1024x1024');
assert.equal(capturedForm!.get('n'), '1');

console.log('gptge-image-form tests passed');
