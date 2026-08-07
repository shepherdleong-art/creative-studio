import { splitNarrationForDisplay } from '../subtitle-display.ts';
import type { BatchRenderNarrationSegment } from './batch-renderer.ts';

/**
 * 口播路径字幕切分:对齐句段是 splitScript 的原始整句(带标点),
 * 这里与估算路径一样经 splitNarrationForDisplay 清洗标点并按 ≤16 字切分。
 * 句段边界是字幕对齐给出的真实时间,段内各 cue 按 displayText 去空白后的
 * 字数权重在该窗口内比例分配(与 allocator 估算路径同款逻辑)。
 */
export function buildBatchNarrationSubtitleCues(segments: BatchRenderNarrationSegment[]): BatchRenderNarrationSegment[] {
  return segments.flatMap((segment) => {
    if (!segment.text.trim()) return [];
    const parts = splitNarrationForDisplay(segment.text, { maxContentCharacters: 16 });
    if (parts.length === 0) return [];
    const weights = parts.map((part) => Math.max(1, Array.from(part.displayText.replace(/\s+/gu, '')).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const durationUs = segment.endUs - segment.startUs;
    let cursorUs = segment.startUs;
    return parts.map((part, index) => {
      const endUs = index === parts.length - 1
        ? segment.endUs
        : Math.max(cursorUs + 1, Math.round(cursorUs + durationUs * weights[index]! / totalWeight));
      const cue: BatchRenderNarrationSegment = {
        id: `${segment.id}:cue:${index + 1}`,
        sourceSegmentId: segment.sourceSegmentId,
        text: part.displayText,
        startUs: cursorUs,
        endUs,
      };
      cursorUs = endUs;
      return cue;
    });
  });
}
