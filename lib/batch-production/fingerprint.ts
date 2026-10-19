import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * 统一内容指纹格式、解析和比较接口。
 *
 * 本项目中所有内容身份(素材、LUT、代理键中间产物)统一使用 `sha256:<64 lowercase hex>` 格式。
 * 禁止各模块自行拼接/拆分前缀——一律通过本模块提供的函数操作。
 *
 * 格式规则:
 * - 有效指纹: `sha256:<64小写十六进制字符>`
 * - 裸 64 位 hex(LUT 导入/旧 batch_assets)在比较时视为等价的 sha256 指纹。
 */

const FINGERPRINT_PREFIX = 'sha256:';
const HEX_RE = /^[a-f0-9]{64}$/;

/** 把裸 hex 归一化为 `sha256:<hex>`;已经是 `sha256:<hex>` 的直接返回。 */
export function normalizeFingerprint(raw: string): string {
  if (raw.startsWith(FINGERPRINT_PREFIX)) {
    const hex = raw.slice(FINGERPRINT_PREFIX.length);
    if (!HEX_RE.test(hex)) {
      throw new Error(`无效的内容指纹格式: ${raw}`);
    }
    return raw;
  }
  if (HEX_RE.test(raw)) {
    return `${FINGERPRINT_PREFIX}${raw}`;
  }
  throw new Error(`无效的内容指纹格式: ${raw}`);
}

/** 提取 hex 部分(不含 `sha256:` 前缀),用于文件系统命名等场景。 */
export function fingerprintHex(raw: string): string {
  const normalized = normalizeFingerprint(raw);
  return normalized.slice(FINGERPRINT_PREFIX.length);
}

/** 比较两个指纹是否指向同一内容(同时接受 `sha256:<hex>` 和裸 hex)。 */
export function fingerprintsEqual(a: string, b: string): boolean {
  try {
    return normalizeFingerprint(a) === normalizeFingerprint(b);
  } catch {
    return false;
  }
}

/** 判断一个字符串是否已经是规范化的指纹格式(`sha256:<64 lowercase hex>`)。 */
export function isNormalizedFingerprint(value: string): boolean {
  return value.startsWith(FINGERPRINT_PREFIX) && HEX_RE.test(value.slice(FINGERPRINT_PREFIX.length));
}

/** 从 Buffer 计算规范化的内容指纹(`sha256:<hex>`)。 */
export function computeFingerprintFromBuffer(data: Buffer): string {
  const hex = createHash('sha256').update(data).digest('hex');
  return `${FINGERPRINT_PREFIX}${hex}`;
}

/** 从文件完整内容计算规范化的内容指纹(`sha256:<hex>`)。 */
export async function computeFingerprintFromFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const hex = hash.digest('hex');
  return `${FINGERPRINT_PREFIX}${hex}`;
}
