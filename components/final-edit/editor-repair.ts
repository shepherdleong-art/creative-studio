import type { FinalEditGroupView } from '@/lib/final-edit/types';

const REPAIRABLE_BLOCKING_CODES = new Set(['timeline_gap', 'duplicate_cover', 'cover_missing']);

export function hasRepairableBlockingIssue(group: FinalEditGroupView, variantId: string): boolean {
  const variant = group.variants.find((item) => item.id === variantId);
  return Boolean(variant?.issues.some((issue) => issue.severity === 'blocking' && REPAIRABLE_BLOCKING_CODES.has(issue.code)));
}

export function findUnusedCoverCandidate(group: FinalEditGroupView, variantId: string): string | null {
  const usedByOtherVariants = new Set(
    group.variants
      .filter((variant) => variant.id !== variantId)
      .map((variant) => variant.cover.coverKey)
      .filter((coverKey): coverKey is string => Boolean(coverKey)),
  );
  return group.coverCandidates.find((candidate) => !usedByOtherVariants.has(candidate.coverKey))?.coverKey || null;
}
