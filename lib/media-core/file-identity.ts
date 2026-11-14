/**
 * 文件身份与首尾内容见证。
 *
 * 共享层纯函数：不读写数据库、不依赖 dataRoot，供团队文件登记等需要
 * “跳过重复全量哈希”的模块复用。身份 JSON 形状：
 *
 *   { dev, ino, size, mtimeMs, ctimeMs, witness: { bytes, head, tail } }
 *
 * 解析规则：缺少 `witness`（旧版本只写 dev/ino/size/mtime/ctime 的记录）或
 * 字段非法的身份一律视为不可信（返回 null），调用方必须重新完整核验。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** 首尾内容见证每端最多参与哈希的字节数。 */
export const FILE_IDENTITY_WITNESS_BYTES = 64 * 1024;

export interface FileIdentityWitness {
  /** 首/尾各自实际参与哈希的字节数（文件小于 64 KiB 时等于文件长度）。 */
  bytes: number;
  head: string;
  tail: string;
}

export interface FileStatIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  witness: FileIdentityWitness;
}

export interface FileContentInspection {
  /** 仅完整核验时提供。 */
  sha256?: string;
  witness: FileIdentityWitness;
}

function readExactAt(fd: number, buffer: Buffer, position: number): number {
  let offset = 0;
  while (offset < buffer.length) {
    const bytes = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (bytes <= 0) break;
    offset += bytes;
  }
  return offset;
}

function buildWitness(head: Buffer, headBytes: number, tail: Buffer, tailBytes: number): FileIdentityWitness {
  return {
    bytes: Math.min(headBytes, tailBytes),
    head: createHash('sha256').update(head.subarray(0, headBytes)).digest('hex'),
    tail: createHash('sha256').update(tail.subarray(0, tailBytes)).digest('hex'),
  };
}

/**
 * 计算内容见证；`full` 为真时顺带在一次顺序读里算出完整 SHA-256，
 * 身份变化时不再先读 128 KiB 再全量重读。见证单独计算时只读首尾各 64 KiB。
 */
export function inspectFileContent(filePath: string, size: number, full: boolean): FileContentInspection {
  const witnessBytes = Math.min(size, FILE_IDENTITY_WITNESS_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (!full) {
      const head = Buffer.alloc(witnessBytes);
      const tail = Buffer.alloc(witnessBytes);
      const headBytes = readExactAt(fd, head, 0);
      const tailBytes = witnessBytes === 0 ? 0 : readExactAt(fd, tail, size - witnessBytes);
      return { witness: buildWitness(head, headBytes, tail, tailBytes) };
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.byteLength, position);
      if (bytes <= 0) break;
      const chunk = buffer.subarray(0, bytes);
      hash.update(chunk);
      if (head.length < witnessBytes) {
        head = Buffer.concat([head, chunk.subarray(0, Math.min(witnessBytes - head.length, chunk.length))]);
      }
      if (witnessBytes > 0) {
        const tailChunk = chunk.length >= witnessBytes ? chunk.subarray(chunk.length - witnessBytes) : chunk;
        const keep = Math.max(0, witnessBytes - tailChunk.length);
        tail = Buffer.concat([tail.subarray(Math.max(0, tail.length - keep)), tailChunk]);
      }
      position += bytes;
    }
    return { sha256: hash.digest('hex'), witness: buildWitness(head, head.length, tail, tail.length) };
  } finally {
    fs.closeSync(fd);
  }
}

function isFileIdentityWitness(value: unknown): value is FileIdentityWitness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const witness = value as Record<string, unknown>;
  return typeof witness.bytes === 'number'
    && Number.isSafeInteger(witness.bytes)
    && witness.bytes >= 0
    && witness.bytes <= FILE_IDENTITY_WITNESS_BYTES
    && typeof witness.head === 'string'
    && /^[0-9a-f]{64}$/.test(witness.head)
    && typeof witness.tail === 'string'
    && /^[0-9a-f]{64}$/.test(witness.tail);
}

/** 把身份与见证序列化为可持久化的 JSON 字符串。 */
export function fileIdentityJson(stat: fs.Stats, witness: FileIdentityWitness): string {
  return JSON.stringify({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    witness,
  } satisfies FileStatIdentity);
}

/** 旧格式（无 witness）或字段非法的身份返回 null，调用方按不可信处理。 */
export function parseFileIdentity(value: string | null): FileStatIdentity | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.dev !== 'number' || typeof record.ino !== 'number'
      || typeof record.size !== 'number' || typeof record.mtimeMs !== 'number'
      || typeof record.ctimeMs !== 'number'
      || !isFileIdentityWitness(record.witness)
    ) return null;
    return {
      dev: record.dev,
      ino: record.ino,
      size: record.size,
      mtimeMs: record.mtimeMs,
      ctimeMs: record.ctimeMs,
      witness: record.witness,
    };
  } catch {
    return null;
  }
}

/** stat 与首尾见证全部一致时才可信任上次完整核验的结果。 */
export function fileIdentityMatches(
  stat: fs.Stats,
  witness: FileIdentityWitness,
  identityJson: string | null,
): boolean {
  const expected = parseFileIdentity(identityJson);
  if (!expected) return false;
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs
    && stat.ctimeMs === expected.ctimeMs
    && witness.bytes === expected.witness.bytes
    && witness.head === expected.witness.head
    && witness.tail === expected.witness.tail;
}
