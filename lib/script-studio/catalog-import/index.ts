import { loadWorkbook, sheetToWorkbookSheet, extractImages } from './workbook.ts';
import { parseStrategySheet } from './strategy.ts';
import { parseTemplateSheet, TEMPLATE_REQUIRED_SHEETS } from './templates.ts';
import { storeAssetImage } from './storage.ts';
import { getScriptStudioLimits } from '../limits.ts';
import type { ImportKind, TemplateAssetInsert, TemplateImportResult } from './types.ts';

/**
 * 目录导入入口（方案 §6.1）：只接受 `.xlsx`（同时校验 ZIP/OOXML 内容而非只信扩展名）；
 * 解析完成后把原始缓冲的副本交给调用方做原子发布。解析模块只在 Node 服务端加载。
 */

/** 目录导入大小上限（值来自 limits.ts，业务模块不硬编码资源限制）。 */
export const MAX_XLSX_BYTES = getScriptStudioLimits().maxCatalogImportBytes;

export interface ParsedStrategyImport {
  kind: 'strategy';
  entries: ReturnType<typeof parseStrategySheet>['entries'];
  report: ReturnType<typeof parseStrategySheet>['report'];
}

export interface ParsedTemplateImport {
  kind: 'template';
  templates: Omit<TemplateImportResult, 'assets'>;
  assets: Array<{ visualHookId: string; buffer: Buffer; extension: string }>;
}

export type ParsedImportResult = ParsedStrategyImport | ParsedTemplateImport;

export function assertXlsxBuffer(buffer: Buffer): void {
  if (buffer.length === 0) throw new Error('上传文件为空');
  if (buffer.length > MAX_XLSX_BYTES) throw new Error(`上传文件超过 ${Math.round(MAX_XLSX_BYTES / 1024 / 1024)} MiB 上限`);
  // ZIP/OOXML 魔数：PK\x03\x04
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    throw new Error('不是有效的 XLSX 文件（OOXML/ZIP 内容校验失败）');
  }
}

export async function parseStrategyImport(buffer: Buffer): Promise<ParsedStrategyImport> {
  assertXlsxBuffer(buffer);
  const workbook = await loadWorkbook(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('策略表为空');
  const parsed = parseStrategySheet(sheetToWorkbookSheet(sheet));
  return { kind: 'strategy', entries: parsed.entries, report: parsed.report };
}

export async function parseTemplateImport(buffer: Buffer): Promise<ParsedTemplateImport> {
  assertXlsxBuffer(buffer);
  const workbook = await loadWorkbook(buffer);
  const result: ParsedTemplateImport = { kind: 'template', templates: { frameworks: [], copyHooks: [], visualHooks: [], report: { totalRows: 0, validRows: 0, mergedModelCount: 0, issues: [], canActivate: true, unmappedHeaders: [] } }, assets: [] };
  const matchedSheets = new Set<string>();
  for (const worksheet of workbook.worksheets) {
    const sheet = sheetToWorkbookSheet(worksheet);
    const images = extractImages(workbook, worksheet).map((image) => ({ anchorRow: image.anchorRow, buffer: image.buffer, extension: image.extension }));
    const parsed = parseTemplateSheet(sheet, images);
    if (parsed.report.sheet) matchedSheets.add(parsed.report.sheet);
    result.templates.frameworks.push(...parsed.frameworks);
    result.templates.copyHooks.push(...parsed.copyHooks);
    result.templates.visualHooks.push(...parsed.visualHooks);
    result.templates.report.totalRows += parsed.report.totalRows;
    result.templates.report.validRows += parsed.report.validRows;
    result.templates.report.issues.push(...parsed.report.issues);
    result.templates.report.unmappedHeaders?.push(...(parsed.report.unmappedHeaders ?? []));
    if (parsed.report.templateCounts) {
      const counts = result.templates.report.templateCounts ?? { framework: 0, copyHook: 0, visualHook: 0, valid: 0, draftInvalid: 0 };
      counts.framework += parsed.report.templateCounts.framework;
      counts.copyHook += parsed.report.templateCounts.copyHook;
      counts.visualHook += parsed.report.templateCounts.visualHook;
      counts.valid += parsed.report.templateCounts.valid;
      counts.draftInvalid += parsed.report.templateCounts.draftInvalid;
      result.templates.report.templateCounts = counts;
    }
    result.templates.report.canActivate = result.templates.report.canActivate && parsed.report.canActivate;
    // 同行允许多图：按源行号顺序逐一配对，避免多图被反复配到第一张。
    const consumedByRow = new Map<number, number>();
    for (const asset of parsed.assets) {
      const anchorRow = Number(asset.sourceAnchor.slice(4));
      const rowImages = images.filter((item) => item.anchorRow === anchorRow);
      const index = consumedByRow.get(anchorRow) ?? 0;
      const image = rowImages[index];
      if (!image) continue;
      consumedByRow.set(anchorRow, index + 1);
      result.assets.push({ visualHookId: asset.visualHookId, buffer: image.buffer, extension: image.extension });
    }
  }
  // 信任边界：三个必需工作表必须齐全。缺一个就视为结构不完整，不得无条件激活。
  for (const required of TEMPLATE_REQUIRED_SHEETS) {
    if (!matchedSheets.has(required)) {
      result.templates.report.issues.push({ code: 'template_sheet_missing', message: `模板表缺少必需工作表「${required}」，导入内容不完整` });
      result.templates.report.canActivate = false;
    }
  }
  return result;
}

/** 把模板导入的图片缓冲落盘为受管副本，返回可写入 `script_studio_template_assets` 的行。 */
export async function persistTemplateAssets(
  revisionId: string,
  assets: Array<{ visualHookId: string; buffer: Buffer; extension: string }>,
): Promise<TemplateAssetInsert[]> {
  const rows: TemplateAssetInsert[] = [];
  for (const asset of assets) {
    const stored = await storeAssetImage(revisionId, asset.buffer, asset.extension);
    rows.push({
      visualHookId: asset.visualHookId,
      relativePath: stored.relativePath,
      contentSha256: stored.contentSha256,
      sourceAnchor: asset.visualHookId,
      width: stored.width,
      height: stored.height,
    });
  }
  return rows;
}

export function isImportKind(value: string): value is ImportKind {
  return value === 'strategy' || value === 'template';
}
