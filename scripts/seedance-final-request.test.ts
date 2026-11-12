import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-final-request-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { createJimengAdapter } = await import('../lib/video-providers/jimeng.ts');
const { createCompanySeedanceVideoAdapter } = await import('../lib/video-providers/company-seedance-video.ts');
const { SEEDANCE_25 } = await import('../lib/video-providers/seedance-contract.ts');
let sent: Record<string, unknown> = {};
const transport: typeof fetch = async (_input, init) => {
  sent = JSON.parse(String(init?.body));
  if ('return_last_frame' in sent) return Response.json({ error: {
    message: 'draft promotion cannot include return_last_frame', code: 'invalid_draft_task',
  } }, { status: 400 });
  return Response.json({ id: 'final-task', model: SEEDANCE_25, status: 'queued' });
};
try {
  for (const [adapter, baseUrl, gateway] of [
    [createJimengAdapter({ fetchImpl: transport }), 'https://ark.example.test/api/v3', false],
    [createCompanySeedanceVideoAdapter(transport), 'http://127.0.0.1:4000', true],
  ] as const) {
    for (const returnLastFrame of [false, true]) {
      const result = await adapter.submitFinal!({ model: SEEDANCE_25, draftTaskId: 'fixed-draft',
        outputFormat: 'mp4', watermark: false, returnLastFrame }, 'fixture-key', baseUrl);
      assert.equal(result.providerTaskId, 'final-task');
      assert.deepEqual(sent, { model: SEEDANCE_25, content: [{ type: 'draft_task', draft_task: { id: 'fixed-draft' } }],
        resolution: '1080p', output_format: 'mp4', watermark: false, ...(gateway ? { prompt: '' } : {}) },
      'legacy Final options cannot leak unsupported ordinary-generation fields');
    }
  }
  console.log('seedance-final-request.test.ts passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
