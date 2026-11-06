import type Database from 'better-sqlite3';
import { ExecutionError } from './context.ts';

export interface TeamConcurrencyPolicy {
  mode: 'manual';
  manualDefaultConcurrency: number;
  version: number;
}

interface TeamConcurrencyPolicyRow extends TeamConcurrencyPolicy {
  mode: 'manual';
}

/** Only an explicitly saved default changes the missing-row zero concurrency behavior. */
export function readTeamConcurrencyPolicy(db: Database.Database): TeamConcurrencyPolicy {
  const row = db.prepare('SELECT mode, manualDefaultConcurrency, version FROM execution_team_concurrency_policy WHERE id = 1')
    .get() as TeamConcurrencyPolicyRow | undefined;
  return row ?? { mode: 'manual', manualDefaultConcurrency: 0, version: 0 };
}

export function updateTeamConcurrencyPolicy(db: Database.Database, input: {
  manualDefaultConcurrency: number;
  expectedVersion: number;
}): TeamConcurrencyPolicy {
  if (!Number.isSafeInteger(input.manualDefaultConcurrency) || input.manualDefaultConcurrency < 0) {
    throw new ExecutionError('invalid_input', '团队手动默认并发必须是非负安全整数。');
  }
  const run = db.transaction(() => {
    const current = readTeamConcurrencyPolicy(db);
    if (current.version !== input.expectedVersion) {
      throw new ExecutionError('policy_version_conflict', `团队并发策略 version 已变化，期望 ${input.expectedVersion}，实际 ${current.version}。`);
    }
    const version = current.version + 1;
    db.prepare(`
      INSERT INTO execution_team_concurrency_policy (id, mode, manualDefaultConcurrency, version, updatedAt)
      VALUES (1, 'manual', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        manualDefaultConcurrency = excluded.manualDefaultConcurrency,
        version = excluded.version,
        updatedAt = excluded.updatedAt
    `).run(input.manualDefaultConcurrency, version, new Date().toISOString());
    return readTeamConcurrencyPolicy(db);
  });
  return run.immediate();
}
