/**
 * 生成节点提示词的 @ 素材自动补全纯逻辑。
 *
 * 与保存/校验期的事后解析（graph.ts 的 /@参考(\d+)/g）不同，这里服务输入期：
 * 光标落在 `@查询词` 上时给出候选，选中后把查询段替换为规范的 `@参考N `。
 */

export interface MentionQuery {
  /** `@` 在文本中的下标（替换时从这里截断）。 */
  start: number;
  /** `@` 之后、光标之前的查询串（不含 @，可含中文）。 */
  query: string;
}

export interface MentionCandidate {
  /** 来源节点 id。 */
  nodeId: string;
  /** 节点标题（匹配与展示用）。 */
  title: string;
  /** 已连接时的引用编号；未连接为 null。 */
  label: number | null;
}

/** 查询词允许出现的字符：中英文、数字、下划线；遇到空白/换行即认为 token 结束。 */
const QUERY_CHAR = /[\p{Script=Han}\w]/u;

/**
 * 光标位于 `@xxx` token 内（`@` 前是行首或空白）时返回活跃查询，否则 null。
 * caret 以 UTF-16 code unit 计（与 textarea.selectionStart 一致）。
 */
export function findActiveMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // `@` 前必须是行首或空白，避免把邮箱等文本误判为引用
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  const query = before.slice(at + 1);
  // 查询段不允许出现空白/换行或非词字符（出现即说明 token 已结束）
  for (const ch of query) {
    if (!QUERY_CHAR.test(ch)) return null;
  }
  return { start: at, query };
}

/** 按标题或 `参考N` 形式做不区分大小写子串匹配；空查询返回全部。 */
export function filterMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) => {
    const title = candidate.title.toLowerCase();
    if (title.includes(needle)) return true;
    if (candidate.label !== null && `参考${candidate.label}`.includes(needle)) return true;
    return false;
  });
}

/**
 * 把 `[start, caret)` 的 `@查询` 段替换为 `@参考{label} `（带一个尾随空格），
 * 返回新文本与替换后光标应在的位置（尾随空格之后）。
 */
export function replaceMentionWithLabel(
  text: string,
  start: number,
  caret: number,
  label: number,
): { text: string; caret: number } {
  const mention = `@参考${label} `;
  const next = text.slice(0, start) + mention + text.slice(caret);
  return { text: next, caret: start + mention.length };
}
