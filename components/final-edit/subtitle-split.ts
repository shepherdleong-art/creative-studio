import type { SubtitleCue } from '../../lib/final-edit/types.ts';
import { splitTimeAtNearestFrame } from '../../lib/final-edit/frame-time.ts';
import { splitSubtitleTextOnHardWhitespace } from '../../lib/subtitle-display.ts';

export interface SubtitleCueSplitPlan {
  splitUs: number;
  leftText: string;
  rightText: string;
}

function nearestHardWhitespaceSplit(text: string, targetRatio: number): Pick<SubtitleCueSplitPlan, 'leftText' | 'rightText'> | null {
  const parts = splitSubtitleTextOnHardWhitespace(text);
  if (parts.length < 2) return null;
  const weights = parts.map((part) => Math.max(1, Array.from(part).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const targetWeight = Math.max(0, Math.min(1, targetRatio)) * totalWeight;
  let consumed = 0;
  let bestBoundary = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < parts.length; index += 1) {
    consumed += weights[index - 1];
    const distance = Math.abs(consumed - targetWeight);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestBoundary = index;
    }
  }
  return {
    leftText: parts.slice(0, bestBoundary).join(' '),
    rightText: parts.slice(bestBoundary).join(' '),
  };
}

function proportionalCharacterSplit(text: string, targetRatio: number): Pick<SubtitleCueSplitPlan, 'leftText' | 'rightText'> | null {
  const characters = Array.from(text.trim());
  if (characters.length < 2) return null;
  const cut = Math.max(1, Math.min(characters.length - 1, Math.round(targetRatio * characters.length)));
  const leftText = characters.slice(0, cut).join('').trim();
  const rightText = characters.slice(cut).join('').trim();
  return leftText && rightText ? { leftText, rightText } : null;
}

export function planSubtitleCueSplit({ cue, requestedSplitUs, fps }: {
  cue: SubtitleCue;
  requestedSplitUs: number;
  fps: number;
}): SubtitleCueSplitPlan | null {
  if (!Number.isFinite(requestedSplitUs) || !Number.isFinite(fps) || fps <= 0 || cue.endUs <= cue.startUs) return null;
  const targetRatio = (requestedSplitUs - cue.startUs) / (cue.endUs - cue.startUs);
  const splitUs = splitTimeAtNearestFrame(cue.startUs, cue.endUs, requestedSplitUs, fps);
  if (splitUs == null) return null;
  const textPlan = nearestHardWhitespaceSplit(cue.text, targetRatio)
    || proportionalCharacterSplit(cue.text, targetRatio);
  return textPlan ? { splitUs, ...textPlan } : null;
}
