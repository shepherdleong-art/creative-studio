import assert from 'node:assert/strict';
import { mapFormulaAudio } from '../lib/live-mixcut/formula/audio-mapping.ts';
import { buildFormulaTimeline, type FormulaTimelineResult } from '../lib/live-mixcut/formula/timeline.ts';
import type { FormulaNarrationStageResult } from '../lib/live-mixcut/formula/narration-store.ts';

const mapped = await mapFormulaAudio({ mode: 'narration', bodyText: '坐得稳。',
  slots: [{ slotId: 'slot', assetId: 'asset', contentFingerprint: 'source-fingerprint', speechStageId: null, speech: null }] }, async () => null, new AbortController().signal);
assert.equal(mapped.status, 'mapped');
const narration: FormulaNarrationStageResult = { status: 'ready', executionReady: false, algorithmVersion: 'formula-narration-stage/1',
  items: [{ id: 'narration-1', slotIds: ['slot'], blockIds: ['text-1'], text: '坐得稳。', audio: { relativePath: 'fixture.wav', fingerprint: 'audio-fingerprint',
    durationUs: 1_000_000, words: [{ text: '坐得稳', startUs: 100_000, endUs: 900_000 }] } }] };
const baseInput = {
  slots: [{ slotId: 'slot', logicalCode: 'G1', assetId: 'asset', contentFingerprint: 'source-fingerprint', sourceId: 'source',
    mediaDurationUs: 2_000_000, sourceFps: 50, ranges: [] }],
  mapping: { stageId: 'mapping', result: mapped }, narration: { stageId: 'tts', result: narration },
  target: { mode: 'fixed' as const, scope: 'body' as const, durationUs: 2_000_000 }, speechMarginUs: 120_000,
};

function planned(result: FormulaTimelineResult) {
  assert.equal(result.status, 'planned');
  if (result.status !== 'planned') throw new Error('应生成排片');
  return result;
}
function broll(mediaDurationUs: number) {
  return planned(buildFormulaTimeline({ ...baseInput, slots: [{ ...baseInput.slots[0], mediaDurationUs }] }));
}

const tenSeconds = broll(10_000_000);
assert.deepEqual([tenSeconds.duration.clips[0].sourceInUs, tenSeconds.duration.clips[0].sourceOutUs], [4_500_000, 6_500_000]);
const sixSeconds = broll(6_000_000);
assert.deepEqual([sixSeconds.duration.clips[0].sourceInUs, sixSeconds.duration.clips[0].sourceOutUs], [2_000_000, 4_000_000]);
const fourSeconds = broll(4_000_000);
assert.deepEqual([fourSeconds.duration.clips[0].sourceInUs, fourSeconds.duration.clips[0].sourceOutUs], [1_000_000, 3_000_000]);
assert(fourSeconds.duration.issues.some(issue => issue.message.includes('素材较短')));
assert(fourSeconds.duration.clips[0].rangeId.startsWith('suggested-reduced:'));

const speechSlot = { slotId: 'voice', logicalCode: 'VO1', assetId: 'actor', contentFingerprint: 'source-fingerprint', sourceId: 'actor-file',
  mediaDurationUs: 10_000_000, sourceFps: 50, ranges: [] };
const speechMapping = await mapFormulaAudio({ mode: 'original', bodyText: '好擦洗。', slots: [{ ...speechSlot,
  speechStageId: 'speech', speech: { status: 'transcribed' as const, algorithmVersion: 'formula-source-speech/1' as const,
    executionReady: false as const, assetId: 'actor', contentFingerprint: 'source-fingerprint', sourceId: 'actor-file', mediaDurationUs: 10_000_000,
    text: '好擦洗。', words: [{ text: '好擦洗', startUs: 5_000_000, endUs: 7_000_000 }], reviewStatus: 'pending' as const, audioStreamIndex: 0 as const,
    transcriptionIdentity: { adapterVersion: 'openai-word-transcription/1' as const, model: 'fixture', endpointHash: 'fixture' } } }] },
async () => null, new AbortController().signal);
const speechTimeline = planned(buildFormulaTimeline({ ...baseInput, slots: [speechSlot],
  mapping: { stageId: 'speech-mapping', result: speechMapping }, narration: null,
  target: { mode: 'reference', scope: 'body', durationUs: 2_000_000 } }));
assert.deepEqual([speechTimeline.duration.clips[0].sourceInUs, speechTimeline.duration.clips[0].sourceOutUs], [4_875_000, 7_125_000]);
assert.equal(speechTimeline.duration.clips[0].hasSourceSpeech, true);
console.log('live mixcut b-roll range tests passed');
