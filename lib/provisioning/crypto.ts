import crypto from 'node:crypto';
import { MAX_LITE_LLM_CONFIG_BYTES } from './schema.ts';
import { validateProvisioningPayload } from './schema.ts';
import type { ProvisioningPayload } from './types.ts';

export const PROVISIONING_ENVELOPE_VERSION = 1 as const;
export const MAX_PROVISIONING_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PROVISIONING_PAYLOAD_BYTES = MAX_LITE_LLM_CONFIG_BYTES + 256 * 1024;
export const MIN_PROVISIONING_PASSWORD_LENGTH = 12;

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Same public error for wrong passwords, truncation and authentication failures. */
export class ProvisioningCryptoError extends Error {
  constructor() {
    super('统一配置文件无法解密或认证失败');
    this.name = 'ProvisioningCryptoError';
  }
}

function cryptoFail(): never {
  throw new ProvisioningCryptoError();
}

function passwordBytes(password: string): Buffer {
  if (typeof password !== 'string' || password.length < MIN_PROVISIONING_PASSWORD_LENGTH || password.length > 1024) cryptoFail();
  return Buffer.from(password, 'utf8');
}

function deriveKey(password: string, salt: Buffer): Buffer {
  try {
    return crypto.scryptSync(passwordBytes(password), salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    cryptoFail();
  }
}

function encoded(value: Buffer): string {
  return value.toString('base64url');
}

function decode(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) cryptoFail();
  let result: Buffer;
  try {
    result = Buffer.from(value, 'base64url');
  } catch {
    cryptoFail();
  }
  if (expectedBytes !== undefined && result.length !== expectedBytes) cryptoFail();
  return result;
}

export interface ProvisioningEnvelope {
  version: typeof PROVISIONING_ENVELOPE_VERSION;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function assertPasswordForEncryption(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PROVISIONING_PASSWORD_LENGTH || password.length > 1024) {
    throw new Error(`密码至少需要 ${MIN_PROVISIONING_PASSWORD_LENGTH} 个字符`);
  }
}

/** Encrypt a validated profile into a compact, versioned JSON envelope. */
export function encryptProvisioningPayload(payload: unknown, password: string): Buffer {
  assertPasswordForEncryption(password);
  const validated = validateProvisioningPayload(payload);
  const plaintext = Buffer.from(JSON.stringify(validated), 'utf8');
  if (plaintext.length > MAX_PROVISIONING_PAYLOAD_BYTES) throw new Error('统一配置文件内容过大');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(Buffer.from(password, 'utf8'), salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('creative-studio-provisioning-v1', 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: ProvisioningEnvelope = {
    version: PROVISIONING_ENVELOPE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: encoded(salt),
    iv: encoded(iv),
    tag: encoded(cipher.getAuthTag()),
    ciphertext: encoded(ciphertext),
  };
  const result = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (result.length > MAX_PROVISIONING_FILE_BYTES) throw new Error('统一配置文件内容过大');
  return result;
}

/** Decrypt, authenticate and strictly validate a profile. */
export function decryptProvisioningPayload(input: Uint8Array | Buffer | string, password: string): ProvisioningPayload {
  if (typeof password !== 'string' || password.length < MIN_PROVISIONING_PASSWORD_LENGTH || password.length > 1024) cryptoFail();
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_PROVISIONING_FILE_BYTES) cryptoFail();
  let envelope: unknown;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch {
    cryptoFail();
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) cryptoFail();
  const record = envelope as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'cipher,ciphertext,iv,kdf,salt,tag,version' || record.version !== 1 || record.kdf !== 'scrypt' || record.cipher !== 'aes-256-gcm') cryptoFail();
  const salt = decode(record.salt, SALT_BYTES);
  const iv = decode(record.iv, IV_BYTES);
  const tag = decode(record.tag, TAG_BYTES);
  const ciphertext = decode(record.ciphertext);
  // ciphertext is variable length; cap it separately after decoding.
  if (ciphertext.length > MAX_PROVISIONING_PAYLOAD_BYTES) cryptoFail();
  const key = deriveKey(password, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from('creative-studio-provisioning-v1', 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_PROVISIONING_PAYLOAD_BYTES) cryptoFail();
    const value = JSON.parse(plaintext.toString('utf8')) as unknown;
    return validateProvisioningPayload(value);
  } catch {
    cryptoFail();
  }
}
