import type Database from 'better-sqlite3';
import type { AttemptRecord, OperationRecord } from './context.ts';

interface OperationRow {
  id: string; operationKey: string; actorId: string; scopeType: string; scopeId: string;
  module: string; taskId: string; step: string; inputRevision: string;
  businessAttemptId: string; businessAttemptNo: number; inputHash: string; inputSnapshotJson: string;
  continuationKey: string; providerSnapshotJson: string; configVersion: string | null;
  credentialVersionRef: string | null; requiredPoolsJson: string; quoteJson: string;
  status: string; readySeq: number; waitReason: string | null; waitDetail: string | null;
  currentPermitId: string | null; currentAttemptId: string | null; resultJson: string | null;
  mediaTaskId: string | null; channelKey: string | null;
  createdAt: string; updatedAt: string;
}

interface AttemptRow {
  id: string; operationId: string; permitId: string; actorId: string; businessAttemptNo: number;
  submitRound: number; transportSeq: number; requestHash: string | null;
  providerSnapshotJson: string; pricingSnapshotJson: string | null;
  submissionState: AttemptRecord['submissionState']; terminalState: AttemptRecord['terminalState'];
  instanceId: string; fence: number; leaseOwner: string; leaseUntil: string;
  remoteId: string | null; receiptJson: string | null; intentJournalSeq: number | null;
  receiptJournalSeq: number | null; errorCode: string | null; policyVersion: number;
  accountingPeriod: string; currency: 'CNY'; reservedMinor: number; actualMinor: number | null;
  costState: AttemptRecord['costState']; createdAt: string; updatedAt: string;
}

export function mapOperation(row: OperationRow): OperationRecord {
  return {
    ...row,
    inputSnapshot: JSON.parse(row.inputSnapshotJson) as unknown,
    providerSnapshot: JSON.parse(row.providerSnapshotJson) as unknown,
    requiredPools: JSON.parse(row.requiredPoolsJson) as string[],
    quote: JSON.parse(row.quoteJson) as OperationRecord['quote'],
    result: row.resultJson === null ? null : JSON.parse(row.resultJson) as unknown,
  };
}

export function readOperation(db: Database.Database, id: string): OperationRecord {
  const row = db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(id) as OperationRow | undefined;
  if (!row) throw new Error('执行操作不存在。');
  return mapOperation(row);
}

export function readAttempt(db: Database.Database, id: string): AttemptRecord {
  const row = db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
  if (!row) throw new Error('执行尝试不存在。');
  return mapAttempt(row);
}

export function mapAttempt(row: AttemptRow): AttemptRecord {
  return {
    ...row,
    providerSnapshot: JSON.parse(row.providerSnapshotJson) as unknown,
    pricingSnapshot: row.pricingSnapshotJson === null ? null : JSON.parse(row.pricingSnapshotJson) as unknown,
    receipt: row.receiptJson === null ? null : JSON.parse(row.receiptJson) as unknown,
  };
}
