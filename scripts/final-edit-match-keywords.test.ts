import assert from 'node:assert/strict';
import { matchAudioFirst } from '../lib/final-edit/audio-first-matcher.ts';
import { extractMatchKeywords } from '../lib/final-edit/match-keywords.ts';

const narration = '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。';
const keywords = extractMatchKeywords(narration);

assert.ok(keywords.length >= 6 && keywords.length <= 24, '真实文案应提取覆盖各个语义子句的有限关键词');
assert.ok(keywords.some((keyword) => keyword.includes('满铺鹅毛')));
assert.ok(keywords.some((keyword) => keyword.includes('人体工学靠背')));
assert.ok(keywords.some((keyword) => keyword.includes('阅读时光')));
assert.ok(keywords.some((keyword) => keyword.includes('婴幼级半青皮')));
assert.ok(keywords.some((keyword) => keyword.includes('a类认证')));
assert.equal(keywords.includes('碌一'), false, '关键词不得再由无语义的滑窗 bigram 填满');
assert.deepEqual(extractMatchKeywords(narration), keywords, '关键词提取必须确定');

const realFallbackSentences = [
  { id: 'soft', text: '只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹。', startUs: 0, endUs: 2_000_000 },
  { id: 'back', text: '112度的人体工学靠背，精准承托疲惫的腰背。', startUs: 2_000_000, endUs: 4_000_000 },
  { id: 'skin', text: '婴幼级半青皮，A类认证的细腻质感。', startUs: 4_000_000, endUs: 6_000_000 },
].map((sentence) => ({ ...sentence, keywords: extractMatchKeywords(sentence.text) }));
const realFallbackAssets = [
  { assetKey: 'leather', labels: ['女性', '婴幼级半青皮', 'A类认证', '皮质特写'] },
  { assetKey: 'soft-sofa', labels: ['女性', '黑色皮沙发', '满铺鹅毛', '5芯软弹', '现代客厅'] },
  { assetKey: 'ergonomic', labels: ['女性', '黑色皮沙发', '人体工学靠背', '阅读', '腰背承托'] },
].map((asset) => ({
  assetKey: asset.assetKey,
  durationUs: 5_050_000,
  scenes: [{ startUs: 0, endUs: 5_050_000, labels: asset.labels, quality: 0.95 }],
  source: 'module4' as const,
}));
const fallbackResult = matchAudioFirst({
  sentences: realFallbackSentences,
  assets: realFallbackAssets,
  semanticScores: realFallbackSentences.map(() => realFallbackAssets.map(() => 0.6)),
  hookScores: realFallbackAssets.map(() => 0),
  beatPoints: [],
  manualLocks: [],
  maxReuse: 1,
  semanticFallback: true,
});
assert.deepEqual(
  fallbackResult.plan.segments.map((segment) => [segment.sentenceId, segment.assetKey]),
  [['soft', 'soft-sofa'], ['back', 'ergonomic'], ['skin', 'leather']],
  '真实句段与真实素材标签在语义服务失败时必须产生非零、可区分的关键词匹配',
);
assert.ok(fallbackResult.diagnostics.selectionReasons.every((reason) => reason.reason === 'keyword_fallback'));

console.log('final-edit match keyword tests passed');
