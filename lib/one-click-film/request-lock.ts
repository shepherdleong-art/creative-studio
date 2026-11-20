import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataRoot } from '../data-root.ts';
import { acquireSchemaUpgradeLock, SchemaUpgradeLockTimeoutError } from '../schema-upgrade/lock.ts';

/** SQLite releases this per-request write lock even when the serving process exits. */
export async function tryFilmRequestLock(kind: 'analysis' | 'narration', identity: string[]) {
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  try {
    return await acquireSchemaUpgradeLock({
      lockDatabasePath: path.join(dataRoot(), 'storage', 'run', 'one-click-film', kind, key + '.lock'),
      timeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof SchemaUpgradeLockTimeoutError) return null;
    throw error;
  }
}
