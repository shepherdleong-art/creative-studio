import type { WorkbookSheet } from './workbook.ts';
import { effectiveValue } from './workbook.ts';
import {
  normalizeText,
  normalizeModelKey,
  collapseNewlines,
  splitItems,
  splitSearchTerms,
  matchHeaderColumns,
} from './normalize.ts';
import type { ImportIssue, ImportReport, StrategyEntryInsert, StrategyImportResult } from './types.ts';

/**
 * 产品策略知识库解析（方案 §2.6 / §6.2）。
 * 表头按语义匹配；同型号多行按规则合并；统一名称冲突 fail closed。
 */

interface ColumnMap {
  modelKey: number;
  canonicalName: number;
  categoryMindsets: number;
  primarySellingPoints: number;
  differentiators: number;
  searchTerms: number;
}

export function parseStrategySheet(sheet: WorkbookSheet): StrategyImportResult {
  const issues: ImportIssue[] = [];
  const unmappedHeaders: ImportReport['unmappedHeaders'] = [];

  // 找「型号」表头行（产品信息区）与「心智策略」表头行。
  // 标题行可能误含「埋词」字样（如「埋词规划」），所以策略表头按「策略关键词命中数」取分数最高的一行。
  const strategyKeywords = ['品类心智', '一级卖点', '主卖点', '差异化', '埋词', '搜索词', '命名统一', '统一名称'];
  const headerRows = sheet.rows.filter((row) => {
    const cells = row.cells.map((cell) => normalizeText(cell.value));
    return cells.some((text) => text.includes('型号')) || cells.some((text) => strategyKeywords.some((keyword) => text.includes(keyword)));
  });
  const modelHeaderRow = headerRows.find((row) => row.cells.some((cell) => normalizeText(cell.value).includes('型号')));
  const strategyHeaderRow = headerRows
    .filter((row) => row.rowNumber > (modelHeaderRow?.rowNumber ?? 0))
    .map((row) => ({
      row,
      score: row.cells.filter((cell) => strategyKeywords.some((keyword) => normalizeText(cell.value).includes(keyword))).length,
    }))
    .sort((a, b) => b.score - a.score)[0]?.row;
  if (!modelHeaderRow || !strategyHeaderRow) {
    return {
      entries: [],
      report: {
        totalRows: 0, validRows: 0, mergedModelCount: 0, issues: [{ code: 'header_not_found', message: '无法识别策略表表头（缺型号/品类心智/埋词/命名统一列）' }], canActivate: false,
      },
    };
  }
  const dataStartRow = Math.max(modelHeaderRow.rowNumber, strategyHeaderRow.rowNumber) + 1;

  const { columns, unmapped } = matchHeaderColumns(
    strategyHeaderRow.cells.map((cell) => ({ index: cell.index, value: cell.value })),
    [
      { key: 'canonicalName', keywords: ['命名统一', '统一名称'], required: true },
      { key: 'categoryMindsets', keywords: ['品类心智'], required: true },
      { key: 'primarySellingPoints', keywords: ['一级卖点', '主卖点'], required: false },
      { key: 'differentiators', keywords: ['差异化'], required: false },
      { key: 'searchTerms', keywords: ['埋词', '搜索词'], required: true },
    ],
    strategyHeaderRow.rowNumber,
  );
  const modelKeyCol = modelHeaderRow.cells.find((cell) => normalizeText(cell.value).includes('型号'))?.index;
  if (!modelKeyCol) {
    issues.push({ code: 'model_header_missing', message: '策略表缺少「产品型号」表头' });
    return { entries: [], report: { totalRows: 0, validRows: 0, mergedModelCount: 0, issues, canActivate: false } };
  }
  for (const item of unmapped) {
    unmappedHeaders.push({ column: item.column, value: item.value, row: item.row });
    issues.push({ code: 'header_unmapped', message: `策略表缺少「${item.column}」列`, row: item.row });
  }

  const map: ColumnMap = {
    modelKey: modelKeyCol,
    canonicalName: columns.canonicalName,
    categoryMindsets: columns.categoryMindsets,
    primarySellingPoints: columns.primarySellingPoints,
    differentiators: columns.differentiators,
    searchTerms: columns.searchTerms,
  };

  // 收集数据行
  const grouped = new Map<string, Array<{ rowNumber: number; raw: Record<string, string> }>>();
  let totalRows = 0;
  const dataRows = sheet.rows.filter((row) => row.rowNumber >= dataStartRow);
  for (const row of dataRows) {
    const modelValue = normalizeText(effectiveValue(sheet, row.rowNumber, map.modelKey));
    const hasAny = Object.values(map).some((col) => normalizeText(effectiveValue(sheet, row.rowNumber, col)));
    if (!modelValue && !hasAny) continue; // 空白分隔行不生成记录
    totalRows += 1;
    const raw: Record<string, string> = {};
    for (const [key, col] of Object.entries(map)) {
      if (col) raw[key] = collapseNewlines(effectiveValue(sheet, row.rowNumber, col));
    }
    if (!modelValue) {
      issues.push({ code: 'empty_model', message: '策略行缺少型号，已跳过', row: row.rowNumber });
      continue;
    }
    const normalized = normalizeModelKey(modelValue);
    if (!grouped.has(normalized)) grouped.set(normalized, []);
    grouped.get(normalized)!.push({ rowNumber: row.rowNumber, raw });
  }

  const entries: StrategyEntryInsert[] = [];
  for (const [normalizedModelKey, rows] of grouped) {
    const sourceRows = rows.map((item) => item.rowNumber);
    const canonicalNames = [...new Set(rows.map((item) => item.raw.canonicalName || '').filter(Boolean))];
    const primarySellingPoints = splitItems(rows.map((item) => item.raw.primarySellingPoints).join('\n'));
    const differentiators = splitItems(rows.map((item) => item.raw.differentiators).join('\n'));
    const searchTerms = splitSearchTerms(rows.map((item) => item.raw.searchTerms).join('\n'));
    // 信任边界：缺统一名称或搜索词/埋词的条目一旦命中，标题埋词门禁必然失败，
    // 所以直接标为 conflict（不进入自动推荐），而不是 active。冲突/缺字段都不阻断整库激活。
    let status: StrategyEntryInsert['status'] = 'active';
    if (canonicalNames.length > 1) {
      status = 'conflict';
      issues.push({ code: 'canonical_name_conflict', message: `型号 ${rows[0]!.raw.modelKey || normalizedModelKey} 出现多个不同统一名称：${canonicalNames.join(' / ')}（来源行 ${sourceRows.join('、')}），不进入自动推荐`, row: rows[0]!.rowNumber });
    } else if (!canonicalNames[0]) {
      status = 'conflict';
      issues.push({ code: 'canonical_name_missing', message: `型号 ${rows[0]!.raw.modelKey || normalizedModelKey} 缺少统一名称（来源行 ${sourceRows.join('、')}），不进入自动推荐`, row: rows[0]!.rowNumber });
    } else if (searchTerms.length === 0) {
      status = 'conflict';
      issues.push({ code: 'search_terms_missing', message: `型号 ${rows[0]!.raw.modelKey || normalizedModelKey} 缺少搜索词/埋词（来源行 ${sourceRows.join('、')}），不进入自动推荐`, row: rows[0]!.rowNumber });
    }
    const categoryMindsets: string[] = [];
    for (const item of rows) {
      if (item.raw.categoryMindsets && !categoryMindsets.includes(item.raw.categoryMindsets)) categoryMindsets.push(item.raw.categoryMindsets);
    }
    entries.push({
      modelKey: rows[0]!.raw.modelKey || normalizedModelKey,
      normalizedModelKey,
      canonicalName: canonicalNames[0] ?? '',
      categoryMindsets,
      primarySellingPoints,
      differentiators,
      searchTerms,
      auxiliary: {},
      sourceRows,
      status,
    });
  }

  const report: ImportReport = {
    totalRows,
    validRows: entries.length,
    mergedModelCount: entries.length,
    issues,
    canActivate: issues.every((issue) => issue.code === 'canonical_name_conflict' || issue.code === 'canonical_name_missing' || issue.code === 'search_terms_missing' || issue.code === 'header_unmapped'),
    unmappedHeaders,
  };
  return { entries, report };
}
