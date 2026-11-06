import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

export class TeamRuntimeOwnerTimeoutError extends Error {
  constructor() {
    super('另一个团队服务实例仍持有此数据根的执行权');
    this.name = 'TeamRuntimeOwnerTimeoutError';
  }
}

export interface TeamRuntimeOwner {
  readonly instanceId: string;
  readonly fence: number;
  assertActive(): void;
  release(): void;
}

function isBusy(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'SQLITE_BUSY',
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireTeamRuntimeOwner(options: {
  dataRoot: string;
  instanceId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<TeamRuntimeOwner> {
  const dataDirectory = path.join(options.dataRoot, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const lockDb = new Database(path.join(dataDirectory, 'team-runtime.lock.db'));
  lockDb.pragma('busy_timeout = 0');
  const deadline = Date.now() + Math.max(0, options.timeoutMs ?? 5_000);
  const pollIntervalMs = options.pollIntervalMs ?? 100;

  while (true) {
    try {
      lockDb.exec('BEGIN IMMEDIATE');
      break;
    } catch (error) {
      if (!isBusy(error)) {
        lockDb.close();
        throw error;
      }
      if (Date.now() >= deadline) {
        lockDb.close();
        throw new TeamRuntimeOwnerTimeoutError();
      }
      await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  let fence = 0;
  try {
    // 锁与 fence 账本使用不同数据库：持锁事务期间仍可提交 fence，
    // 进程异常退出后 SQLite 自动释放锁，而已提交的 fence 不会回滚重用。
    const ownerDb = new Database(path.join(dataDirectory, 'team-runtime-owner.db'));
    try {
      ownerDb.exec(`
        CREATE TABLE IF NOT EXISTS team_runtime_owner_history (
          instanceId TEXT PRIMARY KEY,
          fence INTEGER NOT NULL UNIQUE CHECK(fence > 0),
          acquiredAt TEXT NOT NULL
        )
      `);
      const current = ownerDb.prepare(`
        SELECT COALESCE(MAX(fence), 0) AS fence FROM team_runtime_owner_history
      `).get() as { fence: number };
      fence = current.fence + 1;
      ownerDb.prepare(`
        INSERT INTO team_runtime_owner_history (instanceId, fence, acquiredAt)
        VALUES (?, ?, ?)
      `).run(options.instanceId, fence, new Date().toISOString());
    } finally {
      ownerDb.close();
    }
  } catch (error) {
    lockDb.exec('ROLLBACK');
    lockDb.close();
    throw error;
  }

  let active = true;
  return {
    instanceId: options.instanceId,
    fence,
    assertActive() {
      if (!active) throw new Error('团队服务执行权已经释放');
    },
    release() {
      if (!active) return;
      active = false;
      try {
        if (lockDb.inTransaction) lockDb.exec('ROLLBACK');
      } finally {
        lockDb.close();
      }
    },
  };
}
