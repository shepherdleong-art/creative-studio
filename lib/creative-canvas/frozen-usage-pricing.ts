import type Database from 'better-sqlite3';

/** Undefined means no admitted attempt; null means its frozen quote cannot be priced. */
export function readCanvasTaskPricingSnapshot(
  db: Database.Database, taskId: string,
): Record<string, unknown> | null | undefined {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('execution_attempts', 'execution_operations')`).all() as { name: string }[];
  if (tables.length === 0) return undefined;
  if (tables.length !== 2) return null;
  try {
    const row = db.prepare(`SELECT a.pricingSnapshotJson FROM execution_attempts a
      JOIN execution_operations o ON o.id = a.operationId
      WHERE o.module = 'canvas' AND o.taskId = ?
      ORDER BY a.createdAt DESC, a.rowid DESC LIMIT 1`).get(taskId) as { pricingSnapshotJson: string | null } | undefined;
    if (!row) return undefined;
    const quote: unknown = JSON.parse(row.pricingSnapshotJson ?? 'null');
    return quote && typeof quote === 'object' && !Array.isArray(quote) ? quote as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
