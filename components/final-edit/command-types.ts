import type { FinalEditCommand } from '@/lib/final-edit/workspace';

type WithoutCommandEnvelope<T> = T extends unknown
  ? Omit<T, 'scope' | 'variantId' | 'groupId' | 'expectedRevision'>
  : never;

export type VariantCommandInput = WithoutCommandEnvelope<Extract<FinalEditCommand, { scope: 'variant' }>>;
export type GroupCommandInput = WithoutCommandEnvelope<Extract<FinalEditCommand, { scope: 'group' }>>;
