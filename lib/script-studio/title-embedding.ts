/**
 * 标题埋词约束（方案 §2.6 / Phase 6）：
 * - 内部脚本 `title` 必须包含统一名称，并自然包含至少 1 个、最多 2 个该知识条目的搜索词；
 * - `coverTitleParts.primary + secondary` 作为一组共同满足同样约束；
 * - 未匹配知识库时不启用埋词门禁，完全沿用现有标题生成和兜底逻辑。
 * 归一化：NFKC + 去空白 + 小写，用 includes 判断，保证服务端校验与生成提示一致。
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

/** 计算文本中命中的搜索词（去重，按输入顺序）。 */
export function matchedSearchTerms(text: string, searchTerms: string[]): string[] {
  const haystack = normalize(text);
  if (!haystack) return [];
  const used: string[] = [];
  const seen = new Set<string>();
  for (const term of searchTerms) {
    const normalizedTerm = normalize(term);
    if (!normalizedTerm || seen.has(normalizedTerm)) continue;
    if (haystack.includes(normalizedTerm)) {
      used.push(term);
      seen.add(normalizedTerm);
    }
  }
  return used;
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
  const searchTerms = context.searchTerms || [];
  const normalizedText = normalize(text);
  const nameOk = canonicalName && normalizedText.includes(normalize(canonicalName));
  if (!nameOk) issues.push(`title_embedding_${label}_missing_name`);
  const used = matchedSearchTerms(text, searchTerms);
  if (used.length < 1) issues.push(`title_embedding_${label}_missing_search_term`);
  if (used.length > 2) issues.push(`title_embedding_${label}_too_many_search_terms`);
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
  const terms = (context.searchTerms || []).filter(Boolean).join('、');
  return `标题埋词约束：内部标题必须包含「${context.canonicalName}」并自然包含 1-2 个搜索词（${terms}）；封面主副标题合并后同样满足这一约束，不要求主副标题各自重复。`;
}
