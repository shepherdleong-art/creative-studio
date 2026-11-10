export type UnifiedTaskCostStatus =
  | 'settled'
  | 'estimated'
  | 'uncertain'
  | 'unpriced'
  | 'released'
  | 'mixed';

export interface UnifiedCostAttempt {
  costStatus: 'settled' | 'estimated' | 'uncertain' | 'unpriced' | 'released';
  reservedMinor: number;
  actualMinor: number | null;
}

export interface UnifiedCostSummary {
  chargedMinor: number;
  settledMinor: number;
  estimatedMinor: number;
  uncertainMinor: number;
  unpricedCount: number;
  uncertainCount: number;
  releasedCount: number;
  costStatus: UnifiedTaskCostStatus;
}

/**
 * One task can contain multiple real channel attempts. Released attempts do
 * not become a confirmed zero-price success; unknown/unpriced evidence is
 * surfaced as uncertain and the aggregate keeps every known amount.
 */
export function summarizeUnifiedAttemptCosts(attempts: readonly UnifiedCostAttempt[]): UnifiedCostSummary {
  let settledMinor = 0;
  let estimatedMinor = 0;
  let uncertainMinor = 0;
  let unpricedCount = 0;
  let uncertainCount = 0;
  let releasedCount = 0;
  let hasSettled = false;
  let hasEstimated = false;
  let hasUncertain = false;
  let hasUnpriced = false;

  for (const attempt of attempts) {
    if (attempt.costStatus === 'released') {
      releasedCount += 1;
      continue;
    }
    if (attempt.costStatus === 'settled') {
      hasSettled = true;
      settledMinor += attempt.actualMinor ?? 0;
      continue;
    }
    if (attempt.costStatus === 'estimated') {
      hasEstimated = true;
      estimatedMinor += attempt.reservedMinor;
      continue;
    }
    if (attempt.costStatus === 'uncertain') {
      hasUncertain = true;
      uncertainCount += 1;
      uncertainMinor += attempt.reservedMinor;
      continue;
    }
    hasUnpriced = true;
    unpricedCount += 1;
  }

  const activeKinds = [hasSettled, hasEstimated, hasUncertain, hasUnpriced].filter(Boolean).length;
  const costStatus: UnifiedTaskCostStatus = attempts.length === 0
    ? 'unpriced'
    : activeKinds === 0
      ? 'released'
      : hasSettled && activeKinds === 1
        ? 'settled'
        : hasEstimated && activeKinds === 1
          ? 'estimated'
          : hasUncertain && activeKinds === 1
            ? 'uncertain'
            : hasUnpriced && activeKinds === 1
              ? 'unpriced'
              : 'mixed';

  return {
    chargedMinor: settledMinor + estimatedMinor + uncertainMinor,
    settledMinor,
    estimatedMinor,
    uncertainMinor,
    unpricedCount,
    uncertainCount,
    releasedCount,
    costStatus,
  };
}

export function attemptCostStatus(input: {
  quoteKind: string;
  costState: string;
  terminalState: string | null;
  actualMinor: number | null;
}): UnifiedCostAttempt['costStatus'] {
  if (input.costState === 'released') return 'released';
  if (input.costState === 'settled' && input.actualMinor !== null) return 'settled';
  if (input.costState === 'unknown' && input.terminalState !== null) return 'uncertain';
  if (input.quoteKind === 'unpriced') return 'unpriced';
  if (input.costState === 'unknown') return 'uncertain';
  return 'estimated';
}
