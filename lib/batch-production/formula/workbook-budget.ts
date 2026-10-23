import { inflateRawSync } from 'node:zlib';

export const FORMULA_WORKBOOK_LIMITS = {
  bytes: 10 * 1024 * 1024,
  expandedBytes: 100 * 1024 * 1024,
  entries: 2000,
  rows: 10000,
  columns: 50,
} as const;

/** 在 ExcelJS 分配单元格前检查 ZIP，并以真实解压字节数核验声明预算。 */
export function validateFormulaWorkbookBudget(bytes: Buffer): void {
  const limits = FORMULA_WORKBOOK_LIMITS;
  if (bytes.length > limits.bytes) throw new Error('工作簿不能超过 10 MiB');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('文件不是有效的 XLSX 工作簿');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || count !== bytes.readUInt16LE(end + 8) || !count || count > limits.entries
    || start + size !== end) throw new Error('不支持此 XLSX 压缩结构或文件数量超限');
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let offset = start;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX 压缩目录损坏');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)
      || local + 30 > start || total + expanded > limits.expandedBytes) {
      throw new Error('XLSX 含不支持的压缩内容或解压后超过 100 MiB');
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name) || /(?:^|\/)\.\.(?:\/|$)|\\|^\//.test(name)) throw new Error('XLSX 存在重复或异常文件项');
    if (/vbaProject|^xl\/externalLinks\//i.test(name)) throw new Error('请移除宏和外部链接后导入 XLSX');
    names.add(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method
      || bytes.readUInt16LE(local + 6) !== flags) throw new Error('XLSX 压缩记录不一致');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > start || dataStart > start
      || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name) throw new Error('XLSX 内容范围无效');
    if (ranges.some(([a, b]) => local < b && dataStart + compressed > a)) throw new Error('XLSX 文件内容重叠');
    ranges.push([local, dataStart + compressed]);
    const data = bytes.subarray(dataStart, dataStart + compressed);
    let output: Buffer;
    try { output = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, expanded) }); }
    catch { throw new Error('XLSX 解压失败或实际内容超过声明预算'); }
    if (output.length !== expanded) throw new Error('XLSX 解压大小与声明不一致');
    total += output.length;
    if (/\.xml$/i.test(name)) {
      const xml = output.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XLSX 含不支持的 XML 定义');
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        for (const cell of xml.matchAll(/\b(?:r|ref)="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/g)) {
          const col = (value: string) => [...value].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
          if (col(cell[3] ?? cell[1]) > limits.columns || Number(cell[4] ?? cell[2]) > limits.rows) {
            throw new Error('工作簿超过 10,000 行或 50 列，请拆分后导入');
          }
        }
      }
    }
    offset = next;
  }
  if (offset !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('文件不是完整的 XLSX 工作簿');
}
