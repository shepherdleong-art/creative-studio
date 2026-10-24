import assert from 'node:assert/strict';
import { planFormulaDuration, type FormulaDurationInput, type FormulaDurationSlot } from '../lib/live-mixcut/formula/duration.ts';

function slot(id: string, durationUs: number, preferredDurationUs = 1_000_000): FormulaDurationSlot {
  return { slotId: id, logicalCode: id.toUpperCase(), assetId: `asset-${id}`, contentFingerprint: `sha256:${id}`,
    mediaDurationUs: durationUs, sourceFps: 50, preferredDurationUs,
    range: { id: `range-${id}`, inUs: 0, outUs: durationUs, protected: null, confirmed: true } };
}

const input: FormulaDurationInput = {
  slots: [slot('s1', 2_000_000), { ...slot('vo1', 10_000_000),
    range: { id: 'range-vo1', inUs: 4_000_000, outUs: 9_000_000, protected: null, confirmed: true } }, slot('s2', 5_000_000, 3_000_000)],
  target: { mode: 'reference', scope: 'body', durationUs: 6_000_000 },
  audio: { status: 'ready', revisionId: 'audio-1', sources: [{ slotId: 'vo1', assetId: 'asset-vo1', contentFingerprint: 'sha256:vo1',
    speech: { inUs: 5_000_000, outUs: 7_000_000 }, marginUs: 0 }], narrations: [] },
};

const result = planFormulaDuration(input);
assert.equal(result.status, 'planned');
if (result.status !== 'planned') throw new Error('应生成合法时长计划');
assert.equal(result.bodyFrames, 144);
assert.equal(result.introFrames, 20);
assert.equal(result.totalFrames, 164);
assert.deepEqual(result.clips.map(clip => clip.timelineEndFrame - clip.timelineStartFrame), [30, 48, 66],
  '先固定 2 秒原声，两个画面最短各 12 帧；剩余 72 帧按 1:3 分成 18、54 帧');
assert.deepEqual(result.clips.map(clip => clip.slotId), ['s1', 'vo1', 's2']);
assert.deepEqual(result.clips.map(clip => clip.speed), [1, 1, 1], '50fps 原片按正常速度转为 24fps');
assert.equal(result.clips[1].sourceInUs, 5_000_000);
assert.equal(result.clips[1].sourceOutUs, 7_000_000);
assert.equal(result.clips[1].timelineStartUs, 1_250_000);
assert.equal(result.clips[1].timelineEndUs, 3_250_000);
assert.equal(result.bodyDurationUs, 6_000_000);
assert.equal(result.totalDurationUs, 6_833_333);
assert.deepEqual(planFormulaDuration(input), result, '相同输入重试不改变帧分配');
assert.equal(result.executionReady, false, '纯时长计划不冒充正式成片或审核通过');

// PS866 脚本 1 的辅助语音跨度仅作算法夹具，不表示完成实际素材听审。
const firstSlots = [slot('s14', 10_560_000), slot('p1', 6_720_000), slot('vo1', 6_720_000),
  slot('p2', 6_240_000), slot('vo2', 6_720_000), slot('vo3', 6_720_000), slot('vo4', 7_680_000)];
const firstInput: FormulaDurationInput = { slots: firstSlots, target: { mode: 'strict_max', scope: 'total', durationUs: 16_000_000 },
  audio: { status: 'ready', revisionId: 'speech-fixture', narrations: [],
    sources: [4_260_000, 5_080_000, 2_640_000, 5_360_000].map((length, index) => ({ slotId: `vo${index + 1}`,
      assetId: `asset-vo${index + 1}`, contentFingerprint: `sha256:vo${index + 1}`,
      speech: { inUs: 1_000_000, outUs: 1_000_000 + length }, marginUs: 0 })) } };
const firstStrict = planFormulaDuration(firstInput);
assert.equal(firstStrict.status, 'needs_attention');
if (firstStrict.status !== 'needs_attention') throw new Error('16 秒放不下完整话语');
assert.equal(firstStrict.conflicts[0].missingFrames, 90);
assert.equal(firstStrict.conflicts[0].requiredFrames, 454, '四段原声 418 帧，加三段展示各 12 帧');
assert.equal(firstStrict.conflicts[0].availableFrames, 364, '16 秒总片长只给正文留下 364 帧');
assert.deepEqual(firstStrict.conflicts[0].slotIds, ['s14', 'p1', 'vo1', 'p2', 'vo2', 'vo3', 'vo4']);
const firstReference = planFormulaDuration({ ...firstInput, target: { ...firstInput.target, mode: 'reference' } });
assert.equal(firstReference.status, 'planned');
if (firstReference.status !== 'planned') throw new Error('参考目标应保留完整内容');
assert.equal(firstReference.bodyFrames, 454);
assert.equal(firstReference.totalFrames, 474);
assert.equal(firstReference.issues.find(issue => issue.code === 'target_deviation')?.differenceFrames, 90);

const shortInput: FormulaDurationInput = { slots: [slot('s1', 1_000_000)],
  target: { mode: 'fixed', scope: 'body', durationUs: 2_000_000 },
  audio: { status: 'ready', revisionId: 'silent-reviewed', sources: [], narrations: [] } };
const tooLong = planFormulaDuration(shortInput);
assert.equal(tooLong.status, 'needs_attention');
if (tooLong.status !== 'needs_attention') throw new Error('固定片长不能循环补足');
assert.equal(tooLong.conflicts[0].code, 'insufficient_picture');
assert.equal(tooLong.conflicts[0].missingFrames, 24);
const belowCap = planFormulaDuration({ ...shortInput, target: { ...shortInput.target, mode: 'strict_max' } });
assert.equal(belowCap.status, 'planned');
if (belowCap.status !== 'planned') throw new Error('严格上限允许更短的完整结果');
assert.equal(belowCap.bodyFrames, 24);
const quantizedCap = planFormulaDuration({ ...shortInput, slots: [slot('s1', 3_000_000)],
  target: { mode: 'strict_max', scope: 'total', durationUs: 1_999_999 } });
assert.equal(quantizedCap.status, 'planned');
if (quantizedCap.status !== 'planned') throw new Error('严格上限需向下取帧');
assert.equal(quantizedCap.totalFrames, 47);
assert(quantizedCap.totalDurationUs <= 1_999_999);
const tinyReference = planFormulaDuration({ ...shortInput, target: { mode: 'reference', scope: 'total', durationUs: 500_000 } });
assert.equal(tinyReference.status, 'planned');
if (tinyReference.status !== 'planned') throw new Error('过短参考目标仍保全最短合法内容');
assert.equal(tinyReference.totalFrames, 32);
assert.equal(tinyReference.issues.find(issue => issue.code === 'target_deviation')?.differenceFrames, 20);

const action: FormulaDurationSlot = { ...slot('jump', 8_000_000),
  range: { id: 'jump-range', inUs: 1_000_000, outUs: 5_000_000,
    protected: { inUs: 2_010_000, outUs: 3_020_000 }, confirmed: true } };
const actionInput: FormulaDurationInput = { ...shortInput, slots: [action], target: { mode: 'reference', scope: 'body', durationUs: 1_000_000 } };
const actionPlan = planFormulaDuration(actionInput);
assert.equal(actionPlan.status, 'planned');
if (actionPlan.status !== 'planned') throw new Error('动作保护应向外取整');
assert.equal(actionPlan.bodyFrames, 25);
assert.equal(actionPlan.clips[0].sourceInFrame, 48);
assert.equal(actionPlan.clips[0].sourceOutFrame, 73);
const trimmedAction = planFormulaDuration({ ...actionInput, slots: [{ ...action, locked: { inFrame: 48, outFrame: 72 } }] });
assert.equal(trimmedAction.status, 'needs_attention', '锁定段也不能裁断保护动作');
const lockedAction = planFormulaDuration({ ...actionInput, target: { ...actionInput.target, durationUs: 6_000_000 },
  slots: [{ ...action, locked: { inFrame: 47, outFrame: 75 } }] });
assert.equal(lockedAction.status, 'planned');
if (lockedAction.status !== 'planned') throw new Error('合法锁定范围应原样保留');
assert.equal(lockedAction.bodyFrames, 28);
assert.equal(lockedAction.clips[0].sourceInFrame, 47);
assert.equal(lockedAction.clips[0].sourceOutFrame, 75);
assert.equal(planFormulaDuration({ ...actionInput, slots: [{ ...action, range: { ...action.range,
  protected: { inUs: 900_000, outUs: 1_400_000 } } }] }).status, 'needs_attention');
const paddedSpeech = planFormulaDuration({ ...input, audio: { ...input.audio, status: 'ready', revisionId: 'padded', narrations: [],
  sources: [{ slotId: 'vo1', assetId: 'asset-vo1', contentFingerprint: 'sha256:vo1', speech: { inUs: 5_000_000, outUs: 7_000_000 } }] } });
assert.equal(paddedSpeech.status, 'planned');
if (paddedSpeech.status !== 'planned') throw new Error('原声边距应向外取帧');
assert.equal(paddedSpeech.clips[1].sourceInFrame, 117);
assert.equal(paddedSpeech.clips[1].sourceOutFrame, 171);

const mixed: FormulaDurationInput = { slots: [slot('a', 1_000_000), slot('b', 2_000_000), slot('vo', 3_000_000), slot('c', 2_000_000)],
  target: { mode: 'reference', scope: 'body', durationUs: 4_000_000 }, audio: { status: 'ready', revisionId: 'mixed-audio',
    sources: [{ slotId: 'vo', assetId: 'asset-vo', contentFingerprint: 'sha256:vo', speech: { inUs: 500_000, outUs: 1_500_000 }, marginUs: 0 }],
    narrations: [{ id: 'intro-voice', slotIds: ['a', 'b'], audioArtifactId: 'actual-audio', contentFingerprint: 'sha256:voice',
      mediaDurationUs: 8_000_000, sourceInUs: 5_000_000, sourceOutUs: 7_000_000 }] } };
const mixedPlan = planFormulaDuration(mixed);
assert.equal(mixedPlan.status, 'planned');
if (mixedPlan.status !== 'planned') throw new Error('实际配音可跨连续展示镜头');
assert.deepEqual(mixedPlan.clips.map(clip => clip.timelineEndFrame - clip.timelineStartFrame), [24, 32, 24, 16]);
assert.equal(mixedPlan.narrations[0].sourceInUs, 5_000_000);
assert.equal(mixedPlan.narrations[0].sourceOutUs, 7_000_000);
assert.equal(mixedPlan.narrations[0].timelineStartUs, 0);
assert.equal(mixedPlan.narrations[0].timelineEndUs, 2_000_000);
assert.equal(mixedPlan.narrations[0].windowEndFrame, 56);
assert(mixedPlan.narrations[0].timelineEndUs <= mixedPlan.clips[2].timelineStartUs, '不能进入原声窗口抢话');
if (mixed.audio.status !== 'ready') throw new Error('夹具需有真实长度');
const crossSpeech = planFormulaDuration({ ...mixed, audio: { ...mixed.audio,
  narrations: [{ ...mixed.audio.narrations[0], slotIds: ['a', 'b', 'vo'] }] } });
assert.equal(crossSpeech.status, 'needs_attention');
if (crossSpeech.status !== 'needs_attention') throw new Error('配音不能跨真人原声');
assert.equal(crossSpeech.conflicts[0].code, 'audio_overlap');
const missingPicture = planFormulaDuration({ ...mixed, audio: { ...mixed.audio,
  narrations: [{ ...mixed.audio.narrations[0], sourceInUs: 0, sourceOutUs: 4_000_000 }] } });
assert.equal(missingPicture.status, 'needs_attention');
if (missingPicture.status !== 'needs_attention') throw new Error('配音长于窗口不能截尾');
assert.equal(missingPicture.conflicts[0].code, 'narration_window_too_short');
assert.equal(missingPicture.conflicts[0].missingFrames, 24);
assert.deepEqual(missingPicture.conflicts[0].slotIds, ['a', 'b']);
assert.equal(planFormulaDuration({ ...mixed, audio: { ...mixed.audio,
  narrations: [{ ...mixed.audio.narrations[0], slotIds: ['a', 'c'] }] } }).status, 'needs_attention');
assert.equal(planFormulaDuration({ ...mixed, audio: { ...mixed.audio,
  narrations: [mixed.audio.narrations[0], { ...mixed.audio.narrations[0], id: 'second-voice', slotIds: ['b'] }] } }).status, 'needs_attention');

const pending = planFormulaDuration({ ...input, audio: { status: 'pending', pendingIds: ['tts-12', 'speech-vo1'] } });
assert.deepEqual(pending, { status: 'waiting_audio', executionReady: false, pendingIds: ['tts-12', 'speech-vo1'] },
  '声音未就绪不能用估算生成帧计划');
const capped = planFormulaDuration({ ...shortInput, slots: [slot('a', 1_000_000, 100_000_000), slot('b', 4_000_000), slot('c', 4_000_000)],
  target: { mode: 'fixed', scope: 'body', durationUs: 5_000_000 } });
assert.equal(capped.status, 'planned');
if (capped.status !== 'planned') throw new Error('达到上限后应重新分配');
assert.deepEqual(capped.clips.map(clip => clip.timelineEndFrame - clip.timelineStartFrame), [24, 48, 48]);
const remainder = planFormulaDuration({ ...shortInput, slots: [slot('a', 2_000_000), slot('b', 2_000_000), slot('c', 2_000_000)],
  target: { mode: 'fixed', scope: 'body', durationUs: 1_541_667 } });
assert.equal(remainder.status, 'planned');
if (remainder.status !== 'planned') throw new Error('余帧应按槽位顺序分配');
assert.deepEqual(remainder.clips.map(clip => clip.timelineEndFrame - clip.timelineStartFrame), [13, 12, 12]);
const longInput: FormulaDurationInput = { ...shortInput, slots: Array.from({ length: 1_000 }, (_, i) => slot(`shot${i}`, 1_000_000)),
  target: { mode: 'fixed', scope: 'body', durationUs: 541_666_667 } };
const originalLongInput = structuredClone(longInput);
const longPlan = planFormulaDuration(longInput);
assert.equal(longPlan.status, 'planned');
if (longPlan.status !== 'planned') throw new Error('长公式应逐帧精确累计');
assert.equal(longPlan.bodyFrames, 13_000);
assert.equal(longPlan.clips[499].timelineEndUs, 270_833_333);
assert.equal(longPlan.clips[999].timelineEndUs, 541_666_667, '不能累加每片近似微秒造成漂移');
assert.equal(longPlan.totalFrames, 13_020);
assert.equal(longPlan.totalDurationUs, 542_500_000);
assert.deepEqual(longInput, originalLongInput, '计算不能改变冻结输入');
const unconfirmed = planFormulaDuration({ ...shortInput, target: { ...shortInput.target, mode: 'reference' },
  slots: [{ ...shortInput.slots[0], range: { ...shortInput.slots[0].range, confirmed: false } }] });
assert.equal(unconfirmed.status, 'planned');
if (unconfirmed.status !== 'planned') throw new Error('未标记素材可以有待确认裁切');
assert.deepEqual(unconfirmed.issues.find(issue => issue.code === 'range_unconfirmed')?.slotIds, ['s1']);
assert.equal(planFormulaDuration({ ...shortInput, slots: [slot('s1', 499_999)] }).status, 'needs_attention');
const wrongSource = planFormulaDuration({ ...input, audio: { status: 'ready', revisionId: 'wrong', narrations: [],
  sources: [{ slotId: 'vo1', assetId: 'other-asset', contentFingerprint: 'sha256:vo1', speech: { inUs: 5_000_000, outUs: 7_000_000 } }] } });
assert.equal(wrongSource.status, 'needs_attention');
if (wrongSource.status !== 'needs_attention') throw new Error('换片后不能沿用旧原声');
assert.equal(wrongSource.conflicts[0].code, 'audio_identity_mismatch');
assert.throws(() => planFormulaDuration({ ...shortInput, slots: [shortInput.slots[0], shortInput.slots[0]] }), /重复/);
assert.throws(() => planFormulaDuration({ ...shortInput, target: { ...shortInput.target, durationUs: Number.NaN } }), /整数/);

console.log('公式时长：三种目标、原声/动作保护/锁定、连续配音窗口、源时间映射、边界与千镜头无漂移通过');
