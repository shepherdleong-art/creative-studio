import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from './final-edit/types.ts';

export const SCRIPT_DURATION_POLICY_VERSION = 'zh-tts-budget-v1' as const;
export const SCRIPT_DURATION_OPTIONS = [15, 20, 30, 45, 60] as const;
export const SCRIPT_CALIBRATED_CHARS_PER_SECOND = 4.2;

export interface ScriptDurationBudget {
  targetTotalSec: number;
  introDurationSec: number;
  targetNarrationSec: number;
  minEstimatedNarrationSec: number;
  maxEstimatedNarrationSec: number;
  minContentCharacters: number;
  maxContentCharacters: number;
  calibratedCharsPerSecond: number;
  policyVersion: typeof SCRIPT_DURATION_POLICY_VERSION;
}

export function countScriptContentCharacters(value: string): number {
  return Array.from(value).filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

export function estimateNarrationDurationSec(contentCharacterCount: number): number {
  return Math.max(0, contentCharacterCount) / SCRIPT_CALIBRATED_CHARS_PER_SECOND;
}

export function buildScriptDurationBudget(targetTotalSec: number): ScriptDurationBudget {
  if (!SCRIPT_DURATION_OPTIONS.includes(targetTotalSec as (typeof SCRIPT_DURATION_OPTIONS)[number])) {
    throw new Error('unsupported_script_duration');
  }
  const introDurationSec = FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS;
  const targetNarrationSec = targetTotalSec - introDurationSec;
  const minEstimatedNarrationSec = targetNarrationSec * 0.9;
  const maxEstimatedNarrationSec = targetNarrationSec;
  return {
    targetTotalSec,
    introDurationSec,
    targetNarrationSec,
    minEstimatedNarrationSec,
    maxEstimatedNarrationSec,
    minContentCharacters: Math.ceil(minEstimatedNarrationSec * SCRIPT_CALIBRATED_CHARS_PER_SECOND),
    maxContentCharacters: Math.floor(maxEstimatedNarrationSec * SCRIPT_CALIBRATED_CHARS_PER_SECOND),
    calibratedCharsPerSecond: SCRIPT_CALIBRATED_CHARS_PER_SECOND,
    policyVersion: SCRIPT_DURATION_POLICY_VERSION,
  };
}

export const SCRIPT_DURATION_BUDGETS = Object.fromEntries(
  SCRIPT_DURATION_OPTIONS.map((duration) => [duration, buildScriptDurationBudget(duration)]),
) as Record<(typeof SCRIPT_DURATION_OPTIONS)[number], ScriptDurationBudget>;
