import type { FinalEditCommand } from '@/lib/final-edit/workspace';

type WithoutVariantCommandEnvelope<T> = T extends unknown
  ? Omit<T, 'scope' | 'variantId' | 'expectedRevision'>
  : never;

type WithoutGroupCommandEnvelope<T> = T extends unknown
  ? Omit<T, 'scope' | 'groupId' | 'expectedRevision'>
  : never;

export type VariantCommandInput = WithoutVariantCommandEnvelope<Extract<FinalEditCommand, { scope: 'variant' }>>;
export type GroupCommandInput = WithoutGroupCommandEnvelope<Extract<FinalEditCommand, { scope: 'group' }>>;
