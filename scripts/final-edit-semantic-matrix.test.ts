import assert from 'node:assert/strict';
import {
  createSemanticMatrixCacheKey,
  normalizeSemanticMatrix,
} from '../lib/final-edit/semantic-matrix.ts';

const input = {
  sentences: [{ id: 's1', text: '安静睡眠', keywords: ['安静'] }],
  scenes: [
    { assetKey: 'a', assetFingerprint: 'fp-a', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['卧室'], description: '夜间卧室', quality: 0.9 },
    { assetKey: 'b', assetFingerprint: 'fp-b', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['产品'], description: '产品特写', quality: 0.8 },
  ],
  providerId: 'provider-a',
  model: 'model-a',
  promptVersion: '1',
};

assert.equal(createSemanticMatrixCacheKey(input), createSemanticMatrixCacheKey(structuredClone(input)), '相同输入必须生成相同缓存键');
assert.notEqual(createSemanticMatrixCacheKey(input), createSemanticMatrixCacheKey({ ...input, model: 'model-b' }), '模型变化必须失效缓存');
assert.notEqual(createSemanticMatrixCacheKey(input), createSemanticMatrixCacheKey({ ...input, scenes: [...input.scenes].reverse() }), '场景顺序变化必须失效缓存');
assert.notEqual(createSemanticMatrixCacheKey(input), createSemanticMatrixCacheKey({
  ...input,
  scenes: input.scenes.map((scene, index) => index === 0 ? { ...scene, assetFingerprint: 'fp-a-replaced' } : scene),
}), '素材文件变化必须失效缓存，即使场景描述未变化');
assert.notEqual(createSemanticMatrixCacheKey(input), createSemanticMatrixCacheKey({
  ...input,
  scenes: input.scenes.map((scene, index) => index === 0 ? { ...scene, endUs: 1_500_000 } : scene),
}), '场景边界变化必须失效缓存');

assert.deepEqual(normalizeSemanticMatrix({ score_matrix: [[0.9, 2]], hook_scores: [-1, 0.7] }, 1, 2), {
  semanticScores: [[0.9, 1]], hookScores: [0, 0.7], semanticFallback: false,
});
assert.deepEqual(normalizeSemanticMatrix({ score_matrix: [[0.9]], hook_scores: [0.4] }, 1, 2), {
  semanticScores: [[0.6, 0.6]], hookScores: [0, 0], semanticFallback: true,
});

console.log('final-edit semantic matrix tests passed');
