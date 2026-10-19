import assert from 'node:assert/strict';
import { matchAudioFirst, type AudioFirstSentence } from '../lib/final-edit/audio-first-matcher.ts';
import { audioFirstPlanToVideoTimeline } from '../lib/final-edit/audio-first-timeline.ts';
import { buildTtsAwareMatchSentences } from '../lib/final-edit/match-sentence-refinement.ts';
import { buildMixcutTaskScriptSnapshot } from '../lib/final-edit/mixcut-script.ts';

const sourceNarrations = [
  '忙碌一天回到家，只想陷进这26斤满铺鹅毛的怀抱，感受5芯软弹带来的极致解压。',
  '112度的人体工学靠背，精准承托疲惫的腰背，久坐不累，让阅读时光也变得格外轻盈。',
  '触手可及的是婴幼级半青皮，A类认证的细腻质感，给全家一份可以贴脸呼吸的安心。',
];
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

// 2026-07-27 豆包 Vivi 2.0 对真实文案返回的句段边界。两个 5.06 秒
// 句段只比素材长 10ms，旧兜底会把它们切成 4.86s + 0.2s 闪切。
const realSegmentTimings = [
  [0, 5_060_000],
  [5_060_000, 8_320_000],
  [8_320_000, 13_380_000],
  [13_380_000, 17_240_000],
  [17_240_000, 22_090_000],
  [22_090_000, 25_160_000],
] as const;
const realWordTimings = [
  { text: '忙碌一天回到家，', startUs: 0, endUs: 1_565_000 },
  { text: '只想陷进这26斤满铺鹅毛的怀抱，', startUs: 1_565_000, endUs: 4_675_000 },
  { text: '感受5芯软弹带来的极致解压。', startUs: 5_060_000, endUs: 8_085_000 },
  { text: '112度的人体工学靠背，', startUs: 8_320_000, endUs: 11_155_000 },
  { text: '精准承托疲惫的腰背，', startUs: 11_155_000, endUs: 13_105_000 },
  { text: '久坐不累，', startUs: 13_380_000, endUs: 14_435_000 },
  { text: '让阅读时光也变得格外轻盈。', startUs: 14_435_000, endUs: 16_925_000 },
  { text: '触手可及的是婴幼级半青皮，', startUs: 17_240_000, endUs: 19_925_000 },
  { text: 'A类认证的细腻质感，', startUs: 19_925_000, endUs: 21_835_000 },
  { text: '给全家一份可以贴脸呼吸的安心。', startUs: 22_090_000, endUs: 24_815_000 },
];
const refined = buildTtsAwareMatchSentences({
  segments: snapshot.segments.map((segment, index) => ({
    id: segment.id,
    shotId: segment.shotId,
    text: segment.narration,
    startUs: realSegmentTimings[index][0],
    endUs: realSegmentTimings[index][1],
  })),
  wordTimings: realWordTimings,
  maxSceneDurationUs: 5_050_000,
  availableSceneCount: 7,
});
const sentences: AudioFirstSentence[] = refined.map((sentence) => ({ ...sentence, keywords: [] }));
const cursorUs = realSegmentTimings.at(-1)![1];
const sourceSegmentIds = new Set(snapshot.segments.map((segment) => segment.id));
assert.equal(sentences.length, 7, '真实豆包时长必须重分配为 7 个自然视觉句段');
assert.ok(sentences.every((sentence) => sentence.endUs - sentence.startUs <= 5_050_000), '每段真实 TTS 时长必须能放进 5.05 秒素材');
assert.ok(sentences.every((sentence) => sentence.endUs - sentence.startUs >= 1_200_000), '不得产生短于 1.2 秒的机关枪式片段');
assert.ok(refined.every((sentence) => sourceSegmentIds.has(sentence.sourceSegmentId)), '每个匹配句段必须保留可绑定到字幕的原句段 ID');
assert.equal(sentences[0].startUs, 0);
assert.equal(sentences.at(-1)?.endUs, cursorUs);
for (let index = 1; index < sentences.length; index += 1) assert.equal(sentences[index - 1].endUs, sentences[index].startUs, 'TTS 感知重分段必须无缝覆盖口播主轴');

const alreadyFeasible = [
  { id: 'existing-1', shotId: 'shot-1', text: '第一个句段。', startUs: 0, endUs: 2_000_000 },
  { id: 'existing-2', shotId: 'shot-2', text: '第二个句段。', startUs: 2_000_000, endUs: 4_000_000 },
];
assert.deepEqual(buildTtsAwareMatchSentences({
  segments: alreadyFeasible,
  wordTimings: [],
  maxSceneDurationUs: 5_050_000,
  availableSceneCount: 7,
}), alreadyFeasible.map((segment) => ({ ...segment, sourceSegmentId: segment.id })), '原句段均能装入素材时必须保留原 ID、文字与边界');

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
  boundSegmentIdBySentenceId: new Map(refined.map((sentence) => [sentence.id, sentence.sourceSegmentId])),
});
assert.deepEqual(converted.issues, []);
const clips = [...converted.timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
assert.ok(clips.every((clip) => clip.boundSegmentId && sourceSegmentIds.has(clip.boundSegmentId)), '持久化 clip 绑定必须回到现有字幕 segment ID');
assert.equal(clips[0]?.timelineInFrame, 0);
assert.equal(clips.at(-1)?.timelineOutFrame, converted.timeline.bodyFrames);
for (let index = 1; index < clips.length; index += 1) assert.equal(clips[index - 1].timelineOutFrame, clips[index].timelineInFrame);

const missingSource = audioFirstPlanToVideoTimeline({
  plan: { segments: [result.plan.segments[0]] },
  assetsByKey: new Map(),
  narrationDurationUs: cursorUs,
  boundSegmentIdBySentenceId: new Map(refined.map((sentence) => [sentence.id, sentence.sourceSegmentId])),
});
assert.equal(missingSource.issues[0]?.targetId, refined[0].sourceSegmentId, '转换失败的 issue 也必须指向现有字幕 segment ID');
assert.doesNotMatch(missingSource.issues[0]?.message || '', /-match-/, '用户可见错误不得泄露匹配专用 ID');

console.log('final-edit short material matching tests passed');
