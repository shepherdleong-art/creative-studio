import { createHash } from 'node:crypto';
import { cellText, normalizeText } from './normalize.ts';
import { effectiveValue, type WorkbookSheet } from './workbook.ts';

/**
 * 爆文模板库（种草爆文库）工作簿解析（迁移方案 §2.2 / §3.2）。
 *
 * 表契约（A–M 列，按语义表头匹配不按列号）：
 *   类目、子类目、模板名称、标题、参考文案、结构拆解、结构摘要、
 *   素材类型、使用次数、逛逛ID、商品链接、模板ID、是否私有
 * - 优先读取「全部模板」主表；主表缺失时才合并分类表并按来源模板 ID 去重
 *   （分类表是相同记录的分类副本，不能导成主表+分类表的双倍条目）。
 * - 「使用次数」不是播放量/成交量，只作原始列保留，不作为效果排名。
 * - 明显占位内容默认不可推荐（status=unusable）；疑似无效内容进入待检查
 *   （status=review），可人工调整；不按长度一刀切删除短文案（有效画面字幕可能很短）。
 */

export const VIRAL_TEMPLATE_MAIN_SHEET = '全部模板';
export const VIRAL_TEMPLATE_DEFAULT_STRUCTURE = '钩子>痛点>卖点>逼单';

export type ViralTemplateStatus = 'usable' | 'unusable' | 'review';

export interface ViralTemplateEntryParsed {
  sourceTemplateId: string;
  category: string;
  subCategory: string;
  name: string;
  title: string;
  refText: string;
  structureRaw: string;
  structureSummary: string;
  structure: string;
  structureOrigin: 'source' | 'fallback';
  rawColumns: Record<string, string>;
  sourceSheet: string;
  sourceRow: number;
  contentHash: string;
  status: ViralTemplateStatus;
  statusReason: string;
}

export interface ViralTemplateImportIssue {
  code: string;
  message: string;
}

export interface ViralTemplateImportReport {
  totalRows: number;
  validRows: number;
  mergedModelCount: number;
  issues: ViralTemplateImportIssue[];
  canActivate: boolean;
  /** 主表/分类表来源统计：sheet → 该表贡献的去重后条目数。 */
  sheetCounts: Record<string, number>;
  statusCounts: { usable: number; unusable: number; review: number };
  /** 主表缺失时为 true（走了分类表合并去重路径）。 */
  mergedCategorySheets: boolean;
}

export interface ViralTemplateParseResult {
  entries: ViralTemplateEntryParsed[];
  report: ViralTemplateImportReport;
}

const HEADERS = {
  category: ['类目'],
  subCategory: ['子类目', '子类'],
  name: ['模板名称', '名称'],
  title: ['标题'],
  refText: ['参考文案', '文案'],
  structureRaw: ['结构拆解'],
  structureSummary: ['结构摘要'],
  assetType: ['素材类型'],
  useCount: ['使用次数'],
  itemId: ['逛逛ID', '逛逛 Id', '逛逛id'],
  itemUrl: ['商品链接'],
  templateId: ['模板ID', '模板 Id', '模板id'],
  visibility: ['是否私有'],
} as const;

function findHeaderColumns(sheet: WorkbookSheet): { headerRow: number; columns: Record<string, number> } | null {
  for (const row of sheet.rows.slice(0, 5)) {
    const columns: Record<string, number> = {};
    let hits = 0;
    for (const cell of row.cells) {
      const text = normalizeText(cell.value).replace(/\s+/g, '');
      if (!text) continue;
      for (const [key, candidates] of Object.entries(HEADERS)) {
        if (columns[key] !== undefined) continue;
        if (candidates.some((candidate) => text === candidate.replace(/\s+/g, ''))) {
          columns[key] = cell.index;
          hits += 1;
        }
      }
    }
    // 必需列：参考文案 + 模板ID；类目可空但表头必须识别得出。
    if (columns.refText !== undefined && columns.templateId !== undefined && hits >= 5) {
      return { headerRow: row.rowNumber, columns };
    }
  }
  return null;
}

/** 参考文案正文部分：源表常为「标题：xxx\n正文：yyy」格式；无此前缀时整体即正文。 */
export function viralTemplateBodyText(refText: string): string {
  const text = String(refText || '').trim();
  const match = text.match(/正文[：:]\s*([\s\S]*)$/);
  if (match) return match[1].trim();
  return text;
}

/** 占位词：明显无信息内容（归一化后完整匹配才算，避免误伤「无障碍设计」等正常词）。 */
const PLACEHOLDER_EXACT = new Set(['测试文本', '测试', 'test', '无', '暂无', '占位', 'todo', '待定', 'na', 'n/a']);
/** 疑似歌词/背景音的叠音拟声词（进入待检查，不直接判占位）。 */
const REPEATED_VOCAL = /[呜喔哈嘿哼呐]{2,}/u;

function classifyEntry(refText: string): { status: ViralTemplateStatus; statusReason: string } {
  const normalizedAll = normalizeText(refText).replace(/\s+/g, '').toLowerCase();
  if (PLACEHOLDER_EXACT.has(normalizedAll)) {
    return { status: 'unusable', statusReason: '参考文案为占位内容（无有效文案）' };
  }
  const body = viralTemplateBodyText(refText);
  const normalizedBody = body.replace(/[\s\p{P}]+/gu, '').toLowerCase();
  if (!normalizedBody || PLACEHOLDER_EXACT.has(normalizedBody)) {
    return { status: 'unusable', statusReason: '参考文案正文为占位内容（无有效正文）' };
  }
  // 纯语气词/单字重复（如「哎耶耶耶」）：去标点后字符种类 ≤2 且很短。
  if (normalizedBody.length <= 8 && new Set(Array.from(normalizedBody)).size <= 2) {
    return { status: 'unusable', statusReason: '参考文案正文为语气词占位（无有效信息）' };
  }
  if (REPEATED_VOCAL.test(body)) {
    return { status: 'review', statusReason: '正文疑似歌词/背景音内容，待人工检查' };
  }
  return { status: 'usable', statusReason: '' };
}

function entryContentHash(parts: {
  category: string; subCategory: string; name: string; title: string;
  refText: string; structureRaw: string; structureSummary: string;
}): string {
  return createHash('sha256').update([
    parts.category, parts.subCategory, parts.name, parts.title,
    parts.refText, parts.structureRaw, parts.structureSummary,
  ].join('')).digest('hex');
}

function parseSheetEntries(
  sheet: WorkbookSheet,
  header: { headerRow: number; columns: Record<string, number> },
): ViralTemplateEntryParsed[] {
  const entries: ViralTemplateEntryParsed[] = [];
  const { columns } = header;
  const read = (rowNumber: number, key: keyof typeof HEADERS): string =>
    cellText(effectiveValue(sheet, rowNumber, columns[key] ?? -1)).trim();
  for (const row of sheet.rows) {
    if (row.rowNumber <= header.headerRow) continue;
    const sourceTemplateId = read(row.rowNumber, 'templateId');
    const refText = read(row.rowNumber, 'refText');
    // 完全空白行（无 ID 且无文案）是分隔行，不生成记录。
    if (!sourceTemplateId && !refText) continue;
    const structureRaw = read(row.rowNumber, 'structureRaw');
    const structureSummary = read(row.rowNumber, 'structureSummary');
    const structure = structureRaw || structureSummary || VIRAL_TEMPLATE_DEFAULT_STRUCTURE;
    const { status, statusReason } = classifyEntry(refText);
    const category = read(row.rowNumber, 'category');
    const subCategory = read(row.rowNumber, 'subCategory');
    const name = read(row.rowNumber, 'name');
    const title = read(row.rowNumber, 'title');
    entries.push({
      sourceTemplateId,
      category,
      subCategory,
      name,
      title,
      refText,
      structureRaw,
      structureSummary,
      structure,
      structureOrigin: structureRaw || structureSummary ? 'source' : 'fallback',
      rawColumns: {
        assetType: read(row.rowNumber, 'assetType'),
        useCount: read(row.rowNumber, 'useCount'),
        itemId: read(row.rowNumber, 'itemId'),
        itemUrl: read(row.rowNumber, 'itemUrl'),
        visibility: read(row.rowNumber, 'visibility'),
      },
      sourceSheet: sheet.name,
      sourceRow: row.rowNumber,
      contentHash: entryContentHash({ category, subCategory, name, title, refText, structureRaw, structureSummary }),
      status,
      statusReason,
    });
  }
  return entries;
}

/**
 * 解析整本工作簿：优先「全部模板」主表；主表缺失时合并其余分类表并按来源模板 ID 去重。
 * 缺模板 ID 的行生成可重复的内容标识（content:哈希前缀），并在报告中显式记录来源。
 */
export function parseViralTemplateWorkbook(sheets: WorkbookSheet[]): ViralTemplateParseResult {
  const issues: ViralTemplateImportIssue[] = [];
  const sheetCounts: Record<string, number> = {};
  let entries: ViralTemplateEntryParsed[] = [];
  let mergedCategorySheets = false;

  const parseable = sheets
    .map((sheet) => ({ sheet, header: findHeaderColumns(sheet) }))
    .filter((item): item is { sheet: WorkbookSheet; header: { headerRow: number; columns: Record<string, number> } } => Boolean(item.header));

  const main = parseable.find((item) => item.sheet.name === VIRAL_TEMPLATE_MAIN_SHEET);
  if (main) {
    entries = parseSheetEntries(main.sheet, main.header);
    sheetCounts[main.sheet.name] = entries.length;
  } else {
    mergedCategorySheets = true;
    const byId = new Map<string, ViralTemplateEntryParsed>();
    for (const item of parseable) {
      const parsed = parseSheetEntries(item.sheet, item.header);
      let contributed = 0;
      for (const entry of parsed) {
        const key = entry.sourceTemplateId || `content:${entry.contentHash.slice(0, 16)}`;
        if (!byId.has(key)) {
          byId.set(key, entry);
          contributed += 1;
        }
      }
      sheetCounts[item.sheet.name] = contributed;
    }
    entries = [...byId.values()];
    if (entries.length) {
      issues.push({ code: 'main_sheet_missing', message: `未找到「${VIRAL_TEMPLATE_MAIN_SHEET}」主表，已合并 ${parseable.length} 个分类表并按模板 ID 去重` });
    }
  }

  if (parseable.length === 0) {
    issues.push({ code: 'viral_template_sheet_missing', message: '未找到包含「参考文案 / 模板ID」表头的工作表，导入内容不完整' });
    return {
      entries: [],
      report: {
        totalRows: 0, validRows: 0, mergedModelCount: 0, issues, canActivate: false,
        sheetCounts, statusCounts: { usable: 0, unusable: 0, review: 0 }, mergedCategorySheets,
      },
    };
  }

  // 缺模板 ID：生成可重复内容标识并显式记录来源（不静默造身份）。
  let missingId = 0;
  for (const entry of entries) {
    if (!entry.sourceTemplateId) {
      missingId += 1;
      entry.sourceTemplateId = `content:${entry.contentHash.slice(0, 16)}`;
      issues.push({
        code: 'template_id_missing',
        message: `工作表「${entry.sourceSheet}」第 ${entry.sourceRow} 行缺少模板 ID，已按内容哈希生成标识 ${entry.sourceTemplateId}`,
      });
    }
  }
  if (missingId > 0) {
    issues.push({ code: 'template_id_missing_summary', message: `共 ${missingId} 行缺少模板 ID，已按内容哈希生成可重复标识` });
  }

  // 同一模板 ID 在主表内重复：保留首行并报告（防御非预期源表）。
  const seenIds = new Set<string>();
  const deduped: ViralTemplateEntryParsed[] = [];
  for (const entry of entries) {
    if (seenIds.has(entry.sourceTemplateId)) {
      issues.push({ code: 'duplicate_template_id', message: `模板 ID ${entry.sourceTemplateId}（第 ${entry.sourceRow} 行）与前行重复，已保留首行` });
      continue;
    }
    seenIds.add(entry.sourceTemplateId);
    deduped.push(entry);
  }

  // 不同 ID 但参考文案完全相同：只提示文本重复，没有身份依据时不静默合并。
  const seenText = new Map<string, ViralTemplateEntryParsed>();
  for (const entry of deduped) {
    const textKey = createHash('sha256').update(normalizeText(entry.refText).replace(/\s+/g, '')).digest('hex');
    const prior = seenText.get(textKey);
    if (prior) {
      issues.push({
        code: 'duplicate_text',
        message: `模板「${entry.name || entry.sourceTemplateId}」（${entry.sourceTemplateId}）与「${prior.name || prior.sourceTemplateId}」（${prior.sourceTemplateId}）参考文案完全相同，已分别保留`,
      });
    } else {
      seenText.set(textKey, entry);
    }
  }

  // 参考文案为空：模板不可用（生成没有参照），但不是占位词意义上的「占位内容」。
  for (const entry of deduped) {
    if (!entry.refText.trim()) {
      entry.status = 'unusable';
      entry.statusReason = '参考文案为空，无法用于改写';
    }
  }

  const statusCounts = { usable: 0, unusable: 0, review: 0 };
  for (const entry of deduped) {
    statusCounts[entry.status] += 1;
    if (entry.status !== 'usable') {
      issues.push({
        code: entry.status === 'unusable' ? 'entry_unusable' : 'entry_review',
        message: `「${entry.name || entry.title || entry.sourceTemplateId}」（第 ${entry.sourceRow} 行）：${entry.statusReason}`,
      });
    }
  }

  return {
    entries: deduped,
    report: {
      totalRows: deduped.length,
      validRows: statusCounts.usable,
      mergedModelCount: 0,
      issues,
      canActivate: deduped.length > 0,
      sheetCounts,
      statusCounts,
      mergedCategorySheets,
    },
  };
}
