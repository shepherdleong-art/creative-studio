import type Database from 'better-sqlite3';
import { ExecutionError } from './context.ts';

export interface TeamConcurrencyPolicy {
  mode: 'auto' | 'manual';
  manualDefaultConcurrency: number;
  version: number;
}

type TeamConcurrencyPolicyRow = TeamConcurrencyPolicy;

/** Automatic inheritance is the team default; the manual fallback remains configurable. */
export function readTeamConcurrencyPolicy(db: Database.Database): TeamConcurrencyPolicy {
  const row = db.prepare('SELECT mode, manualDefaultConcurrency, version FROM execution_team_concurrency_policy WHERE id = 1')
    .get() as TeamConcurrencyPolicyRow | undefined;
  return row ?? { mode: 'auto', manualDefaultConcurrency: 1, version: 0 };
}

export function updateTeamConcurrencyPolicy(db: Database.Database, input: {
  mode?: 'auto' | 'manual';
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
    const mode = input.mode ?? (current.version === 0 ? 'manual' : current.mode);
    db.prepare(`
      INSERT INTO execution_team_concurrency_policy (id, mode, manualDefaultConcurrency, version, updatedAt)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        manualDefaultConcurrency = excluded.manualDefaultConcurrency,
        version = excluded.version,
        updatedAt = excluded.updatedAt
    `).run(mode, input.manualDefaultConcurrency, version, new Date().toISOString());
    return readTeamConcurrencyPolicy(db);
  });
  return run.immediate();
}
