import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../../media-core/render-contract.ts';
import { BatchDomainError } from '../errors.ts';
import type { FormulaRangeBounds } from './range-contract.ts';

/** 每槽位使用已选定的一个连续区间；区间分析/选择与真实声音核验由调用方完成。 */
export interface FormulaDurationSlot {
  slotId: string; logicalCode: string; assetId: string; contentFingerprint: string;
  mediaDurationUs: number; sourceFps: number; preferredDurationUs: number;
  range: FormulaRangeBounds & { id: string; protected: FormulaRangeBounds | null; confirmed: boolean };
  locked?: { inFrame: number; outFrame: number };
}
export interface FormulaDurationTarget {
  mode: 'reference' | 'strict_max' | 'fixed'; scope: 'body' | 'total'; durationUs: number;
}
export interface FormulaSourceSpeech {
  slotId: string; assetId: string; contentFingerprint: string; speech: FormulaRangeBounds; marginUs?: number;
}
export interface FormulaNarrationWindow {
  id: string; slotIds: string[]; audioArtifactId: string; contentFingerprint: string;
  mediaDurationUs: number; sourceInUs: number; sourceOutUs: number;
}
export type FormulaDurationAudio = { status: 'pending'; pendingIds: string[] } | {
  status: 'ready'; revisionId: string; sources: FormulaSourceSpeech[]; narrations: FormulaNarrationWindow[];
};
export interface FormulaDurationInput { slots: FormulaDurationSlot[]; target: FormulaDurationTarget; audio: FormulaDurationAudio }
export interface FormulaDurationConflict {
  code: string; slotIds: string[]; message: string; missingFrames?: number; requiredFrames?: number; availableFrames?: number;
  constraints?: Array<{ slotIds: string[]; minimumFrames: number; maximumFrames: number; reason: string; windowId?: string }>;
}
export interface FormulaDurationClip {
  slotId: string; logicalCode: string; assetId: string; contentFingerprint: string; rangeId: string;
  /** 源/正文帧号统一表示 24fps 时间边界，不是摄像机的原生帧号。 */
  sourceInFrame: number; sourceOutFrame: number; sourceInUs: number; sourceOutUs: number;
  timelineStartFrame: number; timelineEndFrame: number; timelineStartUs: number; timelineEndUs: number;
  speed: 1; rangeConfirmed: boolean; hasSourceSpeech: boolean;
}
export interface FormulaTimedNarration extends FormulaNarrationWindow {
  timelineStartFrame: number; windowEndFrame: number; timelineStartUs: number; timelineEndUs: number;
}
export type FormulaDurationResult = {
  status: 'waiting_audio'; executionReady: false; pendingIds: string[];
} | {
  status: 'needs_attention'; executionReady: false; conflicts: FormulaDurationConflict[];
} | {
  status: 'planned'; algorithmVersion: 'formula-duration/1'; executionReady: false;
  fps: typeof FINAL_EDIT_FPS; introFrames: typeof FINAL_EDIT_INTRO_FRAMES;
  bodyFrames: number; totalFrames: number; bodyDurationUs: number; totalDurationUs: number;
  audioRevisionId: string;
  target: FormulaDurationTarget & { quantizedFrames: number; bodyFrames: number; totalFrames: number; quantizedDurationUs: number };
  issues: Array<{ code: 'target_quantized' | 'target_deviation' | 'range_unconfirmed'; slotIds: string[]; message: string; differenceFrames?: number }>;
  clips: FormulaDurationClip[]; narrations: FormulaTimedNarration[];
};

const FPS = BigInt(FINAL_EDIT_FPS);
const SECOND = BigInt(1_000_000);
const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2);
const MIN_FRAMES = FINAL_EDIT_FPS / 2;
function invalid(message: string): never { throw new BatchDomainError('invalid_input', message); }
function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${name}必须是有效整数`);
  return value;
}
function frame(us: number, rounding: 'floor' | 'ceil' | 'nearest'): number {
  const numerator = BigInt(integer(us, '时间')) * FPS;
  return integer(Number((numerator + (rounding === 'ceil' ? SECOND - ONE : rounding === 'nearest' ? SECOND / TWO : ZERO)) / SECOND), '帧数');
}
function time(frames: number): number { return integer(Number((BigInt(frames) * SECOND + FPS / TWO) / FPS), '时间'); }
function sum(values: number[]): number { return integer(values.reduce((total, value) => total + value, 0), '总帧数'); }
function bounds(value: FormulaRangeBounds, durationUs: number): void {
  integer(value.inUs, '区间入点'); integer(value.outUs, '区间出点', 1);
  if (value.inUs >= value.outUs || value.outUs > durationUs) invalid('区间超出媒体范围或没有有效长度');
}
function blocked(conflict: FormulaDurationConflict): FormulaDurationResult {
  return { status: 'needs_attention', executionReady: false, conflicts: [{ ...conflict, slotIds: [...conflict.slotIds],
    ...(conflict.constraints ? { constraints: conflict.constraints.map(item => ({ ...item, slotIds: [...item.slotIds] })) } : {}) }] };
}
interface Limit { min: number; max: number; weight: number }
interface Prepared extends Limit {
  slot: FormulaDurationSlot; start: number; end: number; fixedStart?: number; source?: FormulaSourceSpeech;
  protectedStart?: number; protectedEnd?: number;
}
interface Group extends Limit { indices: number[]; narration?: FormulaNarrationWindow }

/** 先留每项最低帧数，再按偏好分余量；触上限的项退出，末尾余帧按原顺序分配。 */
function allocate(total: number, limits: Limit[]): number[] {
  const allocated = limits.map(limit => limit.min);
  let remaining = total - sum(allocated);
  while (remaining > 0) {
    const active = limits.flatMap((limit, index) => allocated[index] < limit.max ? [index] : []);
    if (!active.length) invalid('分配帧数超出可用区间');
    const weight = active.reduce((value, index) => value + BigInt(limits[index].weight), ZERO);
    const shares = active.map(index => Number(BigInt(remaining) * BigInt(limits[index].weight) / weight));
    const capped = active.filter((index, i) => shares[i] > limits[index].max - allocated[index]);
    if (capped.length) {
      for (const index of capped) { remaining -= limits[index].max - allocated[index]; allocated[index] = limits[index].max; }
      continue;
    }
    for (let i = 0; i < active.length; i++) { allocated[active[i]] += shares[i]; remaining -= shares[i]; }
    for (const index of active) {
      if (remaining && allocated[index] < limits[index].max) { allocated[index]++; remaining--; }
    }
  }
  return allocated;
}

/** 纯计算：不估算声音、不选其他原片、不写库；正式执行还需来源/声音/审核核验。 */
export function planFormulaDuration(input: FormulaDurationInput): FormulaDurationResult {
  const { slots, target, audio } = input;
  if (!slots.length || slots.length > 1_000 || new Set(slots.map(slot => slot.slotId)).size !== slots.length) invalid('公式槽位为空、重复或超过上限');
  integer(target.durationUs, '目标时长', 1);
  if (!['reference', 'strict_max', 'fixed'].includes(target.mode) || !['body', 'total'].includes(target.scope)) invalid('目标时长方式无效');
  if (audio.status === 'pending') return { status: 'waiting_audio', executionReady: false, pendingIds: [...audio.pendingIds] };
  if (audio.status !== 'ready' || !audio.revisionId || !Array.isArray(audio.sources) || !Array.isArray(audio.narrations)
    || audio.sources.length > 1_000 || audio.narrations.length > 1_000) invalid('缺少有效的声音修订或声音数量超限');
  const prepared: Prepared[] = [];
  for (const slot of slots) {
    if (!slot.slotId || !slot.logicalCode || !slot.assetId || !slot.contentFingerprint || !slot.range.id) invalid('选片身份不完整');
    integer(slot.mediaDurationUs, '媒体时长', 1); integer(slot.preferredDurationUs, '偏好时长', 1);
    if (!Number.isFinite(slot.sourceFps) || slot.sourceFps <= 0) invalid('原片帧率无效');
    bounds(slot.range, slot.mediaDurationUs);
    const start = frame(slot.range.inUs, 'ceil'), end = frame(slot.range.outUs, 'floor');
    if (end - start < MIN_FRAMES) return blocked({ code: 'range_too_short', slotIds: [slot.slotId], message: '可用区间不足 12 个完整输出帧', missingFrames: MIN_FRAMES - (end - start) });
    const speech = audio.sources.filter(source => source.slotId === slot.slotId);
    if (speech.length > 1) invalid('同一槽位的完整话语应合并为包含句内停顿的连续区间');
    const source = speech[0];
    const limit: Prepared = { slot, start, end, min: MIN_FRAMES, max: end - start, weight: slot.preferredDurationUs, source };
    if (slot.range.protected) {
      bounds(slot.range.protected, slot.mediaDurationUs);
      limit.protectedStart = frame(slot.range.protected.inUs, 'floor');
      limit.protectedEnd = frame(slot.range.protected.outUs, 'ceil');
      if (limit.protectedStart < start || limit.protectedEnd > end) return blocked({ code: 'protected_outside_range',
        slotIds: [slot.slotId], message: '可用区间没有完整覆盖保护动作及帧边界' });
      limit.min = Math.max(MIN_FRAMES, limit.protectedEnd - limit.protectedStart);
    }
    if (source) {
      if (source.assetId !== slot.assetId || source.contentFingerprint !== slot.contentFingerprint) return blocked({ code: 'audio_identity_mismatch', slotIds: [slot.slotId], message: '原声与所选原片不一致，需要重新核验声音' });
      bounds(source.speech, slot.mediaDurationUs);
      if (frame(source.speech.inUs, 'floor') < start || frame(source.speech.outUs, 'ceil') > end) return blocked({ code: 'speech_outside_range', slotIds: [slot.slotId], message: '可用区间不能完整容纳话语' });
      const margin = integer(source.marginUs ?? 120_000, '语音边距');
      const speechStart = Math.min(limit.protectedStart ?? end, Math.max(start, frame(Math.max(0, source.speech.inUs - margin), 'floor')));
      const speechEnd = Math.max(limit.protectedEnd ?? start, Math.min(end, frame(Math.min(slot.mediaDurationUs, source.speech.outUs + margin), 'ceil')));
      limit.min = limit.max = Math.max(MIN_FRAMES, speechEnd - speechStart);
      limit.fixedStart = Math.min(speechStart, end - limit.min);
    }
    if (slot.locked) {
      const lockedStart = integer(slot.locked.inFrame, '锁定入点帧'), lockedEnd = integer(slot.locked.outFrame, '锁定出点帧');
      if (lockedEnd - lockedStart < MIN_FRAMES || lockedStart < start || lockedEnd > end
        || (limit.protectedStart !== undefined && lockedStart > limit.protectedStart)
        || (limit.protectedEnd !== undefined && lockedEnd < limit.protectedEnd)
        || (source && (lockedStart > frame(source.speech.inUs, 'floor') || lockedEnd < frame(source.speech.outUs, 'ceil')))) {
        return blocked({ code: 'locked_range_invalid', slotIds: [slot.slotId], message: '锁定范围越界、过短或裁断了动作/完整话语' });
      }
      limit.min = limit.max = lockedEnd - lockedStart;
      limit.fixedStart = lockedStart;
    }
    prepared.push(limit);
  }
  if (audio.sources.some(source => !slots.some(slot => slot.slotId === source.slotId))) invalid('原声引用了其他输出的槽位');
  const windows = new Map<number, Group>();
  const occupied = new Set<number>();
  const windowIds = new Set<string>();
  for (const narration of audio.narrations) {
    if (!narration.id || windowIds.has(narration.id) || !narration.audioArtifactId || !narration.contentFingerprint
      || !Array.isArray(narration.slotIds) || !narration.slotIds.length || narration.slotIds.length > slots.length) invalid('配音窗口身份或槽位无效');
    windowIds.add(narration.id);
    integer(narration.mediaDurationUs, '配音文件实际时长', 1);
    bounds({ inUs: narration.sourceInUs, outUs: narration.sourceOutUs }, narration.mediaDurationUs);
    const indices = narration.slotIds.map(id => slots.findIndex(slot => slot.slotId === id));
    if (indices.some(index => index < 0)) invalid('配音引用了其他输出的槽位');
    if (indices.some((index, i) => index !== indices[0] + i)) return blocked({ code: 'non_contiguous_narration',
      slotIds: narration.slotIds, message: '配音只能放在连续的非原声镜头中，不能跳过中间镜头' });
    if (indices.some(index => prepared[index].source || occupied.has(index))) return blocked({ code: 'audio_overlap',
      slotIds: narration.slotIds, message: '配音窗口与真人原声或另一段配音重叠，请重新分配声音' });
    const required = frame(narration.sourceOutUs - narration.sourceInUs, 'ceil');
    const maximum = sum(indices.map(index => prepared[index].max));
    if (required > maximum) return blocked({ code: 'narration_window_too_short', slotIds: narration.slotIds,
      requiredFrames: required, availableFrames: maximum, missingFrames: required - maximum,
      message: `配音需要 ${required} 帧，但这些镜头最多只有 ${maximum} 帧，不能截断配音` });
    const group: Group = { indices, narration, max: maximum,
      min: Math.max(required, sum(indices.map(index => prepared[index].min))),
      weight: sum(indices.map(index => prepared[index].weight)) };
    windows.set(indices[0], group);
    indices.forEach(index => occupied.add(index));
  }
  const groups: Group[] = prepared.flatMap((item, index) => windows.has(index) ? [windows.get(index)!]
    : occupied.has(index) ? [] : [{ min: item.min, max: item.max, weight: item.weight, indices: [index] }]);
  const quantizedFrames = frame(target.durationUs, target.mode === 'strict_max' ? 'floor' : 'nearest');
  const targetBody = target.scope === 'total' ? quantizedFrames - FINAL_EDIT_INTRO_FRAMES : quantizedFrames;
  const minimum = sum(groups.map(item => item.min)), maximum = sum(groups.map(item => item.max));
  const constraints: NonNullable<FormulaDurationConflict['constraints']> = prepared.map(item => ({ slotIds: [item.slot.slotId], minimumFrames: item.min, maximumFrames: item.max,
    reason: item.slot.locked ? '已锁定区间' : item.source ? '完整原声' : item.protectedStart !== undefined ? '保护动作' : '镜头最短时长' }));
  for (const group of groups) if (group.narration) constraints.push({ slotIds: group.narration.slotIds, windowId: group.narration.id,
    minimumFrames: group.min, maximumFrames: group.max, reason: '完整配音窗口' });
  if (target.mode !== 'reference' && targetBody < minimum) return blocked({ code: 'target_too_short',
    slotIds: slots.map(slot => slot.slotId), requiredFrames: minimum, availableFrames: Math.max(0, targetBody),
    missingFrames: minimum - targetBody, constraints, message: `正文至少需要 ${minimum} 帧，目标扣除封面后不足，不能裁断完整内容` });
  if (target.mode === 'fixed' && targetBody > maximum) return blocked({ code: 'insufficient_picture',
    slotIds: slots.map(slot => slot.slotId), requiredFrames: targetBody, availableFrames: maximum,
    missingFrames: targetBody - maximum, constraints, message: `画面最多可用 ${maximum} 帧，无法凑足固定片长` });
  const bodyFrames = Math.min(maximum, Math.max(minimum, targetBody));
  const groupDurations = allocate(bodyFrames, groups);
  const durations = prepared.map(() => 0);
  groups.forEach((group, i) => {
    const within = allocate(groupDurations[i], group.indices.map(index => prepared[index]));
    group.indices.forEach((index, j) => { durations[index] = within[j]; });
  });
  let cursor = 0;
  const clips = prepared.map((item, index): FormulaDurationClip => {
    const sourceStart = item.fixedStart ?? Math.max(item.start, (item.protectedEnd ?? item.start) - durations[index]);
    const sourceEnd = sourceStart + durations[index];
    const timelineStartFrame = cursor; cursor += durations[index];
    return { slotId: item.slot.slotId, logicalCode: item.slot.logicalCode, assetId: item.slot.assetId,
      contentFingerprint: item.slot.contentFingerprint, rangeId: item.slot.range.id,
      sourceInFrame: sourceStart, sourceOutFrame: sourceEnd, sourceInUs: time(sourceStart), sourceOutUs: time(sourceEnd),
      timelineStartFrame, timelineEndFrame: cursor, timelineStartUs: time(timelineStartFrame), timelineEndUs: time(cursor),
      speed: 1, rangeConfirmed: item.slot.range.confirmed, hasSourceSpeech: !!item.source };
  });
  const totalFrames = integer(bodyFrames + FINAL_EDIT_INTRO_FRAMES, '总片长帧数');
  const narrations: FormulaTimedNarration[] = groups.flatMap(group => group.narration ? [{ ...group.narration,
    slotIds: [...group.narration.slotIds], timelineStartFrame: clips[group.indices[0]].timelineStartFrame,
    windowEndFrame: clips[group.indices.at(-1)!].timelineEndFrame, timelineStartUs: clips[group.indices[0]].timelineStartUs,
    timelineEndUs: clips[group.indices[0]].timelineStartUs + group.narration.sourceOutUs - group.narration.sourceInUs }] : []);
  const issues: Extract<FormulaDurationResult, { status: 'planned' }>['issues'] = [];
  if (time(quantizedFrames) !== target.durationUs) issues.push({ code: 'target_quantized', slotIds: [], message: '目标时长已换算为 24fps 整帧' });
  if (target.mode === 'reference' && bodyFrames !== targetBody) issues.push({ code: 'target_deviation', slotIds: slots.map(slot => slot.slotId), differenceFrames: bodyFrames - targetBody, message: '按完整内容生成的片长与参考目标不同，请审片核对' });
  const unconfirmed = slots.filter(slot => !slot.range.confirmed).map(slot => slot.slotId);
  if (unconfirmed.length) issues.push({ code: 'range_unconfirmed', slotIds: unconfirmed, message: '这些裁切区间仍需审片确认' });
  return { status: 'planned', algorithmVersion: 'formula-duration/1', executionReady: false, fps: FINAL_EDIT_FPS,
    introFrames: FINAL_EDIT_INTRO_FRAMES, bodyFrames, totalFrames, bodyDurationUs: time(bodyFrames), totalDurationUs: time(totalFrames),
    audioRevisionId: audio.revisionId, target: { ...target, quantizedFrames, bodyFrames: Math.max(0, targetBody),
      totalFrames: targetBody + FINAL_EDIT_INTRO_FRAMES, quantizedDurationUs: time(quantizedFrames) }, issues, clips, narrations };
}
