import assert from 'node:assert/strict';
import { matchAudioFirst, type AudioFirstSentence } from '../lib/final-edit/audio-first-matcher.ts';
import { audioFirstPlanToVideoTimeline } from '../lib/final-edit/audio-first-timeline.ts';
import { buildMixcutTaskScriptSnapshot } from '../lib/final-edit/mixcut-script.ts';

const sourceNarrations = [
  '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。',
  '112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。',
  '触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。',
];
const sourceDurationsUs = [7_410_000, 7_490_000, 7_420_000];
const snapshot = buildMixcutTaskScriptSnapshot({
  sourceDraftId: 'real-draft',
  sourceScript: {
    version: 2,
    title: '真实短素材回归',
    shotSetId: 'real-set',
    fullScript: sourceNarrations.join(''),
    segments: sourceNarrations.map((narration, index) => ({ id: `source-${index + 1}`, shotId: `shot-${index + 1}`, narration })),
  },
  shotSetId: 'real-set',
  editedNarrationText: sourceNarrations.join('\n'),
});
assert.equal(snapshot.segments.length, 6);

const sentences: AudioFirstSentence[] = [];
let cursorUs = 0;
for (let sourceIndex = 0; sourceIndex < sourceNarrations.length; sourceIndex += 1) {
  const parts = snapshot.segments.filter((segment) => segment.shotId === `shot-${sourceIndex + 1}`);
  const totalChars = parts.reduce((sum, segment) => sum + Array.from(segment.narration.replace(/[\p{P}\p{S}\s]/gu, '')).length, 0);
  let sourceCursorUs = cursorUs;
  parts.forEach((segment, partIndex) => {
    const contentChars = Array.from(segment.narration.replace(/[\p{P}\p{S}\s]/gu, '')).length;
    const endUs = partIndex === parts.length - 1
      ? cursorUs + sourceDurationsUs[sourceIndex]
      : sourceCursorUs + Math.round(sourceDurationsUs[sourceIndex] * contentChars / totalChars);
    sentences.push({ id: segment.id, shotId: segment.shotId, text: segment.narration, startUs: sourceCursorUs, endUs, keywords: [] });
    sourceCursorUs = endUs;
  });
  cursorUs += sourceDurationsUs[sourceIndex];
}
assert.ok(sentences.every((sentence) => sentence.endUs - sentence.startUs <= 5_050_000), '细分后每段真实时长估算必须能放进 5.05 秒素材');
assert.ok(sentences.every((sentence) => sentence.endUs - sentence.startUs >= 1_200_000), '不得产生短于 1.2 秒的机关枪式片段');

const assets = Array.from({ length: 7 }, (_, index) => ({
  assetKey: `asset-${index + 1}`,
  shotId: index < 3 ? `shot-${index + 1}` : undefined,
  durationUs: 5_050_000,
  scenes: [{ startUs: 0, endUs: 5_050_000, labels: [`场景-${index + 1}`], quality: 0.95 }],
  source: 'module4' as const,
}));
const semanticScores = sentences.map((_, sentenceIndex) => assets.map((__, assetIndex) => assetIndex === sentenceIndex ? 0.95 : 0.5));
const result = matchAudioFirst({
  sentences,
  assets,
  semanticScores,
  hookScores: assets.map(() => 0),
  beatPoints: [],
  manualLocks: [],
  maxReuse: 2,
  semanticFallback: false,
});
assert.equal(result.diagnostics.feasible, true);
assert.deepEqual(result.diagnostics.gaps, []);
assert.ok(result.diagnostics.usedMaterials.length >= 5);

const converted = audioFirstPlanToVideoTimeline({
  plan: result.plan,
  assetsByKey: new Map(assets.map((asset, index) => [asset.assetKey, { videoJobId: `video-${index + 1}`, fingerprint: `fp-${index + 1}`, durationUs: asset.durationUs }])),
  narrationDurationUs: cursorUs,
});
assert.deepEqual(converted.issues, []);
const clips = [...converted.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
assert.equal(clips[0]?.timelineInFrame, 0);
assert.equal(clips.at(-1)?.timelineOutFrame, converted.timeline.bodyFrames);
for (let index = 1; index < clips.length; index += 1) assert.equal(clips[index - 1].timelineOutFrame, clips[index].timelineInFrame);

console.log('final-edit short material matching tests passed');
