import type { BatchOutputSubtitleCueView } from '../../../lib/batch-production/output-arrangement.ts';
import { FINAL_EDIT_FPS } from '../../../lib/media-core/render-contract.ts';
import { planSubtitleCueSplit } from '../../final-edit/subtitle-split.ts';

/** 与原批量字幕编辑器相同：按正文时间分割，文字随分割点拆成两段。 */
export function subtitleSplitEdit(cue: BatchOutputSubtitleCueView, requestedSplitUs: number) {
  const plan = planSubtitleCueSplit({
    cue: {
      ...cue,
      segmentId: cue.sourceSegmentId,
      textSource: cue.timingSource === 'manual' ? 'manual' : 'script',
      timingSource: cue.timingSource === 'aligned' ? 'aligned' : cue.timingSource === 'estimated' ? 'proportional' : 'manual',
    },
    requestedSplitUs,
    fps: FINAL_EDIT_FPS,
  });
  return plan ? { type: 'split_subtitle_cue' as const, cueId: cue.id, ...plan } : null;
}

/** 只调整当前字幕；邻接字幕和正文结尾是伸展边界，保留原有不足一帧的短字幕。 */
export function subtitleTrimRange(
  cue: BatchOutputSubtitleCueView,
  cues: BatchOutputSubtitleCueView[],
  edge: 'start' | 'end',
  requestedUs: number,
  bodyDurationUs: number,
) {
  const frameUs = 1_000_000 / FINAL_EDIT_FPS;
  const minUs = Math.min(Math.floor(frameUs), cue.endUs - cue.startUs);
  const previousEnd = Math.max(0, ...cues.filter(c => c.id !== cue.id && c.endUs <= cue.startUs).map(c => c.endUs));
  const nextStart = Math.min(bodyDurationUs, ...cues.filter(c => c.id !== cue.id && c.startUs >= cue.endUs).map(c => c.startUs));
  const atUs = Math.round(Math.round(requestedUs / frameUs) * frameUs);
  return edge === 'start'
    ? { startUs: Math.max(previousEnd, Math.min(cue.endUs - minUs, atUs)), endUs: cue.endUs }
    : { startUs: cue.startUs, endUs: Math.min(Math.max(cue.endUs, nextStart), Math.max(cue.startUs + minUs, atUs)) };
}
