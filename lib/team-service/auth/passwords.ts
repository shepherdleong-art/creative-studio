import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { TeamAuthError } from './types.ts';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const PRODUCTION_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
});

const KEY_LENGTH = 64;

export class BoundedKdfScheduler {
  private active = 0;
  private readonly queue: Array<{
    run: () => void;
  }> = [];

  private readonly options: { maxConcurrent: number; maxQueue: number };

  constructor(options: { maxConcurrent: number; maxQueue: number }) {
    this.options = options;
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1
      || !Number.isInteger(options.maxQueue) || options.maxQueue < 0) {
      throw new Error('KDF 并发与队列上限必须是有效整数');
    }
  }

  schedule<T>(task: () => Promise<T>): Promise<T> {
    if (this.active + this.queue.length >= this.options.maxConcurrent + this.options.maxQueue) {
      return Promise.reject(new TeamAuthError('kdf_busy', '密码校验繁忙，请稍后重试。', 429));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: () => {
          this.active += 1;
          void task().then(resolve, reject).finally(() => {
            this.active -= 1;
            this.queue.shift()?.run();
          });
        },
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.options.maxConcurrent && this.queue.length > 0) {
      this.queue.shift()?.run();
    }
  }
}

function assertParams(params: ScryptParams): void {
  if (!Number.isInteger(params.N) || params.N < 2 || params.N > 2 ** 20
    || (params.N & (params.N - 1)) !== 0
    || !Number.isInteger(params.r) || params.r < 1 || params.r > 32
    || !Number.isInteger(params.p) || params.p < 1 || params.p > 4) {
    throw new TeamAuthError('password_hash_invalid', '密码哈希参数无效。', 500);
  }
}

function maxMemory(params: ScryptParams): number {
  return Math.max(64 * 1024 * 1024, 256 * params.N * params.r + 1024 * 1024);
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  assertParams(params);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: maxMemory(params),
    }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function encodePasswordHash(params: ScryptParams, salt: Buffer, hash: Buffer): string {
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function decodePasswordHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!match) return null;
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  try {
    assertParams(params);
  } catch {
    return null;
  }
  const salt = Buffer.from(match[4], 'base64url');
  const hash = Buffer.from(match[5], 'base64url');
  if (salt.length < 16 || hash.length !== KEY_LENGTH) return null;
  return { params, salt, hash };
}

export async function hashPassword(
  password: string,
  scheduler: BoundedKdfScheduler,
  params: ScryptParams = PRODUCTION_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(24);
  return scheduler.schedule(async () => {
    const hash = await derive(password, salt, params);
    return encodePasswordHash(params, salt, hash);
  });
}

export async function verifyPassword(
  password: string,
  stored: string,
  scheduler: BoundedKdfScheduler,
): Promise<boolean> {
  const decoded = decodePasswordHash(stored);
  if (!decoded) return false;
  return scheduler.schedule(async () => {
    const actual = await derive(password, decoded.salt, decoded.params);
    const matches = actual.length === decoded.hash.length && timingSafeEqual(actual, decoded.hash);
    actual.fill(0);
    return matches;
  });
}

export function generateOneTimeCredential(): string {
  return String(randomInt(100_000, 1_000_000));
}
