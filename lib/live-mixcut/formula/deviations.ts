import type { FormulaSelection } from './selection.ts';

type Binding = { logicalCode: string | null; assetId: string; contentFingerprint: string };
type Clip = { clipId: string; segmentId?: string; assetId: string; contentFingerprint: string;
  timelineStartUs: number; timelineEndUs: number; sourceStartUs: number; sourceEndUs: number };
type OriginalClip = { slotId: string; assetId: string; contentFingerprint: string; sourceInUs: number; sourceOutUs: number };

/** Compare the actual edit with the saved selection; adjacent split pieces retain one formula slot. */
export function describeFormulaDeviations(selection: FormulaSelection, clips: readonly Clip[], bindings: readonly Binding[] = [], originalClips: readonly OriginalClip[] = []) {
  const slots = new Map(selection.slots.map(slot => [slot.slotId, slot]));
  const selectedCode = (slot: FormulaSelection['slots'][number]) => slot.sourceLogicalCode
    ?? slot.manualReplacement?.replacementCode ?? slot.replacement?.replacementCode ?? slot.logicalCode;
  const actualCodes = (clip: Clip) => [...new Set([
    ...bindings.filter(item => item.assetId === clip.assetId && item.contentFingerprint === clip.contentFingerprint).map(item => item.logicalCode),
    ...selection.slots.filter(slot => slot.assetId === clip.assetId && slot.candidate?.contentFingerprint === clip.contentFingerprint).map(selectedCode),
  ].filter((code): code is string => typeof code === 'string' && !!code))].sort();
  const ordered = [...clips].sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.timelineEndUs - b.timelineEndUs || a.clipId.localeCompare(b.clipId));
  const originalOrder = selection.slots.map(slot => slot.slotId);
  const actualOrder: string[] = [];
  const insertedClips: Array<{ clipId: string; assetId: string; contentFingerprint: string; actualCodes: string[] }> = [];
  const replacedClips: Array<{ clipId: string; slotId: string; originalCode: string; selectedCode: string;
    selectedAssetId: string | null; selectedFingerprint: string | null; assetId: string; contentFingerprint: string; actualCodes: string[] }> = [];
  for (const clip of ordered) {
    const slot = slots.get(clip.segmentId ?? '');
    if (!slot) {
      insertedClips.push({ clipId: clip.clipId, assetId: clip.assetId, contentFingerprint: clip.contentFingerprint, actualCodes: actualCodes(clip) });
      continue;
    }
    if (actualOrder.at(-1) !== slot.slotId) actualOrder.push(slot.slotId);
    if (slot.assetId !== clip.assetId || slot.candidate?.contentFingerprint !== clip.contentFingerprint) replacedClips.push({
      clipId: clip.clipId, slotId: slot.slotId, originalCode: slot.logicalCode, selectedCode: selectedCode(slot),
      selectedAssetId: slot.assetId, selectedFingerprint: slot.candidate?.contentFingerprint ?? null,
      assetId: clip.assetId, contentFingerprint: clip.contentFingerprint, actualCodes: actualCodes(clip),
    });
  }
  const sourceRangeChanges = originalClips.flatMap(original => {
    const pieces = ordered.filter(clip => clip.segmentId === original.slotId && clip.assetId === original.assetId
      && clip.contentFingerprint === original.contentFingerprint).sort((a, b) => a.sourceStartUs - b.sourceStartUs);
    if (!pieces.length || replacedClips.some(clip => clip.slotId === original.slotId)) return [];
    const actualRanges: Array<{ sourceInUs: number; sourceOutUs: number }> = [];
    for (const piece of pieces) {
      const last = actualRanges.at(-1);
      if (last && piece.sourceStartUs <= last.sourceOutUs + 1) last.sourceOutUs = Math.max(last.sourceOutUs, piece.sourceEndUs);
      else actualRanges.push({ sourceInUs: piece.sourceStartUs, sourceOutUs: piece.sourceEndUs });
    }
    if (actualRanges.length === 1 && actualRanges[0].sourceInUs === original.sourceInUs && actualRanges[0].sourceOutUs === original.sourceOutUs) return [];
    return [{ slotId: original.slotId, originalCode: slots.get(original.slotId)!.logicalCode,
      originalRange: { sourceInUs: original.sourceInUs, sourceOutUs: original.sourceOutUs }, actualRanges }];
  });
  return { originalOrder, actualOrder, insertedClips, replacedClips, sourceRangeChanges,
    deletedSlots: selection.slots.filter(slot => !actualOrder.includes(slot.slotId)).map(slot => ({ slotId: slot.slotId, originalCode: slot.logicalCode })),
    reordered: JSON.stringify(actualOrder) !== JSON.stringify(originalOrder.filter(id => actualOrder.includes(id))),
  };
}

type ScheduleClip = { id: string; kind?: string; slotIndex?: number; logicalCode?: string; assetId: string;
  contentFingerprint: string; sourceInUs: number; sourceOutUs: number };
type SchedulePlanItem = { kind: string; slotIndex?: number; dropped?: boolean };
export interface ScheduleDeviationSource {
  timeline: { clips: readonly ScheduleClip[] };
  plan?: { items: readonly SchedulePlanItem[] };
}

/**
 * 排时间画面 → 选片槽位。
 * 口播画面自己带 slotIndex；非口播画面上没有，只能按「定声音的镜头项和公式画面一一对应」的顺序配回去。
 * 补镜不是公式镜头，不在里面。
 */
export function scheduleClipSlotIds(selection: FormulaSelection, schedule: ScheduleDeviationSource): Map<string, string> {
  const slotIndexByClipId = new Map<string, number>();
  for (const clip of schedule.timeline.clips) if (clip.slotIndex !== undefined) slotIndexByClipId.set(clip.id, clip.slotIndex);
  // 被丢掉的镜头（文案已经读完）不出画面，配槽位时要跳过，否则后面的镜头会整体错位。
  const formulaItems = (schedule.plan?.items ?? []).filter((item): item is SchedulePlanItem & { slotIndex: number } =>
    (item.kind === 'shot' || item.kind === 'vo') && typeof item.slotIndex === 'number'
    && !(item.kind === 'shot' && item.dropped === true));
  const formulaClips = schedule.timeline.clips.filter(clip => clip.kind !== 'filler');
  if (formulaItems.length === formulaClips.length) {
    formulaClips.forEach((clip, index) => {
      if (!slotIndexByClipId.has(clip.id)) slotIndexByClipId.set(clip.id, formulaItems[index].slotIndex);
    });
  }
  const slotIdByClipId = new Map<string, string>();
  for (const clip of schedule.timeline.clips) {
    const slotIndex = slotIndexByClipId.get(clip.id);
    const slot = slotIndex === undefined ? undefined : selection.slots[slotIndex];
    if (slot) slotIdByClipId.set(clip.id, slot.slotId);
  }
  return slotIdByClipId;
}

/**
 * 排时间出来的成片：以排时间结果当基线。
 * 补镜、替代镜头、没用上的镜头都是算法自己的决定，不算人工改动；只有和排时间结果不一致的地方才是。
 */
export function describeScheduleFormulaDeviations(selection: FormulaSelection,
  schedule: ScheduleDeviationSource, clips: readonly Clip[], bindings: readonly Binding[] = []) {
  const slotIdByClipId = scheduleClipSlotIds(selection, schedule);
  const scheduledSlotIds = new Set(slotIdByClipId.values());
  // 基线认排时间实际用的素材和区间：同号轮换、替镜都不是人工改动。
  const baselineClips = schedule.timeline.clips.flatMap(clip => {
    const slotId = slotIdByClipId.get(clip.id);
    return slotId ? [{ slotId, assetId: clip.assetId, contentFingerprint: clip.contentFingerprint,
      sourceInUs: clip.sourceInUs, sourceOutUs: clip.sourceOutUs }] : [];
  });
  const baselineAsset = new Map(baselineClips.map(clip => [clip.slotId, clip]));
  const baselineSelection = { ...selection, slots: selection.slots.filter(slot => scheduledSlotIds.has(slot.slotId))
    .map(slot => {
      const clip = baselineAsset.get(slot.slotId);
      if (!clip) return slot;
      return { ...slot, assetId: clip.assetId,
        // 缺号时选片没有候选文件；基线指纹仍要写上排时间实际用的那份，否则会误报成人工换片。
        candidate: { ...(slot.candidate ?? {}), assetId: clip.assetId, contentFingerprint: clip.contentFingerprint } as NonNullable<typeof slot.candidate> };
    }) };
  // 成片版本里的 segmentId：口播是选片槽位，非口播是排时间片段 id（分割出来的后半段也是）；
  // 比较前统一换回槽位。
  const selectionSlotIds = new Set(selection.slots.map(slot => slot.slotId));
  const normalizedClips = clips.map(clip => {
    const segmentId = clip.segmentId ?? '';
    const slotId = slotIdByClipId.get(clip.clipId) ?? slotIdByClipId.get(segmentId)
      ?? (selectionSlotIds.has(segmentId) ? segmentId : undefined);
    return slotId === undefined || slotId === clip.segmentId ? clip : { ...clip, segmentId: slotId };
  });
  const changes = describeFormulaDeviations(baselineSelection, normalizedClips, bindings, baselineClips);
  // 排时间自己生成的画面（补镜等）不是人工插入。
  const generatedClipIds = new Set(schedule.timeline.clips.map(clip => clip.id));
  changes.insertedClips = changes.insertedClips.filter(clip => !generatedClipIds.has(clip.clipId));
  return changes;
}
