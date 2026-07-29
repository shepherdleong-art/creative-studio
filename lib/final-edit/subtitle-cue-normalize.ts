import { countScriptContentCharacters } from '../script-duration-policy.ts';
import { splitSubtitleTextOnHardWhitespace } from '../subtitle-display.ts';
import { firstFrameAtOrAfter, frameToUs, lastFrameAtOrBefore, minimumFrameDurationUs } from './frame-time.ts';
import { FINAL_EDIT_FPS, type SubtitleCue } from './types.ts';

interface CueSplitPlan {
  parts: string[];
  boundariesUs: number[];
}

function buildCueSplitPlan(cue: SubtitleCue): CueSplitPlan | null {
  if (cue.textSource !== 'script' || cue.timingSource === 'manual') return null;
  const parts = splitSubtitleTextOnHardWhitespace(cue.text);
  if (parts.length < 2 || cue.endUs <= cue.startUs) return null;

  const minimumUs = minimumFrameDurationUs(FINAL_EDIT_FPS);
  const firstBoundaryFrame = firstFrameAtOrAfter(cue.startUs + minimumUs, FINAL_EDIT_FPS);
  const lastBoundaryFrame = lastFrameAtOrBefore(cue.endUs - minimumUs, FINAL_EDIT_FPS);
  if (lastBoundaryFrame - firstBoundaryFrame + 1 < parts.length - 1) return null;

  const weights = parts.map((part) => Math.max(1, countScriptContentCharacters(part)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const boundariesUs: number[] = [];
  let consumedWeight = 0;
  let previousBoundaryFrame = firstBoundaryFrame - 1;
  for (let index = 0; index < parts.length - 1; index += 1) {
    consumedWeight += weights[index];
    const remainingBoundaries = parts.length - index - 2;
    const targetUs = cue.startUs + (cue.endUs - cue.startUs) * consumedWeight / totalWeight;
    const targetFrame = Math.round(targetUs * FINAL_EDIT_FPS / 1_000_000);
    const boundaryFrame = Math.max(
      index === 0 ? firstBoundaryFrame : previousBoundaryFrame + 1,
      Math.min(lastBoundaryFrame - remainingBoundaries, targetFrame),
    );
    boundariesUs.push(frameToUs(boundaryFrame, FINAL_EDIT_FPS));
    previousBoundaryFrame = boundaryFrame;
  }
  return { parts, boundariesUs };
}

export function hasLegacyAutomaticSubtitleCuesToNormalize(cues: readonly SubtitleCue[]): boolean {
  return cues.some((cue) => buildCueSplitPlan(cue) != null);
}

export function normalizeLegacyAutomaticSubtitleCues(
  cues: readonly SubtitleCue[],
  createId: () => string,
): SubtitleCue[] {
  return cues.flatMap((cue) => {
    const plan = buildCueSplitPlan(cue);
    if (!plan) return [cue];
    return plan.parts.map((text, index) => ({
      ...cue,
      id: index === 0 ? cue.id : createId(),
      text,
      startUs: index === 0 ? cue.startUs : plan.boundariesUs[index - 1],
      endUs: index === plan.parts.length - 1 ? cue.endUs : plan.boundariesUs[index],
      textSource: 'script',
      timingSource: 'proportional',
    }));
  });
}
