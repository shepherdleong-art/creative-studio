process.env.CREATIVE_STUDIO_CANVAS_EXECUTOR = 'company';
process.env.CREATIVE_STUDIO_CANVAS_TEST_ROOT = '1';
import assert from 'node:assert/strict';
import { referenceCombinationProblems } from '../lib/creative-canvas/adapters/external.ts';
import Database from 'better-sqlite3';
import { SEEDANCE_20, SEEDANCE_25, SEEDANCE_FAST, seedanceOutputFields, seedanceFinalBody, assertArkRequestSize } from '../lib/video-providers/seedance-contract.ts';
import { directSeedanceCapability } from '../lib/creative-canvas/adapters/seedance-capabilities.ts';
import { registerCanvasCapability, validateCapabilityInputs } from '../lib/creative-canvas/capabilities.ts';
import { CREATIVE_CANVAS_MIGRATIONS } from '../lib/creative-canvas/schema.ts';
import { createCanvas, saveCanvasGraph } from '../lib/creative-canvas/repository.ts';
import { startCanvasRun } from '../lib/creative-canvas/runs.ts';
import { claimCanvasTasks } from '../lib/creative-canvas/tasks.ts';
import { companyVideoCapsForModel } from '../lib/company-gateway-size.ts';
import { companyGatewayTailFrameCapability } from '../lib/company-gateway-tail-frame.ts';
import { videoDurationOptions } from '../lib/video-duration.ts';
import { COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY, COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY, companyCanvasSupportsTailFrame } from '../lib/creative-canvas/adapters/company-capabilities.ts';

for (const model of [SEEDANCE_20, SEEDANCE_25] as const) {
  const capability = directSeedanceCapability(model);
  registerCanvasCapability(capability);
  assert.equal(validateCapabilityInputs({ capability, mode: 'text-to-video', refs: [], parameters: { durationSec: -1, resolution: '720p', withAudio: false } }).length, 0);
  assert.ok(validateCapabilityInputs({ capability, mode: 'text-to-video', refs: [], parameters: { durationSec: 4.5 } }).length);
  for (const durationSec of [0, -2, model === SEEDANCE_25 ? 31 : 16]) assert.ok(validateCapabilityInputs({ capability, mode: 'text-to-video', refs: [], parameters: { durationSec } }).length);
  assert.equal(seedanceOutputFields(model, { resolution: '720p', generateAudio: false }).generate_audio, false);
}
assert.equal(seedanceOutputFields(SEEDANCE_FAST, {}).resolution, '720p');
assert.throws(() => seedanceOutputFields(SEEDANCE_FAST, { resolution: '1080p' }));
assert.throws(() => seedanceOutputFields(SEEDANCE_20, { draft: true }));
assert.throws(() => seedanceOutputFields(SEEDANCE_20, { outputFormat: 'mov' }));
assert.equal(seedanceOutputFields(SEEDANCE_20, { resolution: '4k' }).resolution, '4k');
assert.equal(seedanceOutputFields(SEEDANCE_25, { draft: true }).resolution, '480p');
assert.throws(() => seedanceOutputFields(SEEDANCE_25, { draft: true, resolution: '1080p' }));
const final = seedanceFinalBody({ model: SEEDANCE_25, draftTaskId: 'fixed' });
assert.deepEqual(Object.keys(final).sort(), ['content', 'model', 'resolution']);
assert.throws(() => assertArkRequestSize({ prompt: 'x'.repeat(64 * 1024 * 1024) }), /64 MB/);
for (const capability of [COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY, COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY]) {
  const durations = videoDurationOptions('openai-video', capability.modelAlias);
  assert.deepEqual(capability.parameters.find((p) => p.key === 'resolution')?.options, companyVideoCapsForModel(capability.modelAlias)?.tiers.map((tier) => tier.toLowerCase()) ?? ['gateway-default']);
  assert.equal(companyCanvasSupportsTailFrame(capability.modelAlias), companyGatewayTailFrameCapability(capability.modelAlias).supported);
  const parameter = capability.parameters.find((p) => p.key === 'durationSec')!;
  assert.equal(parameter.min, Math.min(...durations)); assert.equal(parameter.max, Math.max(...durations));
  assert.ok(validateCapabilityInputs({ capability, mode: 'text-to-video', refs: [], parameters: { resolution: '480p' } }).length);
}
for (const [model, count, pureAudio] of [[SEEDANCE_20, 9, false], [SEEDANCE_25, 30, true]] as const) {
  const capability = directSeedanceCapability(model);
  const check = (length: number) => validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: Array.from({ length }, (_, i) => ({ kind: 'image' as const, role: 'reference' as const, refId: String(i) })) });
  assert.equal(check(count).length, 0); assert.ok(check(count + 1).length);
  for (const kind of ['video', 'audio'] as const) {
    const maximum = model === SEEDANCE_25 ? 10 : 3;
    const refs = Array.from({ length: maximum }, (_, index) => ({ kind, role: kind === 'audio' ? 'audio' as const : 'reference' as const, refId: `r${index}` }));
    const visual = kind === 'audio' && model === SEEDANCE_20 ? [{ kind: 'image' as const, role: 'reference' as const, refId: 'image' }] : [];
    assert.equal(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: [...visual, ...refs] }).length, 0);
    assert.ok(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: [...visual, ...refs, { ...refs[0], refId: 'excess' }] }).length);
  }
  assert.equal(validateCapabilityInputs({ capability, mode: 'reference-to-video', refs: [{ kind: 'audio', role: 'audio', refId: 'a' }] }).length === 0, pureAudio);
}
for (const kind of ['video', 'audio'] as const) {
  const refs = Array.from({ length: 10 }, (_, index) => ({ kind, refId: String(index), durationSec: 3 }));
  assert.deepEqual(referenceCombinationProblems(refs, SEEDANCE_25, 'reference-to-video'), []);
  assert.match(referenceCombinationProblems(refs.map((r) => ({ ...r, durationSec: 3.026 })), SEEDANCE_25, 'reference-to-video').join('；'), /总时长/);
  assert.match(referenceCombinationProblems([{ kind, refId: 'unknown', durationSec: null }], SEEDANCE_25, 'reference-to-video').join('；'), /缺少有效时长/);
  assert.match(referenceCombinationProblems([{ kind, refId: 'long', durationSec: 30.001 }], SEEDANCE_25, 'reference-to-video').join('；'), /上限/);
}
assert.deepEqual(referenceCombinationProblems([{ kind: 'video', refId: 'v', durationSec: 30 }, { kind: 'audio', refId: 'a', durationSec: 30 }], SEEDANCE_25, 'reference-to-video'), [], '分类总量单独计算');
assert.deepEqual(referenceCombinationProblems([{ kind: 'video', refId: 'v', durationSec: 1.75 }], SEEDANCE_25, 'reference-to-video'), []);
assert.match(referenceCombinationProblems([{ kind: 'video', refId: 'v', durationSec: 1.74 }], SEEDANCE_25, 'reference-to-video').join('；'), /下限/);
assert.match(referenceCombinationProblems([{ kind: 'video', refId: 'v', durationSec: 3 }], SEEDANCE_25, 'video-edit').join('；'), /4s/);
assert.deepEqual(referenceCombinationProblems([{ kind: 'video', refId: 'v', durationSec: 3 }], SEEDANCE_20, 'video-edit'), []);

const db = new Database(':memory:');
for (const migration of CREATIVE_CANVAS_MIGRATIONS) db.exec(migration.sql);
const canvas = createCanvas(db, { name: '4K quota' });
saveCanvasGraph({ db, canvasId: canvas.id, expectedGraphRevision: canvas.graphRevision, graph: { schemaVersion: 1, edges: [], nodes: ['a', 'b'].map((id) => ({ id, kind: 'video-generation' as const, position: { x: 0, y: 0 }, data: { title: id, modelKey: 'external-jimeng-seedance-2-0', generationMode: 'text-to-video' as const, prompt: 'test', parameters: { resolution: '4k' }, references: [], referenceLabelCounter: 0 } })) } });
for (const id of ['a', 'b']) startCanvasRun({ db, request: { canvasId: canvas.id, mode: 'single', targetNodeId: id, requestKey: id } });
const at = new Date();
const first = claimCanvasTasks({ db, workerId: 'one', limit: 10, now: () => at });
assert.equal(first.length, 1, '4K single concurrency');
assert.equal(claimCanvasTasks({ db, workerId: 'two', limit: 10, now: () => new Date(at.getTime() + 5000) }).length, 0, 'another worker cannot bypass occupied slot');
db.prepare("UPDATE creative_canvas_tasks SET phase = 'succeeded', submissionState = 'terminal', slotHeld = 0 WHERE id = ?").run(first[0].task.id);
assert.equal(claimCanvasTasks({ db, workerId: 'two', limit: 10, now: () => new Date(at.getTime() + 3999) }).length, 0, 'persistent spacing limits 15 starts/minute');
assert.equal(claimCanvasTasks({ db, workerId: 'two', limit: 10, now: () => new Date(at.getTime() + 4000) }).length, 1);
db.close();
console.log('creative-canvas-seedance.test.ts 通过');
