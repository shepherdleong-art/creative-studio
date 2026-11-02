import { getDb } from '../db.ts';

export function writeLlmExecutionCheckpoint(
  operationId: string,
  attemptId: string,
  rawText: string,
): void {
  getDb().prepare(`
    INSERT INTO llm_execution_checkpoints (operationId, attemptId, rawText, createdAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(operationId) DO UPDATE SET
      attemptId = excluded.attemptId,
      rawText = excluded.rawText,
      createdAt = excluded.createdAt
  `).run(operationId, attemptId, rawText, new Date().toISOString());
}

export function readLlmExecutionCheckpoint(operationId: string): string | null {
  const row = getDb().prepare(`
    SELECT rawText FROM llm_execution_checkpoints WHERE operationId = ?
  `).get(operationId) as { rawText?: string } | undefined;
  return typeof row?.rawText === 'string' ? row.rawText : null;
}
