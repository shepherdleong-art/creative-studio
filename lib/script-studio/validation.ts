import {
  buildScriptDurationBudget,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from '../script-duration-policy.ts';
import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import type { LibraryRevisionView } from './libraries.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { checkTitleEmbedding, type TitleEmbeddingCheck, type TitleEmbeddingContext } from './title-embedding.ts';
import type { ScriptStudioScriptContent } from './types.ts';

export interface ScriptValidationResult {
  ok: boolean;
  issues: string[];
  content: ScriptStudioScriptContent;
  estimatedDurationSec: number;
  contentCharacterCount: number;
  /** 启用埋词门禁时的判定明细（含实际命中的搜索词），用于人话化反馈。 */
  titleEmbedding?: TitleEmbeddingCheck;
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
    /** 冻结知识上下文的标题埋词约束；未提供或未匹配时不启用埋词门禁。 */
    titleEmbeddingContext?: TitleEmbeddingContext;
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
  // 匹配知识库时启用标题埋词门禁：内部标题与封面标题组合各自满足统一名称+搜索词。
  let titleEmbedding: TitleEmbeddingCheck | undefined;
  if (options.titleEmbeddingContext) {
    titleEmbedding = checkTitleEmbedding(
      options.titleEmbeddingContext,
      input.title,
      `${input.coverTitleParts?.primary ?? ''}${input.coverTitleParts?.secondary ?? ''}`,
    );
    issues.push(...titleEmbedding.issues);
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
    ...(titleEmbedding ? { titleEmbedding } : {}),
  };
}

/**
 * 把内部校验码翻译成可执行的中文描述：
 * - 重试时回喂给模型（原始错误码不说明哪个词被计数，模型无法修复）；
 * - 全部失败时作为任务错误展示给用户。
 * 未识别的码原样保留，不吞信息。
 */
export function describeValidationIssues(
  issues: string[],
  detail?: { searchTermsUsed?: string[] },
): string[] {
  const used = (detail?.searchTermsUsed || []).filter(Boolean);
  const usedText = used.length > 0 ? `（实际命中：${used.join('、')}）` : '';
  const staticMap: Record<string, string> = {
    title_required: '缺少内部标题',
    cover_title_required: '缺少封面主标题或副标题',
    title_embedding_title_missing_name: '内部标题未包含知识库统一名称',
    title_embedding_cover_missing_name: '封面主副标题合并后未包含知识库统一名称',
    title_embedding_title_missing_search_term: '内部标题未包含知识库搜索词（需自然包含 1-2 个）',
    title_embedding_cover_missing_search_term: '封面主副标题合并后未包含知识库搜索词（需自然包含 1-2 个）',
    title_embedding_title_too_many_search_terms: `内部标题命中的搜索词超过 2 个${usedText}，请删减到 1-2 个并保留统一名称`,
    title_embedding_cover_too_many_search_terms: `封面标题命中的搜索词超过 2 个${usedText}，请删减到 1-2 个并保留统一名称`,
    duration_too_short: '口播字数不足，未达到目标时长',
    duration_too_long: '口播字数超出目标时长',
    duplicate_script: '与本次其他方案过于相似',
    selling_point_refs_required: '口播未引用任何已核验卖点',
    segments_required: '缺少口播分段',
  };
  return issues.map((issue) => {
    const mapped = staticMap[issue];
    if (mapped) return mapped;
    if (issue.startsWith('segment_empty:')) return '存在内容为空的分段';
    if (issue.startsWith('unknown_selling_point:')) return '引用了方向卖点包之外的卖点';
    if (issue.startsWith('empty_visual_keyword:')) return '存在内容为空的画面关键词';
    if (issue.startsWith('used_unusable_selling_point:')) return '使用了未通过证据核验的卖点';
    return issue;
  });
}

export function requiredDurationOptions(): Array<15 | 20 | 30 | 45 | 60> {
  return [15, 20, 30, 45, 60];
}
