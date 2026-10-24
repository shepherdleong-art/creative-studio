import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { normalizeFingerprint } from './fingerprint-format.ts';
export { normalizeFingerprint, fingerprintHex, fingerprintsEqual, isNormalizedFingerprint } from './fingerprint-format.ts';

/**
 * 统一内容指纹格式、解析和比较接口。
 *
 * 本项目中所有内容身份(素材、LUT、代理键中间产物)统一使用 `sha256:<64 lowercase hex>` 格式。
 * 禁止各模块自行拼接/拆分前缀——一律通过本模块提供的函数操作。
 *
 * 格式规则:
 * - 有效指纹: `sha256:<64小写十六进制字符>`
 * - 裸 64 位 hex(LUT 导入/旧 live_mixcut_assets)在比较时视为等价的 sha256 指纹。
 */

/** 从 Buffer 计算规范化的内容指纹(`sha256:<hex>`)。 */
export function computeFingerprintFromBuffer(data: Buffer): string {
  const hex = createHash('sha256').update(data).digest('hex');
  return normalizeFingerprint(hex);
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
  return normalizeFingerprint(hex);
}
