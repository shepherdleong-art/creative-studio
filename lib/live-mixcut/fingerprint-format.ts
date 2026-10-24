/** 内容指纹的纯格式规则，浏览器和 Node 共用；不依赖文件系统。 */
const FINGERPRINT_PREFIX = 'sha256:';
const HEX_RE = /^[a-f0-9]{64}$/;

export function normalizeFingerprint(raw: string): string {
  if (raw.startsWith(FINGERPRINT_PREFIX)) {
    const hex = raw.slice(FINGERPRINT_PREFIX.length);
    if (!HEX_RE.test(hex)) throw new Error(`无效的内容指纹格式: ${raw}`);
    return raw;
  }
  if (HEX_RE.test(raw)) return `${FINGERPRINT_PREFIX}${raw}`;
  throw new Error(`无效的内容指纹格式: ${raw}`);
}

export function fingerprintHex(raw: string): string {
  return normalizeFingerprint(raw).slice(FINGERPRINT_PREFIX.length);
}

export function fingerprintsEqual(a: string, b: string): boolean {
  try { return normalizeFingerprint(a) === normalizeFingerprint(b); } catch { return false; }
}

export function isNormalizedFingerprint(value: string): boolean {
  return value.startsWith(FINGERPRINT_PREFIX) && HEX_RE.test(value.slice(FINGERPRINT_PREFIX.length));
}
