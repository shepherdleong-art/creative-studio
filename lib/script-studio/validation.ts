import {
  buildScriptDurationBudget,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from '../script-duration-policy.ts';
import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import type { LibraryRevisionView } from './libraries.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import type { ScriptStudioScriptContent } from './types.ts';

export interface ScriptValidationResult {
  ok: boolean;
  issues: string[];
  content: ScriptStudioScriptContent;
  estimatedDurationSec: number;
  contentCharacterCount: number;
}

const DUPLICATE_THRESHOLD = 0.82;

function normalizeDedupeText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

function similarity(left: string, right: string): number {
  const a = new Set(Array.from(left));
  const b = new Set(Array.from(right));
  if (a.size === 0 || b.size === 0) return left === right ? 1 : 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function isSimpleDuplicate(left: string, right: string): boolean {
  const a = normalizeDedupeText(left);
  const b = normalizeDedupeText(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 8 && longer.includes(shorter)) return true;
  return similarity(a, b) >= DUPLICATE_THRESHOLD;
}

export function validateScriptContent(
  input: ScriptStudioScriptContent,
  options: {
    libraryRevision: LibraryRevisionView;
    siblingScripts?: Array<Pick<ScriptStudioScriptContent, 'fullScript'>>;
  },
): ScriptValidationResult {
  const issues: string[] = [];
  // 引用白名单与生成边界一致 fail closed：证据失败卖点即使被重新打开也不算可用。
  const usableIds = new Set(
    options.libraryRevision.sellingPoints
      .filter(isSellingPointEvidenceUsable)
      .map((point) => point.id),
  );
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const fullScript = input.segments.map((segment) => segment.narration).join('\n').trim();
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  const estimatedDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  if (!input.title.trim()) issues.push('title_required');
  if (!input.coverTitleParts?.primary?.trim() || !input.coverTitleParts?.secondary?.trim()) {
    issues.push('cover_title_required');
  }
  if (!input.segments.length) issues.push('segments_required');
  if (contentCharacterCount < budget.minContentCharacters) issues.push('duration_too_short');
  if (contentCharacterCount > budget.maxContentCharacters) issues.push('duration_too_long');
  for (const segment of input.segments) {
    if (!segment.narration.trim()) issues.push(`segment_empty:${segment.id}`);
    for (const pointId of segment.sellingPointIdRefs || []) {
      if (!usableIds.has(pointId)) issues.push(`unknown_selling_point:${pointId}`);
    }
    for (const keyword of segment.visualKeywords || []) {
      if (!keyword.trim()) issues.push(`empty_visual_keyword:${segment.id}`);
    }
  }
  // 口播必须落在已核验事实上：整条脚本至少引用一条卖点，零引用不得通过。
  const referencedIds = new Set(input.segments.flatMap((segment) => segment.sellingPointIdRefs || []));
  if (referencedIds.size === 0) issues.push('selling_point_refs_required');
  for (const usage of input.sellingPointUsage || []) {
    if (usage.status === 'used' && !usableIds.has(usage.sellingPointId)) {
      issues.push(`used_unusable_selling_point:${usage.sellingPointId}`);
    }
  }
  const content = {
    ...input,
    fullScript,
    fullSubtitle: input.segments.map((segment) => normalizeAutomaticSubtitleText(segment.narration)).join('\n'),
    contentCharacterCount,
    estimatedNarrationDurationSec: estimatedDurationSec,
    targetNarrationDurationSec: budget.targetNarrationSec,
    durationStatus: contentCharacterCount < budget.minContentCharacters
      ? 'too_short' as const
      : contentCharacterCount > budget.maxContentCharacters
        ? 'too_long' as const
        : 'qualified' as const,
  };
  for (const sibling of options.siblingScripts || []) {
    if (isSimpleDuplicate(content.fullScript, sibling.fullScript || '')) {
      issues.push('duplicate_script');
      break;
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    content,
    estimatedDurationSec,
    contentCharacterCount,
  };
}

export function requiredDurationOptions(): Array<15 | 20 | 30 | 45 | 60> {
  return [15, 20, 30, 45, 60];
}
