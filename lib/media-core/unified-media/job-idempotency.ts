import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export class UnifiedJobRequestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiedJobRequestConflictError';
  }
}

export function normalizeUnifiedJobRequestKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (!key) return null;
  if (key.length > 200) {
    throw new UnifiedJobRequestConflictError('请求标识过长。');
  }
  return key;
}

export function unifiedJobRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Replay only the exact same logical creation request. A reused key with a
 * different prompt, source image, shot order or output contract is a conflict;
 * it must never silently return a different task.
 */
export function findUnifiedJobRequestReplay(
  db: Database.Database,
  input: {
    projectId: string;
    requestKey: string | null;
    requestHash: string;
    expectedCount: number;
    creationSource: string;
  },
): string[] | null {
  if (!input.requestKey) return null;
  const rows = db.prepare(`
    SELECT id, creationRequestHash, creationSource
    FROM jobs
    WHERE projectId = ? AND creationRequestKey = ?
    ORDER BY creationIndex, rowid
  `).all(input.projectId, input.requestKey) as Array<{
    id: string;
    creationRequestHash: string | null;
    creationSource: string | null;
  }>;
  if (rows.length === 0) return null;
  if (rows.length !== input.expectedCount
    || rows.some((row) => row.creationRequestHash !== input.requestHash
      || row.creationSource !== input.creationSource)) {
    throw new UnifiedJobRequestConflictError('同一请求标识已用于不同的图片生成请求。');
  }
  return rows.map((row) => row.id);
}
