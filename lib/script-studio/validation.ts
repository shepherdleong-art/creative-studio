import { painContentIssues } from './pain-solving.ts';
import {
  buildScriptDurationBudget,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from '../script-duration-policy.ts';
import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';
import type { LibraryRevisionView } from './libraries.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import { checkTitleEmbedding, type TitleEmbeddingCheck, type TitleEmbeddingContext } from './title-embedding.ts';
import { checkScriptTitles, type ScriptTitleContext, type ScriptTitleIssue, type ScriptTitleSummary } from './title-policy.ts';
import type { ScriptStudioScriptContent } from './types.ts';

export interface ScriptValidationResult {
  ok: boolean;
  issues: string[];
  content: ScriptStudioScriptContent;
  estimatedDurationSec: number;
  contentCharacterCount: number;
  /**
   * 软时长目标（方案 §2.3）：时长偏离预算只作提示（duration_too_short / duration_too_long），
   * 不进入阻断性 issues，不能单独触发重试耗尽或保存失败；content.durationStatus 如实计算。
   */
  durationHints: string[];
  /** 兼容字段：统计自然命中的搜索词，不再作为标题门禁。 */
  titleEmbedding?: TitleEmbeddingCheck;
  titleIssues: ScriptTitleIssue[];
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
    siblingScripts?: Array<Pick<ScriptStudioScriptContent, 'fullScript'> & ScriptTitleSummary>;
    previousTitles?: ScriptTitleSummary[];
    titleContext?: ScriptTitleContext;
    /** 兼容旧调用方的搜索词统计上下文，不执行强制埋词。 */
    titleEmbeddingContext?: TitleEmbeddingContext;
  },
): ScriptValidationResult {
  const issues: string[] = painContentIssues(input);
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
  const titleIssues = checkScriptTitles(input, {
    libraryRevision: options.libraryRevision,
    context: options.titleContext,
    previousTitles: [...(options.siblingScripts || []), ...(options.previousTitles || [])],
  });
  issues.push(...titleIssues.map((issue) => issue.code));
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
  // 软时长目标：偏离预算只记提示，不阻断保存（如实反映在 content.durationStatus）。
  const durationHints: string[] = [];
  if (contentCharacterCount < budget.minContentCharacters) durationHints.push('duration_too_short');
  if (contentCharacterCount > budget.maxContentCharacters) durationHints.push('duration_too_long');
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
    durationHints,
    titleIssues,
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
  detail?: { searchTermsUsed?: string[]; titleIssues?: ScriptTitleIssue[] },
): string[] {
  const staticMap: Record<string, string> = {
    title_required: '缺少内部标题',
    cover_title_required: '缺少封面主标题或副标题',
    duplicate_title: '脚本标题与同批或近期项目标题重复',
    duplicate_cover_combo: '封面主副标题组合与同批或近期项目封面组合重复',
    duration_too_short: '口播字数低于目标时长预算（仅提示，不阻止保存）',
    duration_too_long: '口播字数超出目标时长预算（仅提示，可保存偏长候选）',
    duplicate_script: '与本次其他方案过于相似',
    selling_point_refs_required: '口播未引用任何已核验卖点',
    segments_required: '缺少口播分段',
    ending_bare_selling_point: '结尾是孤立卖点标签，必须改为承接正文的 CTA 行动引导',
    cta_ending_missing: '最后一句缺少行动邀请（CTA），须以邀请了解/比较/挑选等具体行动收尾',
    cta_channel_unconfirmed: '最后一句使用了未确认的渠道或促销表述（私信/链接/下单/优惠等），只允许了解/比较等通用引导',
  };
  return [...new Set(issues)].map((issue) => {
    const titleDetails = detail?.titleIssues?.filter((item) => item.code === issue);
    if (titleDetails?.length) return titleDetails.map((item) => item.message).join("；");
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
