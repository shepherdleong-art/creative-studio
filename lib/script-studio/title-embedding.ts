/**
 * 标题埋词约束（方案 §2.6 / Phase 6）：
 * - 内部脚本 `title` 必须包含统一名称，并自然包含至少 1 个、最多 2 个该知识条目的搜索词；
 * - `coverTitleParts.primary + secondary` 作为一组共同满足同样约束；
 * - 未匹配知识库时不启用埋词门禁，完全沿用现有标题生成和兜底逻辑。
 * 归一化：NFKC + 去空白 + 小写，用 includes 判断，保证服务端校验与生成提示一致。
 * 计数口径是「命中几个搜索词概念」而不是子串命中次数：
 * - 归一化后不含任何文字/数字的词（如目录数据残留的孤立 “#”）不参与计数；
 * - 命中词互相包含时只保留最长者（「储物床」⊂「储物床推荐」算一个概念）。
 * 否则统一名称里天然包含的词根会重复占配额，「必须含统一名称」与「最多 2 个」互相矛盾，
 * 门禁对该条目永远无法通过（PC615/PC669 真实数据即如此）。
 */

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

/** 检查一组标题文本是否满足「统一名称 + 1-2 个搜索词」。 */
function checkGroup(
  label: string,
  text: string,
  context: TitleEmbeddingContext,
): { issues: string[]; searchTermsUsed: string[] } {
  const issues: string[] = [];
  if (context.matchStatus !== 'matched') return { issues, searchTermsUsed: [] };
  const canonicalName = context.canonicalName || '';
  const terms = effectiveSearchTerms(context.searchTerms || []);
  const normalizedText = normalize(text);
  const nameOk = canonicalName && normalizedText.includes(normalize(canonicalName));
  if (!nameOk) issues.push(`title_embedding_${label}_missing_name`);
  const used = matchedSearchTerms(text, terms);
  // 词表清洗后为空时只约束统一名称：不存在可命中的搜索词，不得让门禁永远无法通过。
  if (terms.length > 0) {
    if (used.length < 1) issues.push(`title_embedding_${label}_missing_search_term`);
    if (used.length > 2) issues.push(`title_embedding_${label}_too_many_search_terms`);
  }
  return { issues, searchTermsUsed: used };
}

/**
 * 内部标题与封面标题组合必须各自满足埋词约束（title 一组、cover 一组）。
 * 只返回校验结果，不修改内容；searchTermsUsed 由调用方写回 content。
 */
export function checkTitleEmbedding(
  context: TitleEmbeddingContext,
  title: string,
  coverCombined: string,
): TitleEmbeddingCheck {
  if (context.matchStatus !== 'matched') return { ok: true, issues: [], searchTermsUsed: [] };
  const titleResult = checkGroup('title', title, context);
  const coverResult = checkGroup('cover', coverCombined, context);
  const issues = [...titleResult.issues, ...coverResult.issues];
  // 记录实际命中的搜索词（title 与 cover 并集，供写回与展示）。
  const searchTermsUsed = Array.from(new Set([...titleResult.searchTermsUsed, ...coverResult.searchTermsUsed]));
  return { ok: issues.length === 0, issues, searchTermsUsed };
}

export function embeddingRequirementText(context: TitleEmbeddingContext): string | null {
  if (context.matchStatus !== 'matched') return null;
  const terms = effectiveSearchTerms(context.searchTerms || []);
  if (terms.length === 0) {
    return `标题埋词约束：内部标题必须包含「${context.canonicalName}」；封面主副标题合并后同样包含该统一名称，不要求主副标题各自重复。`;
  }
  return `标题埋词约束：内部标题必须包含「${context.canonicalName}」并自然包含 1-2 个搜索词（${terms.join('、')}）；封面主副标题合并后同样满足这一约束，不要求主副标题各自重复。`;
}
