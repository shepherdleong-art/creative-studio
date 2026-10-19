import type { WorkbookSheet } from './workbook.ts';
import { effectiveValue } from './workbook.ts';
import { normalizeText, collapseNewlines, splitItems } from './normalize.ts';
import type {
  CopyHookTemplateInsert,
  FrameworkTemplateInsert,
  ImportIssue,
  ImportReport,
  TemplateAssetInsert,
  TemplateImportResult,
  VisualHookTemplateInsert,
} from './types.ts';

/**
 * 脚本模板库解析（方案 §2.7 / §6.3）。识别三个工作表：
 * `脚本核心框架`、`开头钩子文案`、`开头钩子画面（待优化）`。
 * 合并单元格向下继承；空白分隔行不生成记录；已知数据问题显式进报告。
 */

const FRAMEWORK_SHEET = '脚本核心框架';
const COPY_HOOK_SHEET = '开头钩子文案';
const VISUAL_HOOK_SHEET = '开头钩子画面（待优化）';

/** 模板库必需的三个工作表：导入端据此做结构完整性校验（信任边界）。 */
export const TEMPLATE_REQUIRED_SHEETS = [FRAMEWORK_SHEET, COPY_HOOK_SHEET, VISUAL_HOOK_SHEET] as const;

function cellValue(sheet: WorkbookSheet, rowNumber: number, col: number): string {
  return collapseNewlines(effectiveValue(sheet, rowNumber, col));
}

/** 按表头语义找列（模板表头固定在第 1 行）。 */
function findColumn(sheet: WorkbookSheet, keywords: string[]): number | null {
  const headerRow = sheet.rows.find((row) => row.rowNumber === 1);
  if (!headerRow) return null;
  return headerRow.cells.find((cell) => keywords.some((keyword) => normalizeText(cell.value).includes(keyword)))?.index ?? null;
}

/**
 * 同一修订内按稳定键去重：真实业务表偶发完全相同的内容行（如同一画面玩法连写两行），
 * 数据库对 (revisionId, stableKey) 有唯一约束。保留首行，重复行显式进报告，不阻断导入。
 */
function dedupeByStableKey<T extends { stableKey: string; sourceRow: number }>(
  items: T[],
  issues: ImportIssue[],
  kindLabel: string,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (seen.has(item.stableKey)) {
      issues.push({
        code: 'duplicate_stable_key',
        message: `${kindLabel}稳定键「${item.stableKey}」重复：第 ${item.sourceRow} 行与既有条目内容相同，已合并保留首行，不重复入库`,
        row: item.sourceRow,
      });
      continue;
    }
    seen.add(item.stableKey);
    kept.push(item);
  }
  return kept;
}

/**
 * 无标题列：表头（第 1 行）为空的列。空单元格会被 sheet 读取器丢弃，
 * 所以按「1..maxCol 中存在列号但表头无对应单元格」来判定。
 */
function findUnlabeledColumns(sheet: WorkbookSheet): number[] {
  const headerRow = sheet.rows.find((row) => row.rowNumber === 1);
  const headerCols = new Set(headerRow?.cells.map((cell) => cell.index) ?? []);
  const maxCol = Math.max(1, ...sheet.rows.flatMap((row) => row.cells.map((cell) => cell.index)));
  const unlabeled: number[] = [];
  for (let col = 1; col <= maxCol; col += 1) {
    if (!headerCols.has(col)) unlabeled.push(col);
  }
  return unlabeled;
}

function parseFrameworks(sheet: WorkbookSheet, issues: ImportIssue[]): FrameworkTemplateInsert[] {
  const colVideoType = findColumn(sheet, ['视频类型']);
  const colSubtype = findColumn(sheet, ['细分类型']);
  const colStructure = findColumn(sheet, ['核心结构']);
  const colDensity = findColumn(sheet, ['卖点密度']);
  const colApplicable = findColumn(sheet, ['适用产品']);
  const colPreferred = findColumn(sheet, ['首选钩子']);
  const colSecondary = findColumn(sheet, ['次选钩子']);
  if (!colVideoType || !colStructure) {
    issues.push({ code: 'framework_header_missing', message: '模板表缺少「视频类型/核心结构」列' });
    return [];
  }
  const result: FrameworkTemplateInsert[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 1) continue;
    const videoType = cellValue(sheet, row.rowNumber, colVideoType);
    if (!videoType) continue; // 空白分隔行不生成记录
    // 稳定键优先用编号（「01 痛点解决型」→「01」）；「合辑/合集」归一为同一稳定 ID
    const numberPrefix = (videoType.match(/^\s*\d+/) ?? [''])[0].replace(/\s+/g, '');
    const stableBase = (numberPrefix || videoType).replace(/合辑/g, '合集');
    const structure = cellValue(sheet, row.rowNumber, colStructure)
      .split('+').map((part) => part.trim()).filter(Boolean);
    result.push({
      stableKey: stableBase,
      name: videoType,
      subtype: colSubtype ? cellValue(sheet, row.rowNumber, colSubtype) : '',
      structure,
      sellingPointDensity: { raw: colDensity ? cellValue(sheet, row.rowNumber, colDensity) : '' },
      applicableProducts: colApplicable ? splitItems(cellValue(sheet, row.rowNumber, colApplicable)) : [],
      preferredHookTypes: colPreferred ? splitItems(cellValue(sheet, row.rowNumber, colPreferred)) : [],
      secondaryHookTypes: colSecondary ? splitItems(cellValue(sheet, row.rowNumber, colSecondary)) : [],
      sourceRow: row.rowNumber,
      status: 'active',
    });
  }
  return result;
}

function parseCopyHooks(sheet: WorkbookSheet, issues: ImportIssue[]): CopyHookTemplateInsert[] {
  const colType = findColumn(sheet, ['钩子类型']);
  const colMechanism = findColumn(sheet, ['核心机制']);
  const colSubtype = findColumn(sheet, ['公式']);
  const colExample = findColumn(sheet, ['文案示例']);
  const colFrameworks = findColumn(sheet, ['推荐视频类型']);
  const colTags = findColumn(sheet, ['推荐卖点']);
  if (!colType) {
    issues.push({ code: 'copy_hook_header_missing', message: '文案钩子表缺少「钩子类型」列' });
    return [];
  }
  // 无标题公式列：表头为空的列，且数据区有内容（本表为「公式」列之后的无标题 D 列）
  const colFormula = findUnlabeledColumns(sheet).find((col) => sheet.rows.some((row) => row.rowNumber > 1 && normalizeText(effectiveValue(sheet, row.rowNumber, col))));

  const result: CopyHookTemplateInsert[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 1) continue;
    const hookType = cellValue(sheet, row.rowNumber, colType);
    if (!hookType) continue;
    const subtype = colSubtype ? cellValue(sheet, row.rowNumber, colSubtype) : '';
    const formula = colFormula ? cellValue(sheet, row.rowNumber, colFormula) : subtype;
    const example = colExample ? cellValue(sheet, row.rowNumber, colExample) : '';
    result.push({
      stableKey: `${hookType}:${subtype}`,
      hookType,
      mechanism: colMechanism ? cellValue(sheet, row.rowNumber, colMechanism) : '',
      subtype,
      formula,
      example,
      recommendedFrameworks: colFrameworks ? splitItems(cellValue(sheet, row.rowNumber, colFrameworks)) : [],
      recommendedSellingPointTags: colTags ? splitItems(cellValue(sheet, row.rowNumber, colTags)) : [],
      sourceRow: row.rowNumber,
      status: 'active',
    });
  }
  return result;
}

function parseVisualHooks(
  sheet: WorkbookSheet,
  issues: ImportIssue[],
  unmappedHeaders: ImportReport['unmappedHeaders'],
): VisualHookTemplateInsert[] {
  const colPlayGroup = findColumn(sheet, ['核心玩法']);
  const colPlayName = findColumn(sheet, ['裂变玩法']);
  const colFormula = findColumn(sheet, ['画面公式']);
  const colExample = findColumn(sheet, ['示例画面']);
  const colReference = findColumn(sheet, ['参考案例']);
  const colAdvice = findColumn(sheet, ['AI实现路径', '实现路径']);
  const colApplicable = findColumn(sheet, ['适合品类', '适用品类']);
  const colHookTags = findColumn(sheet, ['搭配钩子']);
  const colPrompt = findColumn(sheet, ['参考口令']);
  if (!colPlayName) {
    issues.push({ code: 'visual_hook_header_missing', message: '画面钩子表缺少「裂变玩法」列' });
    return [];
  }
  // 无标题列（本表 J 列「即梦OK / 需要前期制图」）按约定导入为制作备注
  const notesCol = findUnlabeledColumns(sheet).find((col) => sheet.rows.some((row) => row.rowNumber > 1 && normalizeText(effectiveValue(sheet, row.rowNumber, col))));

  const result: VisualHookTemplateInsert[] = [];
  for (const row of sheet.rows) {
    if (row.rowNumber <= 1) continue;
    const playName = cellValue(sheet, row.rowNumber, colPlayName);
    if (!playName && (!colPlayGroup || !cellValue(sheet, row.rowNumber, colPlayGroup))) continue;
    const playGroup = colPlayGroup ? cellValue(sheet, row.rowNumber, colPlayGroup) : '';
    const visualFormula = colFormula ? cellValue(sheet, row.rowNumber, colFormula) : '';
    const referenceLinks = colReference ? splitItems(cellValue(sheet, row.rowNumber, colReference)) : [];
    const applicableProducts = colApplicable ? splitItems(cellValue(sheet, row.rowNumber, colApplicable)) : [];
    const hookTags = colHookTags ? splitItems(cellValue(sheet, row.rowNumber, colHookTags)) : [];
    const notesParts: string[] = [];
    if (colPrompt) {
      const prompt = cellValue(sheet, row.rowNumber, colPrompt);
      if (prompt) notesParts.push(`参考口令：${prompt}`);
    }
    if (notesCol) {
      const unlabeled = cellValue(sheet, row.rowNumber, notesCol);
      if (unlabeled) {
        notesParts.push(`制作备注：${unlabeled}`);
        unmappedHeaders?.push({ column: `未命名列${notesCol}`, value: `「${unlabeled}」按当前源表约定导入为「制作备注」`, row: row.rowNumber });
      }
    }
    if (colExample) {
      const example = cellValue(sheet, row.rowNumber, colExample);
      if (example) notesParts.push(`示例画面：${example}`);
    }
    // 已知数据问题：第 7 行缺玩法名称 → draft_invalid，不进入自动推荐
    const status: VisualHookTemplateInsert['status'] = playName ? 'active' : 'draft_invalid';
    if (!playName) {
      issues.push({ code: 'visual_hook_missing_name', message: `开头画面第 ${row.rowNumber} 行缺少玩法名称，已标记为 draft_invalid，不进入自动推荐`, row: row.rowNumber });
    }
    // 已知数据问题：搭配钩子疑似误填为适用品类 → 保留原值并产生警告
    if (hookTags.length > 0 && applicableProducts.length > 0 && hookTags.some((tag) => applicableProducts.includes(tag))) {
      issues.push({ code: 'hook_tag_suspicious', message: `开头画面第 ${row.rowNumber} 行「搭配钩子」疑似误填为适用品类：${hookTags.join('、')}，保留原值但不参与钩子评分`, row: row.rowNumber });
    }
    result.push({
      stableKey: `${playGroup}:${playName}`,
      playGroup,
      playName,
      visualFormula,
      implementationAdvice: colAdvice ? cellValue(sheet, row.rowNumber, colAdvice) : '',
      applicableProducts,
      hookTags,
      referenceLinks,
      notes: notesParts.join('；'),
      sourceRow: row.rowNumber,
      status,
    });
  }
  return result;
}

export function parseTemplateSheet(sheet: WorkbookSheet, images?: Array<{ anchorRow: number; buffer: Buffer; extension: string }>): TemplateImportResult {
  const issues: ImportIssue[] = [];
  const unmappedHeaders: ImportReport['unmappedHeaders'] = [];
  let frameworks: FrameworkTemplateInsert[] = [];
  let copyHooks: CopyHookTemplateInsert[] = [];
  let visualHooks: VisualHookTemplateInsert[] = [];
  let matchedSheet: string | null = null;

  if (sheet.name === FRAMEWORK_SHEET) {
    frameworks = dedupeByStableKey(parseFrameworks(sheet, issues), issues, '框架');
    matchedSheet = FRAMEWORK_SHEET;
  } else if (sheet.name === COPY_HOOK_SHEET) {
    copyHooks = dedupeByStableKey(parseCopyHooks(sheet, issues), issues, '文案钩子');
    matchedSheet = COPY_HOOK_SHEET;
  } else if (sheet.name === VISUAL_HOOK_SHEET) {
    visualHooks = dedupeByStableKey(parseVisualHooks(sheet, issues, unmappedHeaders), issues, '画面钩子');
    matchedSheet = VISUAL_HOOK_SHEET;
  } else {
    issues.push({ code: 'unknown_sheet', message: `未知工作表：${sheet.name}（本目录需要 ${FRAMEWORK_SHEET} / ${COPY_HOOK_SHEET} / ${VISUAL_HOOK_SHEET}）` });
  }

  // 嵌入图片按 drawing anchor 关联到画面钩子源行
  const assets: TemplateAssetInsert[] = [];
  if (images && images.length > 0 && matchedSheet === VISUAL_HOOK_SHEET) {
    const visualByRow = new Map(visualHooks.map((hook) => [hook.sourceRow, hook]));
    for (const image of images) {
      const hook = visualByRow.get(image.anchorRow);
      if (!hook) continue;
      assets.push({
        visualHookId: `row:${hook.sourceRow}`,
        relativePath: '', // 落库前由 storage.ts 填充受管相对路径
        contentSha256: '',
        sourceAnchor: `row:${image.anchorRow}`,
        width: null,
        height: null,
      });
    }
  }

  const valid = frameworks.length + copyHooks.length + visualHooks.length;
  const draftInvalid = visualHooks.filter((hook) => hook.status === 'draft_invalid').length;
  // 可带警告激活：已知数据问题（缺玩法名称置草稿、内容重复去重、钩子标签可疑、未知工作表）
  // 不阻断；只有结构缺失（缺必需表头）才判定不可激活。
  const nonBlockingCodes = new Set([
    'hook_tag_suspicious',
    'unknown_sheet',
    'duplicate_stable_key',
    'visual_hook_missing_name',
  ]);
  const report: ImportReport = {
    totalRows: Math.max(frameworks.length, copyHooks.length, visualHooks.length),
    validRows: valid,
    mergedModelCount: 0,
    issues,
    canActivate: issues.every((issue) => nonBlockingCodes.has(issue.code)),
    sheet: matchedSheet ?? undefined,
    unmappedHeaders,
    templateCounts: {
      framework: frameworks.length,
      copyHook: copyHooks.length,
      visualHook: visualHooks.length,
      valid: valid - draftInvalid,
      draftInvalid,
    },
  };
  return { frameworks, copyHooks, visualHooks, assets, report };
}
