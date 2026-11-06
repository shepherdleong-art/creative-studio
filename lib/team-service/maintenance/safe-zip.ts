import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ServerZipLimits {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}
interface Entry {
  name: string; method: number; flags: number; compressedSize: number;
  uncompressedSize: number; localOffset: number; crc: number;
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
function safeName(name: string): string[] {
  if (!name || name.length > 512 || name.includes('\ufffd') || /[\u0000-\u001f\u007f]/.test(name)
    || name.includes('\\') || name.startsWith('/') || path.win32.isAbsolute(name) || name.includes(':')) {
    throw new Error('ZIP 包含绝对路径、ADS 或非法名称');
  }
  const directory = name.endsWith('/');
  const segments = name.split('/');
  if (directory) segments.pop();
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..'
    || DEVICE_NAME.test(segment) || /[. ]$/.test(segment) || /[<>"|?*]/.test(segment))) {
    throw new Error('ZIP 包含路径穿越或 Windows 保留名称');
  }
  return directory ? [...segments, ''] : segments;
}
function entries(bytes: Buffer, limits: Required<ServerZipLimits>): Entry[] {
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
  const result: Entry[] = [];
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
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)
      || offset + 46 + nameLength + extraLength + commentLength > eocd) throw new Error('ZIP64 或越界目录不受支持');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    safeName(name);
    const normalized = name.replaceAll('/', '_').toLowerCase();
    if (names.has(normalized)) throw new Error('ZIP 包含重复或大小写冲突名称');
    names.add(normalized);
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error('ZIP 加密或压缩方法不受支持');
    const host = externalAttributes >>> 24;
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000 || (host === 3 && fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000)
      || (unixMode & 0o6000) !== 0 || (externalAttributes & 0x10) !== 0 && !name.endsWith('/')) {
      throw new Error('ZIP 链接或特殊文件不受支持');
    }
    total += uncompressedSize;
    if (uncompressedSize > limits.maxFileBytes || total > limits.maxTotalBytes
      || (uncompressedSize > 1024 ** 2 && compressedSize > 0 && uncompressedSize / compressedSize > 200)) {
      throw new Error('ZIP 解压大小或压缩炸弹超过上限');
    }
    result.push({ name, method, flags, compressedSize, uncompressedSize, localOffset, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== eocd) throw new Error('ZIP 中央目录长度不一致');
  return result;
}
export function extractServerZipSafely(zipPath: string, destination: string, limits: ServerZipLimits & { neutralStaging?: boolean } = {}): void {
  const resolved = { maxEntries: limits.maxEntries ?? 100_000, maxTotalBytes: limits.maxTotalBytes ?? 8 * 1024 ** 3,
    maxFileBytes: limits.maxFileBytes ?? 2 * 1024 ** 3 };
  const bytes = fs.readFileSync(zipPath);
  const parsed = entries(bytes, resolved);
  if (!parsed.some((entry) => entry.name === 'release-manifest.json')) throw new Error('ZIP 包根缺少发布清单，意外嵌套不受支持');
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('ZIP 目标不得是符号链接');
  for (const entry of parsed) {
    if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error('ZIP 本地文件头越界');
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataOffset + entry.compressedSize;
    if (dataEnd > bytes.length || bytes.readUInt16LE(entry.localOffset + 6) !== entry.flags
      || bytes.readUInt16LE(entry.localOffset + 8) !== entry.method
      || bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength).toString('utf8') !== entry.name) {
      throw new Error('ZIP 本地数据越界或方法／路径不一致');
    }
    const segments = safeName(entry.name);
    const directory = segments.at(-1) === '';
    const target = path.resolve(root, ...segments.filter(Boolean));
    const writeTarget = limits.neutralStaging && !directory ? `${target}.upload` : target;
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP 路径穿越');
    if (directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const compressed = bytes.subarray(dataOffset, dataEnd);
    const output = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
    if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) throw new Error('ZIP 文件大小或 CRC 校验失败');
    fs.writeFileSync(writeTarget, output, { flag: 'wx', mode: 0o600 });
  }
}
