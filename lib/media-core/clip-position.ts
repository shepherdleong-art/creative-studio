export interface PositionedClip { id: string; startUs: number; endUs: number }

/** Move within a gap; dragging across another clip's center changes the order.
 * Source windows are untouched. Reordering preserves the gaps between slots.
 */
export function planClipPosition(clips: PositionedClip[], clipId: string, requestedStartUs: number, bodyEndUs: number): PositionedClip[] {
  const ordered = [...clips].sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id));
  const index = ordered.findIndex((clip) => clip.id === clipId);
  if (index < 0) return ordered;
  const clip = ordered[index];
  const duration = clip.endUs - clip.startUs;
  const startUs = Math.max(0, Math.min(requestedStartUs, Math.max(0, bodyEndUs - duration)));
  const remaining = ordered.filter((item) => item.id !== clipId);
  const overlaps = remaining.some((item) => startUs < item.endUs && startUs + duration > item.startUs);
  if (!overlaps) return ordered.map((item) => item.id === clipId ? { ...item, startUs, endUs: startUs + duration } : item).sort((a, b) => a.startUs - b.startUs);

  const centerUs = Math.max(0, requestedStartUs) + duration / 2;
  const insertion = remaining.findIndex((item) => centerUs < (item.startUs + item.endUs) / 2);
  const target = insertion < 0 ? remaining.length : insertion;
  if (target === index) {
    const minimum = index > 0 ? ordered[index - 1].endUs : 0;
    const maximum = (ordered[index + 1]?.startUs ?? bodyEndUs) - duration;
    const bounded = Math.max(minimum, Math.min(startUs, maximum));
    return ordered.map((item) => item.id === clipId ? { ...item, startUs: bounded, endUs: bounded + duration } : item);
  }
  const gaps = ordered.map((item, i) => i ? item.startUs - ordered[i - 1].endUs : item.startUs);
  const reordered = [...remaining.slice(0, target), clip, ...remaining.slice(target)];
  let cursor = 0;
  return reordered.map((item, i) => {
    cursor += gaps[i];
    const position = { ...item, startUs: cursor, endUs: cursor + item.endUs - item.startUs };
    cursor = position.endUs;
    return position;
  });
}
