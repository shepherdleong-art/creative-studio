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
let companyRequest = false;
const transport: typeof fetch = async (_input, init) => {
  sent = JSON.parse(String(init?.body));
  const promotion = (sent.content as Array<{ type: string }> | undefined)?.some(item => item.type === 'draft_task');
  const allowedCompanyFields = new Set(['model', 'content', 'resolution', 'prompt']);
  const forbidden = promotion && companyRequest
    ? Object.keys(sent).find(key => !allowedCompanyFields.has(key))
    : promotion && 'return_last_frame' in sent ? 'return_last_frame' : undefined;
  if (forbidden) return Response.json({ error: {
    message: 'draft promotion cannot include ' + forbidden, code: 'invalid_draft_task',
  } }, { status: 400 });
  return Response.json({ id: 'final-task', model: SEEDANCE_25, status: 'queued' });
};
try {
  for (const [adapter, baseUrl, gateway] of [
    [createJimengAdapter({ fetchImpl: transport }), 'https://ark.example.test/api/v3', false],
    [createCompanySeedanceVideoAdapter(transport), 'http://127.0.0.1:4000', true],
  ] as const) {
    companyRequest = gateway;
    for (const outputFormat of [undefined, 'mp4', 'mov'] as const)
      for (const watermark of [undefined, false, true])
        for (const returnLastFrame of [false, true]) {
      const result = await adapter.submitFinal!({ model: SEEDANCE_25, draftTaskId: 'fixed-draft',
        outputFormat, watermark, returnLastFrame }, 'fixture-key', baseUrl);
      assert.equal(result.providerTaskId, 'final-task');
      assert.deepEqual(sent, { model: SEEDANCE_25, content: [{ type: 'draft_task', draft_task: { id: 'fixed-draft' } }],
        resolution: '1080p', ...(gateway ? { prompt: '' } : {
          ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
          ...(watermark === undefined ? {} : { watermark }),
        }) },
      'legacy Final options cannot leak unsupported ordinary-generation fields');
    }
  }
  companyRequest = true;
  const company = createCompanySeedanceVideoAdapter(transport);
  await company.submitText!({ model: SEEDANCE_25, prompt: 'sample scene', durationSec: 5,
    resolution: '480p', draft: true, outputFormat: 'mp4', watermark: true, generateAudio: true },
    'fixture-key', 'http://127.0.0.1:4000');
  assert.equal(sent.draft, true, '普通样片生成保留阶段参数');
  assert.equal(sent.watermark, true, '普通生成仍可设置水印');
  assert.equal(sent.output_format, 'mp4', '普通生成仍可设置格式');
  assert.equal(sent.seconds, '5');
  console.log('seedance-final-request.test.ts passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
