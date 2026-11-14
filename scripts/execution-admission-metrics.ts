import type Database from 'better-sqlite3';

export interface SnapshotReadStats {
  /** 实际从 SQLite 行里搬进 JS 的输入/结果快照字节数。 */
  snapshotBytes: number;
  snapshotRows: number;
  statements: number;
}

type Row = Record<string, unknown>;

/**
 * 性能预算探针：包装 prepare，统计执行操作读取到的完整快照体积。
 * 只用于测量准入是否搬动历史快照，不改变被测代码的查询语义。
 */
export function meterDatabase(db: Database.Database): {
  db: Database.Database;
  stats: SnapshotReadStats;
  reset(): void;
} {
  const stats: SnapshotReadStats = { snapshotBytes: 0, snapshotRows: 0, statements: 0 };
  function account(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const row = value as Row;
    for (const column of ['inputSnapshotJson', 'resultJson']) {
      const payload = row[column];
      if (typeof payload === 'string') {
        stats.snapshotBytes += Buffer.byteLength(payload);
        stats.snapshotRows += 1;
      }
    }
  }
  const proxy = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'prepare') {
        return (sql: string) => {
          stats.statements += 1;
          const statement = target.prepare(sql);
          const methods = statement as unknown as {
            get: (...args: unknown[]) => unknown;
            all: (...args: unknown[]) => unknown[];
            pluck: () => unknown;
          };
          const get = methods.get.bind(statement);
          const all = methods.all.bind(statement);
          const pluck = methods.pluck.bind(statement);
          methods.get = (...args: unknown[]) => {
            const row = get(...args);
            account(row);
            return row;
          };
          methods.all = (...args: unknown[]) => {
            const rows = all(...args);
            for (const row of rows) account(row);
            return rows;
          };
          methods.pluck = () => {
            pluck();
            return statement;
          };
          return statement;
        };
      }
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  }) as Database.Database;
  return {
    db: proxy,
    stats,
    reset() {
      stats.snapshotBytes = 0;
      stats.snapshotRows = 0;
      stats.statements = 0;
    },
  };
}

/** 与基线探针相同的合成完成历史：每条约 64 KiB 输入快照。 */
export function seedCompletedHistory(
  db: Database.Database,
  count: number,
  options: {
    status?: 'succeeded' | 'failed';
    snapshotBytes?: number;
    readySeqBase?: number;
    actorId?: string;
  } = {},
): number {
  const snapshotBytes = options.snapshotBytes ?? 64 * 1024;
  const snapshot = JSON.stringify({ frames: ['data:image/jpeg;base64,' + 'A'.repeat(snapshotBytes)] });
  const at = '2026-11-01T00:00:00.000Z';
  const base = options.readySeqBase ?? 100_000;
  const actorId = options.actorId ?? 'history-actor';
  const insert = db.prepare(`INSERT INTO execution_operations (
    id, operationKey, actorId, scopeType, scopeId, module, taskId, step, inputRevision,
    businessAttemptId, businessAttemptNo, inputHash, inputSnapshotJson, continuationKey,
    providerSnapshotJson, requiredPoolsJson, quoteJson, status, readySeq, createdAt, updatedAt
  ) VALUES (?, ?, ?, 'project', 'history-project', 'images', ?, 'submit', 'r1', ?, 1,
    'history-hash', ?, 'images.submit', '{}', '["shared"]',
    '{"kind":"priced","reserve":{"currency":"CNY","minor":1},"pricingSnapshot":{}}', ?, ?, ?, ?)`);
  const run = db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `history-${actorId}-${index}`, `history/${index}/submit/r1`, actorId,
        `history-task-${index}`, `history-attempt-${index}`, snapshot,
        options.status ?? 'succeeded', base + index, at, at,
      );
    }
  });
  run();
  return Buffer.byteLength(snapshot);
}
