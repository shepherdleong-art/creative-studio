/**
 * 导入文本归一与表头语义匹配（方案 §2.6 / §6.2）。
 * 表头按语义关键词匹配，不按固定列号，也不依赖黄色填充色。
 */

/** 单元格值 → 文本：兼容 exceljs 的富文本对象（{ richText: [...] }）、公式结果与超链接文本。 */
export function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText.map((run) => (run && typeof run === 'object' && (run as { text?: unknown }).text != null ? String((run as { text?: unknown }).text) : '')).join('');
    }
    if (typeof record.text === 'string') return record.text;
    if (typeof record.result === 'string') return record.result;
    // exceljs 对空白单元格返回空对象 {}，按空串处理
    if (Object.keys(record).length === 0) return '';
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return String(value);
}

/** NFKC + 首尾/连续空白归一。 */
export function normalizeText(value: unknown): string {
  return cellText(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** 型号键归一：NFKC + 首尾/连续空白 + ASCII 大小写归一。 */
export function normalizeModelKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

/** 换行折叠为空格，用于单行展示。保留原字符（含全角标点），只做空白折叠。 */
export function collapseNewlines(value: unknown): string {
  return cellText(value).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 拆项：按换行/逗号/分号/顿号/斜杠拆成非空、去重、保留首次出现顺序的列表。 */
export function splitItems(value: unknown): string[] {
  const raw = cellText(value).normalize('NFKC');
  const parts = raw.split(/[\r\n,，;；、/|]+/).map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    if (!seen.has(part)) { seen.add(part); result.push(part); }
  }
  return result;
}

/**
 * 搜索词拆项：除常规分隔符外，还在 `#` 标签边界拆（如
 * 「场景词：#客厅#软装搭配\n风格词：#意式极简」→ `#客厅`、`#软装搭配`、`#意式极简`），
 * 丢弃「场景词：/风格词：/攻略词：」这类标签前缀。
 */
export function splitSearchTerms(value: unknown): string[] {
  const raw = cellText(value).normalize('NFKC');
  const seen = new Set<string>();
  const result: string[] = [];
  const push = (term: string) => {
    const trimmed = term.trim().replace(/\s+/g, ' ');
    if (!trimmed || /^[：:；;、，,]+$/.test(trimmed)) return;
    if (!seen.has(trimmed)) { seen.add(trimmed); result.push(trimmed); }
  };
  for (const piece of raw.split(/[\r\n,，;；、/|]+/)) {
    if (!piece.includes('#')) {
      const trimmed = piece.trim();
      if (trimmed) push(trimmed);
      continue;
    }
    // 含 # 的行拆成「标签前缀 + #词」；丢弃不含 # 的标签前缀
    for (const part of piece.split(/(?=#)/)) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) {
        // # 词在空白/标签冒号/顿号处截断，避免带上「风格词：」这类尾随标签
        const clean = trimmed.split(/[\s：:，,、；;]+/)[0]!.trim();
        if (clean) push(clean);
      }
    }
  }
  return result;
}

/** 表头关键词匹配：value 包含任一 keyword 即命中。 */
export function headerMatches(value: unknown, keywords: string[]): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  return keywords.some((keyword) => text.includes(keyword));
}

export interface HeaderColumn {
  index: number;
  letter: string;
  value: string;
  row: number;
}

/**
 * 在给定表头行内按语义关键词匹配列，返回命中的列。`expected` 数组里每个元素
 * 是 { key, keywords, required }。未匹配的必填列会写入 `unmapped`。
 */
export function matchHeaderColumns(
  headerRowCells: Array<{ index: number; value: unknown }>,
  expected: Array<{ key: string; keywords: string[]; required: boolean }>,
  sheetRowNumber: number,
): { columns: Record<string, number>; unmapped: Array<{ column: string; value: string; row: number }> } {
  const columns: Record<string, number> = {};
  const unmapped: Array<{ column: string; value: string; row: number }> = [];
  for (const { key, keywords, required } of expected) {
    const hit = headerRowCells.find((cell) => headerMatches(cell.value, keywords));
    if (hit) {
      columns[key] = hit.index;
    } else if (required) {
      unmapped.push({ column: key, value: `缺少「${keywords.join('/')}」表头`, row: sheetRowNumber });
    }
  }
  return { columns, unmapped };
}

/** 合并单元格「所属分组向下继承」：构建 (row, col) → 左上角坐标 的映射。 */
export function buildMergedDownfill(ranges: Array<{ top: number; left: number; bottom: number; right: number }>): Map<string, { row: number; col: number }> {
  const map = new Map<string, { row: number; col: number }>();
  for (const range of ranges) {
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let col = range.left; col <= range.right; col += 1) {
        map.set(`${row}:${col}`, { row: range.top, col: range.left });
      }
    }
  }
  return map;
}
