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
