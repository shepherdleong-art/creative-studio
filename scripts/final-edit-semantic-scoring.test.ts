import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'final-edit-semantic-scoring-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const { resolveFinalEditSemanticScores } = await import('../lib/final-edit/semantic-scoring.ts');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE script_providers (id TEXT PRIMARY KEY, model TEXT, defaultModel TEXT);
  CREATE TABLE final_edit_semantic_matrix_cache (
    cacheKey TEXT PRIMARY KEY,
    scriptHash TEXT NOT NULL,
    scenesFingerprint TEXT NOT NULL,
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    promptVersion TEXT NOT NULL,
    semanticScoresJson TEXT NOT NULL,
    hookScoresJson TEXT NOT NULL,
    semanticFallback INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`);

const sentences = [{ id: 's1', text: '安静睡眠', keywords: ['安静'] }];
const scenes = [
  { assetKey: 'a', assetFingerprint: 'fp-a', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['卧室'], description: '夜间卧室', quality: 0.9 },
  { assetKey: 'b', assetFingerprint: 'fp-b', sceneIndex: 0, startUs: 0, endUs: 1_000_000, labels: ['产品'], description: '产品特写', quality: 0.8 },
];
const validScore = { score_matrix: [[0.91, 0.12]], hook_scores: [0.8, 0.2] };
const expected = { semanticScores: [[0.91, 0.12]], hookScores: [0.8, 0.2], semanticFallback: false };
const cacheCount = (providerId: string) => (db.prepare(
  'SELECT COUNT(*) AS n FROM final_edit_semantic_matrix_cache WHERE providerId = ?',
).get(providerId) as { n: number }).n;

try {
  db.prepare('INSERT INTO script_providers (id, model, defaultModel) VALUES (?, ?, ?)').run('provider-a', 'model-a', 'fallback-a');
  let scoreCalls = 0;
  const score = async () => {
    scoreCalls += 1;
    return validScore;
  };
  const first = await resolveFinalEditSemanticScores({ db, sentences, scenes, providerId: 'provider-a', score });
  assert.deepEqual(first, expected);
  assert.equal(scoreCalls, 1);
  assert.equal(cacheCount('provider-a'), 1, '成功矩阵必须写入缓存');

  const cached = await resolveFinalEditSemanticScores({
    db, sentences, scenes, providerId: 'provider-a',
    score: async () => { throw new Error('缓存命中时不应再次调用模型'); },
  });
  assert.deepEqual(cached, expected, '缓存命中必须直接复用成功矩阵');
  assert.equal(scoreCalls, 1);

  db.prepare("UPDATE script_providers SET model = 'model-b' WHERE id = 'provider-a'").run();
  await resolveFinalEditSemanticScores({ db, sentences, scenes, providerId: 'provider-a', score });
  assert.equal(scoreCalls, 2, '模型身份变化必须使旧缓存失效');
  assert.equal(cacheCount('provider-a'), 2);

  db.prepare("UPDATE script_providers SET model = 'model-a' WHERE id = 'provider-a'").run();
  db.prepare("UPDATE final_edit_semantic_matrix_cache SET semanticScoresJson = 'broken', hookScoresJson = 'broken' WHERE providerId = 'provider-a' AND model = 'model-a'").run();
  const repaired = await resolveFinalEditSemanticScores({ db, sentences, scenes, providerId: 'provider-a', score });
  assert.deepEqual(repaired, expected, '损坏缓存必须重新评分并修复，不能当作成功结果');
  assert.equal(scoreCalls, 3);

  db.prepare('INSERT INTO script_providers (id, model, defaultModel) VALUES (?, ?, ?)').run('provider-b', 'model-b', '');
  let failureCalls = 0;
  const failed = await resolveFinalEditSemanticScores({
    db, sentences, scenes, providerId: 'provider-b',
    score: async () => {
      failureCalls += 1;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    },
  });
  assert.equal(failed.semanticFallback, true);
  assert.equal(failureCalls, 1, '不可重试错误不应重复调用');
  assert.equal(cacheCount('provider-b'), 0, '降级结果不得写成成功缓存');

  const recovered = await resolveFinalEditSemanticScores({
    db, sentences, scenes, providerId: 'provider-b',
    score: async () => {
      failureCalls += 1;
      return validScore;
    },
  });
  assert.deepEqual(recovered, expected, '下一次成功评分必须能从上一次失败中恢复');
  assert.equal(failureCalls, 2);
  assert.equal(cacheCount('provider-b'), 1);
  console.log('final-edit semantic scoring tests passed');
} finally {
  db.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
}
