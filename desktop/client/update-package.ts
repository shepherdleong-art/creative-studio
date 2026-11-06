import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import path from 'node:path';

export interface CompatibilityRange { min: number; max: number }
export interface UpdateManifestInput {
  schemaVersion: 1;
  releaseId: string;
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
  size: number;
  sha256: string;
  version: string;
  api: CompatibilityRange;
  clientStateSchema: CompatibilityRange;
  packageUrl: string;
  entry: string;
}
export interface SignedUpdateManifest extends UpdateManifestInput {
  signature: { algorithm: 'ed25519'; keyId: string; value: string };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function manifestSigningBytes(manifest: UpdateManifestInput): Buffer {
  return Buffer.from(canonical(manifest), 'utf8');
}

export function signUpdateManifest(
  manifest: UpdateManifestInput,
  privateKey: string | KeyObject,
): SignedUpdateManifest {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const value = sign(null, manifestSigningBytes(manifest), key).toString('base64');
  return { ...manifest, signature: { algorithm: 'ed25519', keyId: 'team-client-ed25519-v1', value } };
}

function rangeValid(range: CompatibilityRange): boolean {
  return Boolean(range && Number.isSafeInteger(range.min) && Number.isSafeInteger(range.max)
    && range.min >= 1 && range.max >= range.min);
}

function validPackageUrl(value: string, trustedOrigins: string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && trustedOrigins.some((origin) => new URL(origin).origin === url.origin);
  } catch { return false; }
}

export function verifyUpdateManifest(
  value: unknown,
  publicKey: string | KeyObject,
  expected: { platform: string; arch: string; trustedOrigins: string[] },
): SignedUpdateManifest {
  if (!value || typeof value !== 'object') throw new Error('更新 manifest 无效');
  const manifest = value as SignedUpdateManifest;
  if (manifest.schemaVersion !== 1 || typeof manifest.releaseId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.releaseId)
    || manifest.releaseId === '.' || manifest.releaseId === '..'
    || manifest.platform !== expected.platform || manifest.arch !== expected.arch
    || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size > 512 * 1024 ** 2
    || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || !rangeValid(manifest.api) || !rangeValid(manifest.clientStateSchema)
    || typeof manifest.packageUrl !== 'string' || !validPackageUrl(manifest.packageUrl, expected.trustedOrigins)
    || typeof manifest.entry !== 'string' || path.posix.isAbsolute(manifest.entry)
    || manifest.entry.includes('\\') || manifest.entry.split('/').some((part) => !part || part === '.' || part === '..')
    || manifest.entry.includes(':') || !manifest.signature || manifest.signature.algorithm !== 'ed25519'
    || typeof manifest.signature.value !== 'string') {
    throw new Error('更新 manifest 字段、平台或受控 URL 无效');
  }
  const { signature, ...payload } = manifest;
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  let signatureBytes: Buffer;
  try { signatureBytes = Buffer.from(signature.value, 'base64'); } catch { throw new Error('更新签名无效'); }
  if (!verify(null, manifestSigningBytes(payload), key, signatureBytes)) throw new Error('更新签名验证失败');
  return manifest;
}

export function rangeIncludes(range: CompatibilityRange, value: number): boolean {
  return Number.isSafeInteger(value) && value >= range.min && value <= range.max;
}
