import type Database from 'better-sqlite3';
import { getExecutionModuleRuntime } from '../media-core/execution/module-runtime.ts';
import { BatchDomainError } from './errors.ts';
import type { ClaimedBatchTask } from './tasks.ts';

/** Existing LLM ledger identity is authoritative when upgrading legacy workers. */
export function resolveBatchLlmAttempt(db: Database.Database, claim: ClaimedBatchTask): { id: string; number: number } {
  const anchor = claim.businessAttempt ?? { id: claim.attempt.id, number: claim.attempt.attemptNumber };
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_operations'").get()) {
    if (getExecutionModuleRuntime()) throw new BatchDomainError('conflict', '执行台账未就绪，不能恢复远端调用');
    return anchor;
  }
  // Terminal worker attempts bound an explicit retry. Within the remaining
  // interrupted chain, a legacy worker may have created the only real intent
  // after an earlier worker died before sending. Never replace that intent.
  const records = db.prepare(`
    SELECT o.businessAttemptId AS id, o.businessAttemptNo AS number,
           o.inputRevision, o.operationKey, o.step, o.scopeType, o.scopeId, a.attemptNumber
    FROM execution_operations o
    LEFT JOIN batch_task_attempts a ON a.taskId = o.taskId AND a.id = o.businessAttemptId
    WHERE o.module = 'llm' AND o.taskId = ?
      AND (a.attemptNumber BETWEEN ? AND ? OR o.businessAttemptNo BETWEEN ? AND ?)
  `).all(claim.task.id, anchor.number, claim.attempt.attemptNumber, anchor.number, claim.attempt.attemptNumber) as Array<{
    id: string; number: number; inputRevision: string; operationKey: string; step: string; scopeType: string; scopeId: string; attemptNumber: number | null;
  }>;
  const identities = new Map<string, { id: string; number: number }>();
  for (const record of records) {
    if (record.number !== record.attemptNumber || record.inputRevision !== record.id
      || record.operationKey !== ['llm', claim.task.id, record.step, record.id].join('/')
      || record.scopeType !== 'project' || record.scopeId !== claim.task.projectId) {
      throw new BatchDomainError('conflict', '历史执行意图身份不一致，请先核对执行台账');
    }
    identities.set(record.id, { id: record.id, number: record.number });
  }
  if (identities.size > 1) {
    throw new BatchDomainError('conflict', '任务存在多个历史执行意图，请先核对执行台账后再显式重试');
  }
  return identities.values().next().value ?? anchor;
}
