import ExcelJS from 'exceljs';
import { buildMergedDownfill } from './normalize.ts';

/**
 * XLSX 工作簿读取（仅服务端使用，绝不进入客户端 bundle）。
 * 支持单元格、合并单元格「向下继承」与嵌入图片锚点。
 */

export interface WorkbookCell {
  index: number; // 1-based column index
  value: unknown;
}

export interface WorkbookRow {
  rowNumber: number; // 1-based
  cells: WorkbookCell[];
}

export interface WorkbookSheet {
  name: string;
  rows: WorkbookRow[];
  mergedMap: Map<string, { row: number; col: number }>;
}

export interface ExtractedImage {
  /** 图片锚定的源行（1-based，取左上角行）。 */
  anchorRow: number;
  buffer: Buffer;
  extension: string;
}

/** 校验 ZIP/OOXML 内容而非只信扩展名：加载失败即拒绝。 */
export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  // exceljs 的 load 参数把 Buffer 约束为默认泛型参数（Buffer<ArrayBuffer>），
  // 而我们拿到的是 Buffer<ArrayBufferLike>；运行时同构，只做类型收窄。
  type XlsxLoadArg = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];
  await workbook.xlsx.load(buffer as unknown as XlsxLoadArg);
  return workbook;
}

function toRanges(worksheet: ExcelJS.Worksheet): Array<{ top: number; left: number; bottom: number; right: number }> {
  const ranges: Array<{ top: number; left: number; bottom: number; right: number }> = [];
  try {
    const merged = (worksheet as unknown as { mergedCells: unknown }).mergedCells as unknown;
    if (merged && typeof merged === 'object') {
      // exceljs 的 mergedCells 是可迭代对象，每个 range 带 top/left/bottom/right
      const iterable = merged as Iterable<{ top: number; left: number; bottom: number; right: number }>;
      for (const range of iterable) {
        if (range && typeof range.top === 'number') {
          ranges.push({ top: range.top, left: range.left, bottom: range.bottom, right: range.right });
        }
      }
    }
  } catch {
    // 不把合并单元格解析失败当成导入失败；读不到就按普通单元格处理。
  }
  return ranges;
}

export function sheetToWorkbookSheet(worksheet: ExcelJS.Worksheet): WorkbookSheet {
  const rows: WorkbookRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    const cells: WorkbookCell[] = [];
    row.eachCell((cell, colNumber) => {
      if (cell.value != null && cell.value !== '') {
        cells.push({ index: colNumber, value: cell.value });
      }
    });
    rows.push({ rowNumber, cells });
  });
  const ranges = toRanges(worksheet);
  const mergedMap = buildMergedDownfill(ranges.map((range) => ({
    top: range.top,
    left: range.left,
    bottom: range.bottom,
    right: range.right,
  })));
  return { name: worksheet.name, rows, mergedMap };
}

/** 读取某行某列的有效值（合并单元格向下继承到所有被合并行）。 */
export function effectiveValue(sheet: WorkbookSheet, rowNumber: number, colIndex: number): unknown {
  const owner = sheet.mergedMap.get(`${rowNumber}:${colIndex}`);
  const sourceRow = owner ? owner.row : rowNumber;
  const row = sheet.rows.find((item) => item.rowNumber === sourceRow);
  if (!row) return undefined;
  const cell = row.cells.find((item) => item.index === colIndex);
  return cell?.value;
}

/** 提取工作表嵌入图片（drawing anchor 关联到源行；缓冲与扩展名取自工作簿 media）。 */
export function extractImages(workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  try {
    const media = (workbook as unknown as { model?: { media?: Array<{ index?: number; buffer?: Buffer; extension?: string }> } }).model?.media ?? [];
    const getImages = (worksheet as unknown as { getImages?: () => Array<{ imageId?: number; range?: { tl?: { row?: number } } }> }).getImages;
    if (typeof getImages !== 'function') return images;
    const raw = getImages.call(worksheet) ?? [];
    for (const image of raw) {
      const mediaItem = media.find((item) => item.index === image.imageId);
      const buffer = mediaItem?.buffer;
      if (!buffer || buffer.length === 0) continue;
      // exceljs 锚点是 0-based，转 1-based 行号
      const anchorRow = (image.range?.tl?.row ?? 0) + 1;
      images.push({ anchorRow, buffer, extension: mediaItem?.extension ?? 'png' });
    }
  } catch {
    // 读不到嵌入图片不阻断模板导入；报告里不提示（图片是附赠能力）。
  }
  return images;
}
