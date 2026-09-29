import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as duration from '../lib/video-duration.ts';

const options = duration.videoDurationOptions('openai-video', 'kling-2.5');
assert.deepEqual(options, [5, 10]);
assert.equal(duration.normalizeVideoDraftDuration(15, options), 10);
assert.equal(duration.normalizeVideoDraftDuration(2, options), 5);
assert.equal(duration.normalizeVideoDraftDuration(10, options), 10);
for (const model of ['kling-3.0', 'kling-2.5-fast', 'KLING-2.5']) {
  assert.ok(duration.videoDurationOptions('openai-video', model).includes(15));
}
assert.ok(duration.videoDurationOptions('kling', 'kling-2.5').includes(15), '限制只绑定已核对的公司通道');

const writes = [];
const providers = {
  p25: { id: 'p25', type: 'openai-video', defaultModel: 'kling-2.5' },
  p30: { id: 'p30', type: 'openai-video', defaultModel: 'kling-3.0' },
};
const db = {
  prepare: sql => ({
    get: id => {
      if (sql.includes('FROM video_providers')) return providers[id];
      if (sql.includes('FROM shots')) return { id: 'shot', sourceImageId: 'source' };
      if (sql.includes('FROM shot_sets')) return { projectId: 'project' };
      throw new Error(`Unexpected query: ${sql}`);
    },
    run: (...args) => { assert.match(sql, /INSERT INTO video_jobs/); writes.push(args); },
  }),
  transaction: callback => callback,
};
function loadRoute(file) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, console,
    require: name => {
      if (name === 'next/server') return { NextResponse: Response };
      if (name === '@/lib/db') return { getDb: () => db };
      if (name === 'uuid') return { v4: () => 'job-fixture' };
      if (name === '@/lib/video-duration') return duration;
      if (name === '@/lib/video-auth') return { getVideoProviderConfigState: () => ({ configured: true }) };
      if (name === '@/lib/video-queue') return { getVideoQueueStatus: () => 'running' };
      if (name === '@/lib/video-tail-frame') return { validateVideoTailFrameAsset: () => ({ ok: true }), validateVideoTailFrameBatchDrafts: () => null };
      if (name === '@/lib/video-multi-shot') return { normalizeVideoMultiShotForStorage: () => null };
      if (name === '@/lib/video-output-filenames') return { countVideoJobsForShot: () => 0, planVideoJobDisplayName: () => 'fixture.mp4' };
      if (name === '@/lib/storage-url') return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return exports.POST;
}
const single = loadRoute('app/api/shot-sets/[id]/video-jobs/route.ts');
const batch = loadRoute('app/api/shot-sets/[id]/video-jobs/batch/route.ts');
async function submit(route, body, expectedStatus, expectedCount) {
  writes.length = 0;
  const response = await route(new Request('http://localhost/api/fixture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: 'set' }) });
  assert.equal(response.status, expectedStatus, await response.text());
  assert.equal(writes.length, expectedCount, '非法时长不得落库，批量必须整批拒绝');
}
for (const durationSec of [2, 7, 11, 15, 100, 10.5, null, 'invalid']) {
  const item = { providerId: 'p25', prompt: 'test', durationSec };
  await submit(single, { shotId: 'shot', ...item }, 400, 0);
  await submit(batch, { shotId: 'shot', items: [{ ...item, durationSec: 5 }, item] }, 400, 0);
}
for (const durationSec of [5, 10]) {
  const item = { providerId: 'p25', prompt: 'test', durationSec };
  await submit(single, { shotId: 'shot', ...item }, 200, 1);
  assert.equal(writes[0][10], durationSec);
  await submit(batch, { shotId: 'shot', items: [item] }, 200, 1);
  assert.equal(writes[0][10], durationSec);
}
await submit(single, { shotId: 'shot', providerId: 'p30', prompt: 'test', durationSec: 15 }, 200, 1);
await submit(batch, { shotId: 'shot', items: [{ providerId: 'p30', prompt: 'test', durationSec: 15 }] }, 200, 1);

const panel = fs.readFileSync('components/VideoGenerationPanel.tsx', 'utf8');
assert.equal((panel.match(/getRowDurationOptions\(row\)\.map/g) || []).length, 2, '单条/批量行都要使用模型时长选项');
assert.match(panel, /getBulkDurationOptions\(\)\.map/, '批量总控使用各行共同支持的时长');
assert.match(panel, /durationSec: getRowDuration\(r\)/, '单分镜提交与显示时长一致');
assert.match(panel, /durationSec: getRowDuration\(row\)/, '全部生成提交与显示时长一致');
assert.doesNotMatch(panel, /max=\{15\}/, '不能残留无模型约束的时长输入框');
console.log('video duration UI/API tests passed');
