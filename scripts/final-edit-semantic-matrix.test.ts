import assert from 'node:assert/strict';
import {
  buildSemanticMatrixPrompt,
  createSemanticMatrixCacheKey,
  normalizeSemanticMatrix,
  scoreSemanticMatrixWithRetry,
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

const prompt = buildSemanticMatrixPrompt(input);
assert.match(prompt.userPrompt, /安静睡眠/);
assert.match(prompt.userPrompt, /夜间卧室/);
assert.doesNotMatch(prompt.userPrompt, /assetFingerprint|fp-a|startUs|endUs|quality|assetKey/, '语义 prompt 不得混入指纹、时间戳、质量分和内部 ID');

let retryCalls = 0;
const retryEvents: Array<{ attempt: number; delayMs: number }> = [];
const retried = await scoreSemanticMatrixWithRetry({
  sentenceCount: 1,
  sceneCount: 2,
  score: async () => {
    retryCalls += 1;
    if (retryCalls === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
    if (retryCalls === 2) return { score_matrix: [], hook_scores: [] };
    return { score_matrix: [[0.8, 0.2]], hook_scores: [0.7, 0.1] };
  },
  sleep: async () => undefined,
  onRetry: (event) => retryEvents.push({ attempt: event.attempt, delayMs: event.delayMs }),
});
assert.equal(retryCalls, 3, '可重试状态和无效矩阵都必须指数退避后重试');
assert.deepEqual(retryEvents, [{ attempt: 1, delayMs: 500 }, { attempt: 2, delayMs: 1_000 }]);
assert.equal(retried.semanticFallback, false);

let unauthorizedCalls = 0;
const unauthorized = await scoreSemanticMatrixWithRetry({
  sentenceCount: 1,
  sceneCount: 2,
  score: async () => {
    unauthorizedCalls += 1;
    throw Object.assign(new Error('unauthorized'), { status: 401 });
  },
  sleep: async () => undefined,
});
assert.equal(unauthorizedCalls, 1, '401 等不可重试错误不得重复请求');
assert.equal(unauthorized.semanticFallback, true);

console.log('final-edit semantic matrix tests passed');
