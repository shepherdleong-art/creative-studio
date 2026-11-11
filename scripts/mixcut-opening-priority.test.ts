import assert from 'node:assert/strict';
import { matchAudioFirst } from '../lib/final-edit/audio-first-matcher.ts';
import { allocateBatch, type FrozenBatchInput } from '../lib/batch-production/allocator.ts';

const assets = ['opening', 'body'].map((role) => ({
  assetKey: role, role: role as 'opening' | 'body', source: 'module4' as const,
  durationUs: 8_000_000,
  scenes: [{ startUs: 0, endUs: 8_000_000, labels: ['餐桌'], quality: 1 }],
}));
const sentence = { id: 'intro', text: '餐桌', keywords: ['餐桌'], startUs: 0, endUs: 3_000_000 };
const input = { sentences: [sentence], assets, semanticScores: [[0, 1]], hookScores: [0, 1], beatPoints: [], manualLocks: [], maxReuse: 2, semanticFallback: false };
const single = matchAudioFirst(input);
assert.equal(single.plan.segments[0].assetKey, 'opening', '单条：正文语义得分更高也不能抢走专用开场');
assert.equal(single.plan.segments[0].sourceStartUs, 0);
const short = matchAudioFirst({ ...input, assets: [{ ...assets[0], durationUs: 1_000_000, scenes: [{ ...assets[0].scenes[0], endUs: 1_000_000 }] }, assets[1]] });
assert.equal(short.plan.segments[0].assetKey, 'opening', '短开场必须先用，再由正文补齐口播');
assert.equal(short.plan.segments.at(-1)?.endUs, sentence.endUs);
assert.equal(short.diagnostics.gaps.length, 0);
const locked = matchAudioFirst({ ...input, manualLocks: [{ sentenceId: 'intro', assetKey: 'body', startUs: 0, endUs: 3_000_000 }] });
assert.equal(locked.plan.segments[0].assetKey, 'body', '显式锁定仍优先');
assert.equal(matchAudioFirst({ ...input, assets: [assets[1]], semanticScores: [[1]] }).plan.segments[0].assetKey, 'body', '无可用开场沿用正文流程');

const batchInput: FrozenBatchInput = {
  batchVersionId: 'opening-regression', seed: 'opening-regression',
  assets: assets.map((asset) => ({
    assetId: asset.assetKey, role: asset.role, durationUs: asset.durationUs,
    contentFingerprint: asset.assetKey, sourceGroupKey: asset.assetKey,
    analysisJson: { scenes: [{ startUs: 0, endUs: asset.durationUs, qualityScore: 1, labels: asset.role === 'body' ? ['餐桌'] : [] }] },
  })),
  plans: Array.from({ length: 4 }, (_, index) => ({ planId: `p${index}`, segments: [{ ...sentence, text: '餐桌', endUs: 3_000_000 }], coverAssetIds: [], musicTrackIds: [] })),
};
const batch = allocateBatch(batchInput);
for (const plan of batch.plans) assert.equal(plan.arrangement.clips[0]?.assetId, 'opening', '批量：开场可跨成片复用，不能因正文更匹配或未使用就跳过开场');
const batchShort = allocateBatch({ ...batchInput, assets: [
  { ...batchInput.assets![0], durationUs: 1_000_000, analysisJson: { scenes: [{ startUs: 0, endUs: 1_000_000, qualityScore: 1 }] } },
  batchInput.assets![1],
] });
for (const plan of batchShort.plans) {
  assert.equal(plan.arrangement.clips[0]?.assetId, 'opening', '批量短开场先用，跨成片复用也不能被正文抢走');
  assert.equal(plan.arrangement.clips.at(-1)?.timelineEndUs, 3_000_000);
}
console.log('mixcut opening priority tests passed');
