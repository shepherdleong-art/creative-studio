import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class SchemaUpgradeLockTimeoutError extends Error {
  constructor(message = '等待数据库升级锁超时') {
    super(message);
    this.name = 'SchemaUpgradeLockTimeoutError';
  }
}

export interface SchemaUpgradeLock {
  release(): void;
}

export interface AcquireSchemaUpgradeLockOptions {
  lockDatabasePath: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

function isBusyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'SQLITE_BUSY',
  );
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

export async function acquireSchemaUpgradeLock(
  options: AcquireSchemaUpgradeLockOptions,
): Promise<SchemaUpgradeLock> {
  const {
    lockDatabasePath,
    timeoutMs = 15_000,
    pollIntervalMs = 100,
    signal,
  } = options;
  fs.mkdirSync(path.dirname(lockDatabasePath), { recursive: true });

  const lockDb = new Database(lockDatabasePath);
  lockDb.pragma('busy_timeout = 0');
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    signal?.throwIfAborted();
    try {
      lockDb.exec('BEGIN IMMEDIATE');
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            if (lockDb.inTransaction) lockDb.exec('COMMIT');
          } finally {
            lockDb.close();
          }
        },
      };
    } catch (error) {
      if (!isBusyError(error)) {
        lockDb.close();
        throw error;
      }
      if (Date.now() >= deadline) {
        lockDb.close();
        throw new SchemaUpgradeLockTimeoutError();
      }
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
    }
  }
}
