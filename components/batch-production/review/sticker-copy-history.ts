import type { BatchPackagingStickerSnapshot } from '../../../lib/batch-production/sticker-copy.ts';

export interface EditHistoryEntry {
  kind: 'edit';
  planId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface StickerCopyHistoryEntry {
  kind: 'sticker-copy';
  targets: Array<{
    planId: string;
    outputVersionId: string;
    currentEditRevision: number;
    before: BatchPackagingStickerSnapshot;
    after: BatchPackagingStickerSnapshot;
  }>;
}

export type ReviewHistoryEntry = EditHistoryEntry | StickerCopyHistoryEntry;
export type LocalRevisionChange = {
  planId: string;
  outputVersionId: string;
  beforeEditRevision: number;
  afterEditRevision: number;
};

/** Only advance acknowledged local edits; polling and unmatched revisions never rebase history. */
export function advanceStickerCopyHistory(stack: ReviewHistoryEntry[], changes: readonly LocalRevisionChange[]): ReviewHistoryEntry[] {
  return stack.map((entry) => entry.kind !== 'sticker-copy' ? entry : {
    ...entry,
    targets: entry.targets.map((target) => {
      const change = changes.find((item) => item.planId === target.planId
        && item.outputVersionId === target.outputVersionId
        && item.beforeEditRevision === target.currentEditRevision
        && item.afterEditRevision === item.beforeEditRevision + 1);
      return change ? { ...target, currentEditRevision: change.afterEditRevision } : target;
    }),
  });
}
