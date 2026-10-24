import assert from 'node:assert/strict';
import { mapFormulaAudio } from '../lib/live-mixcut/formula/audio-mapping.ts';
import { buildFormulaTimeline } from '../lib/live-mixcut/formula/timeline.ts';
import type { FormulaNarrationStageResult } from '../lib/live-mixcut/formula/narration-store.ts';

const mapped = await mapFormulaAudio({ mode: 'narration', bodyText: '坐得稳。',
  slots: [{ slotId: 'slot', assetId: 'asset', contentFingerprint: 'source-fingerprint', speechStageId: null, speech: null }] }, async () => null, new AbortController().signal);
assert.equal(mapped.status, 'mapped');
const narration: FormulaNarrationStageResult = { status: 'ready', executionReady: false, algorithmVersion: 'formula-narration-stage/1',
  items: [{ id: 'narration-1', slotIds: ['slot'], blockIds: ['text-1'], text: '坐得稳。', audio: { relativePath: 'fixture.wav', fingerprint: 'audio-fingerprint',
    durationUs: 1_000_000, words: [{ text: '坐得稳', startUs: 100_000, endUs: 900_000 }] } }] };
const input = {
  slots: [{ slotId: 'slot', logicalCode: 'G1', assetId: 'asset', contentFingerprint: 'source-fingerprint', sourceId: 'source',
    mediaDurationUs: 2_000_000, sourceFps: 50, ranges: [] }],
  mapping: { stageId: 'mapping', result: mapped }, narration: { stageId: 'tts', result: narration },
  target: { mode: 'reference' as const, scope: 'total' as const, durationUs: 2_000_000 }, speechMarginUs: 120_000,
};
const result = buildFormulaTimeline(input);
assert.equal(result.status, 'planned');
if (result.status !== 'planned') throw new Error('未生成实际时长安排');
assert.equal(result.duration.totalFrames, 48);
assert.equal(result.duration.bodyFrames, 28);
assert.equal(result.duration.clips[0].speed, 1, '50fps 输入不能偷偷变速');
assert.equal(result.duration.issues.some(issue => issue.code === 'range_unconfirmed'), true, '原片合法范围可以生成待审裁切，不能假称区间已确认');
assert.equal(result.audio[0].sourceInUs, 0);
assert.equal(result.audio[0].sourceOutUs, 1_000_000);
assert.equal(result.audio[0].timelineStartUs, 0);
assert.equal(result.audio[0].timelineEndUs, 1_000_000);
assert.deepEqual(result.words.map(({ text, startUs, endUs }) => ({ text, startUs, endUs })), [{ text: '坐得稳', startUs: 100_000, endUs: 900_000 }]);
assert.equal(result.executionReady, false);
const ranges = [
  { id: 'short', label: '短动作', inUs: 0, outUs: 700_000, protected: null },
  { id: 'long', label: '完整动作', inUs: 1_000_000, outUs: 3_000_000, protected: { inUs: 1_300_000, outUs: 1_700_000 } },
];
const alternate = buildFormulaTimeline({ ...input, slots: [{ ...input.slots[0], mediaDurationUs: 4_000_000, ranges }] });
assert.equal(alternate.status, 'planned', '第一个区间放不下配音时，应选择其他已批准区间');
if (alternate.status !== 'planned') throw new Error('没有尝试其他可用区间');
assert.equal(alternate.duration.clips[0].rangeId, 'long');
assert.equal(alternate.duration.clips[0].rangeConfirmed, true);
assert.ok(alternate.duration.clips[0].sourceInUs <= 1_300_000 && alternate.duration.clips[0].sourceOutUs >= 1_700_000);
const twoSlots = ['a', 'b'].map((slotId, index) => ({ ...input.slots[0], slotId, assetId: `asset-${index}`, sourceId: `source-${index}`,
  mediaDurationUs: 3_000_000, ranges: [
    { id: `${slotId}-long`, label: '完整长动作', inUs: 0, outUs: 2_000_000, protected: { inUs: 0, outUs: 2_000_000 } },
    { id: `${slotId}-short`, label: '短展示', inUs: 2_000_000, outUs: 2_500_000, protected: null },
  ] }));
const twoMapping = await mapFormulaAudio({ mode: 'narration', bodyText: '坐得稳。', slots: twoSlots.map(slot => ({ ...slot, speechStageId: null, speech: null })) }, async () => null, new AbortController().signal);
const twoInput = { ...input, slots: twoSlots, mapping: { stageId: 'two-mapping', result: twoMapping },
  narration: { stageId: 'two-tts', result: { ...narration, items: [{ ...narration.items[0], slotIds: ['a', 'b'] }] } },
  target: { mode: 'fixed' as const, scope: 'body' as const, durationUs: 2_500_000 } };
const combined = buildFormulaTimeline(twoInput);
assert.equal(combined.status, 'planned', '固定片长需要联合选择长短区间，不能每片只取首个或最长区间');
if (combined.status !== 'planned') throw new Error('合法区间组合没有找到');
assert.equal(combined.duration.bodyFrames, 60);
assert.deepEqual(combined.duration.clips.map(clip => clip.sourceOutUs - clip.sourceInUs).sort((a, b) => a - b), [500_000, 2_000_000]);
assert.equal(buildFormulaTimeline({ ...twoInput, narration: null }).status, 'waiting_audio');
const strict = buildFormulaTimeline({ ...twoInput, target: { mode: 'strict_max', scope: 'body', durationUs: 1_100_000 } });
assert.equal(strict.status, 'planned');
if (strict.status === 'planned') assert.equal(strict.duration.bodyFrames, 24, '严格上限不能为了更接近目标而选择超时组合');
assert.equal(buildFormulaTimeline({ ...twoInput, target: { mode: 'fixed', scope: 'body', durationUs: 2_000_000 } }).status, 'needs_attention', '不可达的固定时长不能靠截断保护动作凑足');

const sourceSlots = [{ ...input.slots[0], slotId: 'source-slot', assetId: 'actor', sourceId: 'actor-file', mediaDurationUs: 10_000_000 },
  { ...input.slots[0], slotId: 'voice-slot' }];
const mixed = await mapFormulaAudio({ mode: 'mixed', bodyText: '好擦洗。坐得稳。', slots: sourceSlots.map((slot, i) => ({ ...slot,
  speechStageId: `speech-${i}`, speech: i === 0 ? { status: 'transcribed' as const, algorithmVersion: 'formula-source-speech/1' as const,
    executionReady: false as const, assetId: slot.assetId, contentFingerprint: slot.contentFingerprint, sourceId: slot.sourceId, mediaDurationUs: slot.mediaDurationUs,
    text: '好擦洗。', words: [{ text: '好擦洗', startUs: 5_000_000, endUs: 7_000_000 }], reviewStatus: 'pending' as const, audioStreamIndex: 0 as const,
    transcriptionIdentity: { adapterVersion: 'openai-word-transcription/1' as const, model: 'fixture', endpointHash: 'fixture' } }
    : { status: 'no_audio_stream' as const, algorithmVersion: 'formula-source-speech/1' as const, executionReady: false as const,
      assetId: slot.assetId, contentFingerprint: slot.contentFingerprint, sourceId: slot.sourceId, mediaDurationUs: slot.mediaDurationUs } })) },
async () => ({ id: 'fixture', name: 'fixture', model: 'fixture', complete: async () => ({ blocks: [
  { kind: 'source', slotId: 'source-slot', text: '好擦洗。' }, { kind: 'tts', slotIds: ['voice-slot'], text: '坐得稳。' },
] }) }), new AbortController().signal);
assert.equal(mixed.status, 'mapped');
if (mixed.status !== 'mapped') throw new Error('混合文案未分配');
const mixedInput = { ...input, slots: sourceSlots, mapping: { stageId: 'mixed-mapping', result: mixed },
  narration: { stageId: 'mixed-tts', result: { ...narration, items: [{ ...narration.items[0], blockIds: ['text-2'], slotIds: ['voice-slot'] }] } },
  target: { mode: 'reference' as const, scope: 'total' as const, durationUs: 5_000_000 } };
const mixedTimeline = buildFormulaTimeline(mixedInput);
assert.equal(mixedTimeline.status, 'planned');
if (mixedTimeline.status !== 'planned') throw new Error('混合声音没有排入画面');
assert.equal(mixedTimeline.duration.totalFrames, 120);
assert.equal(mixedTimeline.audio[0].sourceInUs, 4_875_000);
assert.equal(mixedTimeline.audio[0].sourceOutUs, 7_125_000);
assert.equal(mixedTimeline.audio[0].timelineStartUs, 0);
assert.equal(mixedTimeline.audio[0].linkGroupId, 'source-slot');
assert.equal(mixedTimeline.audio[1].timelineStartUs, 2_250_000);
assert.deepEqual(mixedTimeline.words.map(word => [word.text, word.startUs, word.endUs]), [
  ['好擦洗', 125_000, 2_125_000], ['坐得稳', 2_350_000, 3_150_000],
]);
const tooShort = buildFormulaTimeline({ ...mixedInput, target: { mode: 'strict_max', scope: 'total', durationUs: 3_000_000 } });
assert.equal(tooShort.status, 'needs_attention');
if (tooShort.status === 'needs_attention') assert.equal(tooShort.conflicts[0].code, 'target_too_short');
assert.throws(() => buildFormulaTimeline({ ...input, target: { ...input.target, durationUs: 1.5 } }),
  error => error instanceof Error && 'code' in error && error.code === 'invalid_input', '坏时长输入应返回业务错误');
const screenMapping = await mapFormulaAudio({ mode: 'narration', bodyText: '坐得稳。加宽坐面',
  slots: [{ slotId: 'slot', assetId: 'asset', contentFingerprint: 'source-fingerprint', speechStageId: null, speech: null }],
  manual: { confirmed: true, blocks: [{ kind: 'tts', text: '坐得稳。', slotIds: ['slot'] },
    { kind: 'on_screen', text: '加宽坐面', displayText: '加宽坐面', slotId: 'slot' }] } }, async () => null, new AbortController().signal);
const screenTimeline = buildFormulaTimeline({ ...input, mapping: { stageId: 'screen-mapping', result: screenMapping } });
assert.equal(screenTimeline.status, 'planned');
if (screenTimeline.status !== 'planned') throw new Error('花字未排入实际时间线');
assert.deepEqual(screenTimeline.onScreen, [{ blockId: 'text-2', slotId: 'slot', text: '加宽坐面', displayText: '加宽坐面',
  startUs: 0, endUs: 1_166_667 }], '花字使用实际画面时段，不作为声音字幕');
assert.deepEqual(screenTimeline.words.map(word => word.text), ['坐得稳']);
for (const texts of [['加宽坐面', '舒适靠背'], ['加宽坐面', '舒适靠背', '易于清洁']]) {
  const many = await mapFormulaAudio({ mode: 'narration', bodyText: '坐得稳。' + texts.join(''),
    slots: [{ slotId: 'slot', assetId: 'asset', contentFingerprint: 'source-fingerprint', speechStageId: null, speech: null }],
    manual: { confirmed: true, blocks: [{ kind: 'tts', text: '坐得稳。', slotIds: ['slot'] },
      ...texts.map(text => ({ kind: 'on_screen', text, displayText: text, slotId: 'slot' }))] } }, async () => null, new AbortController().signal);
  const result = buildFormulaTimeline({ ...input, mapping: { stageId: 'many-screens', result: many } });
  if (texts.length === 2) {
    assert.equal(result.status, 'planned');
    if (result.status !== 'planned') throw new Error('两条花字不能丢失');
    assert.deepEqual(result.onScreen?.map(cue => [cue.displayText, cue.startUs, cue.endUs]),
      [['加宽坐面', 0, 583_333], ['舒适靠背', 583_333, 1_166_667]], '同一镜头两条花字按原文顺序分时显示，不叠在一起');
  } else {
    assert.equal(result.status, 'needs_attention', '真实镜头过短时不能删花字或强行闪过');
    if (result.status === 'needs_attention') assert.equal(result.conflicts[0].code, 'on_screen_too_short');
  }
}
console.log('formula timeline tests passed');
