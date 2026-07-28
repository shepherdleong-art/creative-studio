import { FINAL_EDIT_INTRO_DURATION_US } from './types.ts';

export interface DurationGateEvaluation {
  targetTotalUs: number;
  targetNarrationUs: number;
  actualNarrationUs: number;
  actualTotalUs: number;
  toleranceUs: number;
  deltaUs: number;
  status: 'within_tolerance' | 'too_short' | 'too_long';
}

export interface FinalEditDurationGateStateV1 {
  version: 1;
  narrationHash: string;
  targetTotalUs: number;
  targetNarrationUs: number;
  actualNarrationUs: number;
  actualTotalUs: number;
  toleranceUs: number;
  deltaUs: number;
  status: 'unchecked' | 'within_tolerance' | 'needs_input' | 'accepted_actual';
  reason: 'too_short' | 'too_long' | null;
  smartFitAttempts: 0 | 1;
  checkedAt: string | null;
  acceptedAt: string | null;
}

export function evaluateFinalDurationGate(input: {
  targetTotalSec: number;
  actualNarrationUs: number;
}): DurationGateEvaluation {
  const targetTotalUs = Math.round(input.targetTotalSec * 1_000_000);
  const targetNarrationUs = Math.max(0, targetTotalUs - FINAL_EDIT_INTRO_DURATION_US);
  const actualNarrationUs = Math.max(0, Math.round(input.actualNarrationUs));
  const actualTotalUs = FINAL_EDIT_INTRO_DURATION_US + actualNarrationUs;
  const toleranceUs = Math.max(500_000, Math.round(targetTotalUs * 0.05));
  const deltaUs = actualTotalUs - targetTotalUs;
  const status = Math.abs(deltaUs) <= toleranceUs
    ? 'within_tolerance'
    : deltaUs < 0 ? 'too_short' : 'too_long';
  return { targetTotalUs, targetNarrationUs, actualNarrationUs, actualTotalUs, toleranceUs, deltaUs, status };
}

export function createUncheckedDurationGateState(input: {
  narrationHash: string;
  targetTotalSec: number;
  smartFitAttempts?: 0 | 1;
}): FinalEditDurationGateStateV1 {
  const evaluation = evaluateFinalDurationGate({ targetTotalSec: input.targetTotalSec, actualNarrationUs: 0 });
  return {
    version: 1,
    narrationHash: input.narrationHash,
    targetTotalUs: evaluation.targetTotalUs,
    targetNarrationUs: evaluation.targetNarrationUs,
    actualNarrationUs: 0,
    actualTotalUs: 0,
    toleranceUs: evaluation.toleranceUs,
    deltaUs: 0,
    status: 'unchecked',
    reason: null,
    smartFitAttempts: input.smartFitAttempts || 0,
    checkedAt: null,
    acceptedAt: null,
  };
}

export function parseDurationGateState(value: unknown): FinalEditDurationGateStateV1 | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const state = parsed as Partial<FinalEditDurationGateStateV1>;
    if (state.version !== 1 || typeof state.narrationHash !== 'string') return null;
    if (!['unchecked', 'within_tolerance', 'needs_input', 'accepted_actual'].includes(String(state.status))) return null;
    return state as FinalEditDurationGateStateV1;
  } catch {
    return null;
  }
}

export function acceptedDurationGateMatchesNarration(
  state: FinalEditDurationGateStateV1 | null,
  narrationHash: string,
): boolean {
  return state?.status === 'accepted_actual' && state.narrationHash === narrationHash;
}

export function stateFromDurationEvaluation(input: {
  narrationHash: string;
  evaluation: DurationGateEvaluation;
  smartFitAttempts?: 0 | 1;
  checkedAt?: string;
}): FinalEditDurationGateStateV1 {
  const { evaluation } = input;
  return {
    version: 1,
    narrationHash: input.narrationHash,
    targetTotalUs: evaluation.targetTotalUs,
    targetNarrationUs: evaluation.targetNarrationUs,
    actualNarrationUs: evaluation.actualNarrationUs,
    actualTotalUs: evaluation.actualTotalUs,
    toleranceUs: evaluation.toleranceUs,
    deltaUs: evaluation.deltaUs,
    status: evaluation.status === 'within_tolerance' ? 'within_tolerance' : 'needs_input',
    reason: evaluation.status === 'within_tolerance' ? null : evaluation.status,
    smartFitAttempts: input.smartFitAttempts || 0,
    checkedAt: input.checkedAt || new Date().toISOString(),
    acceptedAt: null,
  };
}
