import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 系统字体扫描（技术计划 §1 问题一修复）：
// 本列表同时被 final-edit（混剪封面/字幕烘焙）与 batch-production（批量文字样式/
// 脚本步骤）消费，按 AGENTS.md 的「共享媒体基础放 media-core」约定落在这里。
//
// 关键修复：旧实现用**文件名**推导 family，而 CSS / Canvas / SVG 认的是字体文件
// name 表里的**真实 family 名**，两者大面积不一致，导致 UI 下拉框多数是无效名字，
// 选中后渲染器静默回落默认字体（「换了和没换差不多」）。
// 这里手写 sfnt name 表解析（零依赖），返回每个渲染器真正认识的名字。

export interface SystemFontEntry {
  /** 真实 family 名，可直接写进 CSS / SVG / Canvas（渲染器认识的名字） */
  family: string;
  /** 展示名，可与 family 相同 */
  fullName: string;
  /** 字体文件格式；ttc 为 TrueType Collection（一个文件含多个字型） */
  format: 'ttf' | 'otf' | 'ttc';
  /** 来源；供后续「导入自有字体」使用，本卡固定为 'system' */
  source?: 'system' | 'user';
}

const FONT_DIRECTORIES: Record<string, string[]> = {
  // Supplemental 目录原本靠深度递归覆盖到，显式列出更稳。
  darwin: [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts'),
  ],
  win32: [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')],
  linux: ['/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')],
};

// ---------------------------------------------------------------------------
// sfnt / name 表解析（零依赖，只读文件头与 name 表所需字节，绝不整文件读入）
// ---------------------------------------------------------------------------

const NAME_TAG = 0x6e616d65; // 'name'
const TTCF_TAG = 0x74746366; // 'ttcf'

function readSegment(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (bytes <= 0) throw new Error('字体文件意外截断');
    offset += bytes;
  }
  return buffer;
}

function decodeUTF16BE(buffer: Buffer, start: number, length: number): string {
  if (start < 0 || length < 0) return '';
  const end = Math.min(buffer.length, start + (length - (length % 2)));
  let result = '';
  for (let index = start; index < end; index += 2) result += String.fromCharCode(buffer.readUInt16BE(index));
  return result;
}

function decodeLatin1(buffer: Buffer, start: number, length: number): string {
  if (start < 0 || length < 0) return '';
  const end = Math.min(buffer.length, start + length);
  let result = '';
  for (let index = start; index < end; index += 1) result += String.fromCharCode(buffer[index]);
  return result;
}

/** 解析单个 name 表的 family 名：优先 typographic family（nameID 16），退回 family（nameID 1）。 */
function parseFamilyName(nameTable: Buffer): string | null {
  if (nameTable.length < 6) return null;
  const count = nameTable.readUInt16BE(2);
  const stringOffset = nameTable.readUInt16BE(4);
  const families: Array<{ name: string; isTypographic: boolean }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const recordOffset = 6 + index * 12;
    if (recordOffset + 12 > nameTable.length) break;
    const platformID = nameTable.readUInt16BE(recordOffset);
    const languageID = nameTable.readUInt16BE(recordOffset + 4);
    const nameID = nameTable.readUInt16BE(recordOffset + 6);
    const length = nameTable.readUInt16BE(recordOffset + 8);
    const offset = nameTable.readUInt16BE(recordOffset + 10);
    if (nameID !== 1 && nameID !== 16) continue;
    let decoded: string | null = null;
    if (platformID === 0) {
      decoded = decodeUTF16BE(nameTable, stringOffset + offset, length);
    } else if (platformID === 3) {
      if (languageID === 0x0409) decoded = decodeUTF16BE(nameTable, stringOffset + offset, length);
    } else if (platformID === 1) {
      if (languageID === 0) decoded = decodeLatin1(nameTable, stringOffset + offset, length);
    }
    if (!decoded) continue;
    const clean = decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!clean || clean.startsWith('.')) continue; // 过滤内部名，如 .Hiragino Sans GB Interface W3
    if (seen.has(clean)) continue;
    seen.add(clean);
    families.push({ name: clean, isTypographic: nameID === 16 });
  }
  const typographic = families.find((entry) => entry.isTypographic);
  return typographic ? typographic.name : (families[0]?.name ?? null);
}

/** 读取一个字体文件（含 ttc 内全部子字体）的真实 family 名集合。解析失败抛错，由调用方跳过该文件。 */
function parseFontFamilies(filePath: string): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = readSegment(fd, 0, 12);
    const sfntVersion = header.readUInt32BE(0);
    let offsetTables: number[];
    if (sfntVersion === TTCF_TAG) {
      const numFonts = header.readUInt32BE(8);
      if (numFonts === 0 || numFonts > 512) throw new Error('ttc 子字体数量异常');
      const offsets = readSegment(fd, 12, numFonts * 4);
      offsetTables = [];
      for (let index = 0; index < numFonts; index += 1) offsetTables.push(offsets.readUInt32BE(index * 4));
    } else {
      offsetTables = [0];
    }
    const families = new Set<string>();
    for (const tableOffset of offsetTables) {
      const sfnt = readSegment(fd, tableOffset, 12);
      const numTables = sfnt.readUInt16BE(4);
      if (numTables === 0 || numTables > 512) continue;
      const tableDirectory = readSegment(fd, tableOffset + 12, numTables * 16);
      let nameOffset = 0;
      let nameLength = 0;
      for (let index = 0; index < numTables; index += 1) {
        const entryOffset = index * 16;
        if (tableDirectory.readUInt32BE(entryOffset) === NAME_TAG) {
          nameOffset = tableDirectory.readUInt32BE(entryOffset + 8);
          nameLength = tableDirectory.readUInt32BE(entryOffset + 12);
          break;
        }
      }
      if (!nameOffset || !nameLength) continue;
      // ttc 内各子字体的表偏移为「相对整个文件起点的绝对偏移」，与单字体一致。
      const nameTable = readSegment(fd, nameOffset, nameLength);
      const family = parseFamilyName(nameTable);
      if (family) families.add(family);
    }
    return [...families];
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 目录扫描 + 冷缓存（可失效）
// ---------------------------------------------------------------------------

function detectFormat(filename: string): SystemFontEntry['format'] | null {
  if (/\.ttc$/i.test(filename)) return 'ttc';
  if (/\.otf$/i.test(filename)) return 'otf';
  if (/\.ttf$/i.test(filename)) return 'ttf';
  return null;
}

let cached: { key: string; fonts: SystemFontEntry[] } | null = null;

/** 以各字体目录的 mtime 作为失效键：用户新装字体后目录内容变化，自动重扫。 */
function scanCacheKey(): string {
  const directories = FONT_DIRECTORIES[process.platform] || FONT_DIRECTORIES.linux;
  return directories
    .map((directory) => {
      try {
        const stat = fs.statSync(directory);
        return `${directory}:${stat.mtimeMs}`;
      } catch {
        return `${directory}:missing`;
      }
    })
    .join('|');
}

/** 按平台扫描字体目录（最多 3 层），读真实 family 名，按 family 去重排序。 */
export function listSystemFonts(options: { forceRefresh?: boolean } = {}): SystemFontEntry[] {
  const key = scanCacheKey();
  if (!options.forceRefresh && cached && cached.key === key) return cached.fonts;
  const directories = FONT_DIRECTORIES[process.platform] || FONT_DIRECTORIES.linux;
  const fonts = new Map<string, SystemFontEntry>();
  const visit = (directory: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // 目录不存在/无权限：跳过
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      const format = detectFormat(entry.name);
      if (!format) continue;
      let families: string[];
      try {
        families = parseFontFamilies(full);
      } catch {
        continue; // 单个文件解析失败只跳过该文件，不能让整个扫描抛错
      }
      for (const family of families) {
        if (!fonts.has(family)) fonts.set(family, { family, fullName: family, format, source: 'system' });
      }
    }
  };
  directories.forEach((directory) => visit(directory, 0));
  const result = [...fonts.values()].sort((left, right) => left.family.localeCompare(right.family));
  cached = { key, fonts: result };
  return result;
}
