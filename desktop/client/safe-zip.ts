import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

interface ZipLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

interface CentralEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  crc: number;
  externalAttributes: number;
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryName(name: string): string[] {
  if (!name || name.length > 512 || name.includes('\ufffd') || /[\u0000-\u001f\u007f]/.test(name)
    || name.includes('\\') || name.startsWith('/') || path.win32.isAbsolute(name) || name.includes(':')) {
    throw new Error('ZIP 包含绝对路径、ADS 或非法名称');
  }
  const directory = name.endsWith('/');
  const segments = name.split('/');
  if (directory) segments.pop();
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..'
    || DEVICE_NAME.test(segment) || /[. ]$/.test(segment) || /[<>"|?*]/.test(segment))) {
    throw new Error('ZIP 包含路径穿越或 Windows 保留名称');
  }
  return directory ? [...segments, ''] : segments;
}

function centralEntries(bytes: Buffer, limits: Required<ZipLimits>): CentralEntry[] {
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length) throw new Error('ZIP 目录无效');
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0
    || bytes.readUInt16LE(eocd + 8) !== count || count > limits.maxEntries
    || centralOffset + centralSize !== eocd) throw new Error('ZIP 分卷、目录或条目上限无效');
  const result: CentralEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > eocd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff) || offset + 46 + nameLength + extraLength + commentLength > eocd) {
      throw new Error('ZIP64 或越界目录不受支持');
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    safeEntryName(name);
    const normalized = name.replaceAll('/', '_').toLowerCase();
    if (names.has(normalized)) throw new Error('ZIP 包含重复或大小写冲突名称');
    names.add(normalized);
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error('ZIP 加密或压缩方法不受支持');
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new Error('ZIP 符号链接不受支持');
    total += uncompressedSize;
    if (uncompressedSize > limits.maxFileBytes || total > limits.maxTotalBytes
      || (uncompressedSize > 1024 ** 2 && compressedSize > 0 && uncompressedSize / compressedSize > 200)) {
      throw new Error('ZIP 解压大小或压缩炸弹超过上限');
    }
    result.push({ name, method, flags, compressedSize, uncompressedSize, localOffset, crc, externalAttributes });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== eocd) throw new Error('ZIP 中央目录长度不一致');
  return result;
}

function assertNoSymlink(root: string, target: string): void {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('ZIP 目标目录不得包含符号链接');
  }
}

export function extractZipSafely(zipPath: string, destination: string, limits: ZipLimits = {}): void {
  const resolvedLimits = {
    maxEntries: limits.maxEntries ?? 512,
    maxTotalBytes: limits.maxTotalBytes ?? 2 * 1024 ** 3,
    maxFileBytes: limits.maxFileBytes ?? 512 * 1024 ** 2,
  };
  const bytes = fs.readFileSync(zipPath);
  const entries = centralEntries(bytes, resolvedLimits);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('ZIP 目标不得是符号链接');
  for (const entry of entries) {
    if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new Error('ZIP 本地文件头越界');
    }
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > bytes.length || bytes.readUInt16LE(entry.localOffset + 6) !== entry.flags
      || bytes.readUInt16LE(entry.localOffset + 8) !== entry.method) throw new Error('ZIP 本地数据越界或方法不一致');
    const segments = safeEntryName(entry.name);
    const directory = segments.at(-1) === '';
    const target = path.resolve(root, ...segments.filter(Boolean));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP 路径穿越');
    if (directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    assertNoSymlink(root, path.dirname(target));
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const output = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) throw new Error('ZIP 文件大小或 CRC 校验失败');
    assertNoSymlink(root, target);
    fs.writeFileSync(target, output, { flag: 'wx' });
  }
}
