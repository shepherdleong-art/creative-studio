import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_TAG = 0x6e616d65;
const TTCF_TAG = 0x74746366;

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
  const end = Math.min(buffer.length, start + (length - (length % 2)));
  let result = '';
  for (let i = start; i < end; i += 2) result += String.fromCharCode(buffer.readUInt16BE(i));
  return result;
}

function decodeLatin1(buffer: Buffer, start: number, length: number): string {
  const end = Math.min(buffer.length, start + length);
  let result = '';
  for (let i = start; i < end; i += 1) result += String.fromCharCode(buffer[i]);
  return result;
}

interface FamilyRecord { name: string; lang: number; nameID: number; }

function parseFamilies(nameTable: Buffer): FamilyRecord[] {
  const out: FamilyRecord[] = [];
  if (nameTable.length < 6) return out;
  const count = nameTable.readUInt16BE(2);
  const stringOffset = nameTable.readUInt16BE(4);
  for (let i = 0; i < count; i += 1) {
    const rec = 6 + i * 12;
    if (rec + 12 > nameTable.length) break;
    const platformID = nameTable.readUInt16BE(rec);
    const languageID = nameTable.readUInt16BE(rec + 4);
    const nameID = nameTable.readUInt16BE(rec + 6);
    const length = nameTable.readUInt16BE(rec + 8);
    const offset = nameTable.readUInt16BE(rec + 10);
    if (nameID !== 1 && nameID !== 16) continue;
    let decoded: string | null = null;
    if (platformID === 0) decoded = decodeUTF16BE(nameTable, stringOffset + offset, length);
    else if (platformID === 3) decoded = decodeUTF16BE(nameTable, stringOffset + offset, length);
    else if (platformID === 1) decoded = decodeLatin1(nameTable, stringOffset + offset, length);
    if (!decoded) continue;
    const clean = decoded.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!clean || clean.startsWith('.')) continue;
    out.push({ name: clean, lang: languageID, nameID });
  }
  return out;
}

const FONT_DIRECTORIES: Record<string, string[]> = {
  win32: [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'),
  ],
  darwin: [
    '/System/Library/Fonts',
    '/System/Library/Fonts/Supplemental',
    '/Library/Fonts',
    path.join(os.homedir(), 'Library', 'Fonts'),
  ],
  linux: ['/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')],
};

const dirs = FONT_DIRECTORIES[process.platform] || FONT_DIRECTORIES.linux;
const files: string[] = [];
for (const dir of dirs) {
  try { for (const entry of fs.readdirSync(dir)) files.push(path.join(dir, entry)); } catch {}
}

const results: Array<{ file: string; en: string | null; zh: string | null; all: FamilyRecord[] }> = [];
for (const file of files.slice(0, 200)) {
  if (!/\.(ttf|otf|ttc)$/i.test(file)) continue;
  try {
    const fd = fs.openSync(file, 'r');
    const header = readSegment(fd, 0, 12);
    const sfntVersion = header.readUInt32BE(0);
    let offsets: number[];
    if (sfntVersion === TTCF_TAG) {
      const n = header.readUInt32BE(8);
      offsets = [];
      const buf = readSegment(fd, 12, n * 4);
      for (let i = 0; i < n; i += 1) offsets.push(buf.readUInt32BE(i * 4));
    } else offsets = [0];
    for (const off of offsets) {
      const sfnt = readSegment(fd, off, 12);
      const numTables = sfnt.readUInt16BE(4);
      const dirBuf = readSegment(fd, off + 12, numTables * 16);
      let nameOffset = 0, nameLength = 0;
      for (let i = 0; i < numTables; i += 1) {
        const e = i * 16;
        if (dirBuf.readUInt32BE(e) === NAME_TAG) { nameOffset = dirBuf.readUInt32BE(e + 8); nameLength = dirBuf.readUInt32BE(e + 12); break; }
      }
      if (!nameOffset || !nameLength) continue;
      const table = readSegment(fd, nameOffset, nameLength);
      const families = parseFamilies(table);
      const en = families.find((f) => f.lang === 0x0409)?.name ?? families.find((f) => f.lang === 0)?.name ?? null;
      const zh = families.find((f) => f.lang === 0x0804 || f.lang === 0x0404)?.name ?? null;
      results.push({ file: path.basename(file), en, zh, all: families });
    }
    fs.closeSync(fd);
  } catch { /* skip */ }
}

const zhFonts = results.filter((r) => r.zh);
const enOnly = results.filter((r) => !r.zh && r.en);
console.log(`总文件: ${results.length}, 有中文 family: ${zhFonts.length}, 仅英文: ${enOnly.length}`);
console.log('\n--- 有中文 family 的字体（前20）---');
for (const r of zhFonts.slice(0, 20)) console.log(`${r.file}  EN: ${r.en}  ZH: ${r.zh}`);
console.log('\n--- 仅英文 family 的字体（前20）---');
for (const r of enOnly.slice(0, 20)) console.log(`${r.file}  EN: ${r.en}`);
console.log('\n--- 一个中文字体的完整 name 记录 ---');
if (zhFonts.length > 0) console.log(JSON.stringify(zhFonts[0].all, null, 2));
