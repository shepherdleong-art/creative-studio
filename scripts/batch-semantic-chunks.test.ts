import assert from 'node:assert/strict';
import { scoreBatchSemanticMatrix, type BatchSemanticSentence, type BatchSemanticScene } from '../lib/batch-production/semantic-match.ts';

const sentences: BatchSemanticSentence[] = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, text: `句段${i}`, keywords: [] }));
const scenes: BatchSemanticScene[] = Array.from({ length: 247 }, (_, i) => ({
  assetKey: `asset-${Math.floor(i / 3)}`, assetFingerprint: `fp-${Math.floor(i / 3)}`, sceneIndex: i % 3,
  startUs: 0, endUs: 1_000_000, description: `场景${i}`, labels: [], quality: 0.8,
}));
type Chunk = { sentences: readonly BatchSemanticSentence[]; scenes: readonly BatchSemanticScene[] };
const value = (sentence: BatchSemanticSentence, scene: BatchSemanticScene) =>
  (sentences.indexOf(sentence) * scenes.length + scenes.indexOf(scene)) / 2000;
const calls: Chunk[] = [];
const result = await scoreBatchSemanticMatrix({
  sentences, scenes, providerId: 'fixture', sleep: async () => undefined,
  score: async (chunk: Chunk = { sentences, scenes }) => {
    calls.push(chunk);
    // Replay the observed provider failure for an oversized request.
    if (chunk.sentences.length > 4 || chunk.scenes.length > 32) throw new Error('模型返回空响应');
    return {
      score_matrix: chunk.sentences.map(sentence => chunk.scenes.map(scene => value(sentence, scene))),
      hook_scores: chunk.scenes.map(scene => scenes.indexOf(scene) / 300),
    };
  },
});
assert.equal(result.fallback, false, '247 场景不能反复重发完整大矩阵后降级');
assert.equal(calls.length, 16);
if (!result.fallback) {
  assert.equal(Object.keys(result.hooks).length, 247);
  for (const sentence of sentences) {
    assert.equal(Object.keys(result.scores[sentence.id]).length, 247);
    for (const scene of scenes) {
      const key = `${scene.assetKey}:${scene.sceneIndex}`;
      assert.equal(result.scores[sentence.id][key], value(sentence, scene), '跨分块后句段和场景不能错位');
      assert.equal(result.hooks[key], scenes.indexOf(scene) / 300);
    }
  }
}

let attempts = 0;
const failed = await scoreBatchSemanticMatrix({
  sentences, scenes, providerId: 'fixture', sleep: async () => undefined,
  score: async (chunk: Chunk) => {
    attempts++;
    if (attempts > 1) throw new Error('模型返回空响应');
    return { score_matrix: chunk.sentences.map(() => chunk.scenes.map(() => 0.8)), hook_scores: chunk.scenes.map(() => 0.4) };
  },
});
assert.equal(attempts, 5, '成功分块不重试，失败分块最多请求四次');
assert.equal(failed.fallback, true, '失败时不得发布部分矩阵');
assert.equal('scores' in failed, false);

const controller = new AbortController();
let abortCalls = 0;
await assert.rejects(scoreBatchSemanticMatrix({
  sentences, scenes, providerId: 'fixture', signal: controller.signal,
  score: async (chunk: Chunk) => {
    abortCalls++;
    controller.abort();
    return { score_matrix: chunk.sentences.map(() => chunk.scenes.map(() => 0.8)), hook_scores: chunk.scenes.map(() => 0.4) };
  },
}), { name: 'AbortError' });
assert.equal(abortCalls, 1, '停止后不得继续付费评分');
console.log('PASS: semantic chunk coverage, identity, bounded retries and cancellation');
