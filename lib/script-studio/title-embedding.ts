/** 搜索词统计的兼容入口。搜索词属于独立知识上下文，不再约束脚本/封面标题。 */

export interface TitleEmbeddingContext {
  matchStatus: 'matched' | 'unmatched';
  canonicalName: string | null;
  searchTerms: string[];
}

export interface TitleEmbeddingCheck {
  ok: boolean;
  /** 未通过的校验项（用于验证器 issues）。 */
  issues: string[];
  /** 本次文本实际命中的搜索词（写回 content.knowledgeContext.searchTermsUsed）。 */
  searchTermsUsed: string[];
}

function normalize(value: string): string {
  return (value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 有效搜索词：归一化后必须含文字或数字；孤立的 “#” 等无检索语义残留不参与埋词。 */
function isEffectiveTerm(normalizedTerm: string): boolean {
  return /[\p{L}\p{N}]/u.test(normalizedTerm);
}

/** 参与埋词的搜索词表：过滤无语义残留并按归一化结果去重，保留首次出现顺序。 */
export function effectiveSearchTerms(searchTerms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of searchTerms || []) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm || !isEffectiveTerm(normalizedTerm) || seen.has(normalizedTerm)) continue;
    seen.add(normalizedTerm);
    result.push(term);
  }
  return result;
}

/**
 * 计算文本中命中的搜索词概念（去重，按输入顺序）。
 * 命中词互相包含时只保留最长者：同一词根的派生写法是一个埋词概念，不按子串重复计数。
 */
export function matchedSearchTerms(text: string, searchTerms: string[]): string[] {
  const haystack = normalize(text);
  if (!haystack) return [];
  const matched: Array<{ term: string; normalized: string }> = [];
  for (const term of effectiveSearchTerms(searchTerms)) {
    const normalizedTerm = normalize(term);
    if (haystack.includes(normalizedTerm)) matched.push({ term, normalized: normalizedTerm });
  }
  return matched
    .filter((item) => !matched.some((other) => other.normalized !== item.normalized && other.normalized.includes(item.normalized)))
    .map((item) => item.term);
}

/** 兼容历史调用方：记录自然命中的搜索词，不要求标题包含名称或搜索词。 */
export function checkTitleEmbedding(
  context: TitleEmbeddingContext,
  title: string,
  coverCombined: string,
): TitleEmbeddingCheck {
  const searchTermsUsed = context.matchStatus === 'matched'
    ? Array.from(new Set([...matchedSearchTerms(title, context.searchTerms), ...matchedSearchTerms(coverCombined, context.searchTerms)]))
    : [];
  return { ok: true, issues: [], searchTermsUsed };
}

export function embeddingRequirementText(context: TitleEmbeddingContext): string | null {
  if (context.matchStatus !== 'matched') return null;
  return '知识库中的搜索词单独保留，不要求标题或封面包含统一名称、型号或搜索词。';
}
