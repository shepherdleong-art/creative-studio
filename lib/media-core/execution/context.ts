import type Database from 'better-sqlite3';
import type { ExecutionModuleContext, ExecutionModuleLifecycle } from './contracts.ts';

export type Currency = 'CNY';
export interface Money { currency: Currency; minor: number }
export type CostQuote =
  | { kind: 'priced'; reserve: Money; pricingSnapshot: unknown }
  | { kind: 'unpriced'; pricingSnapshot?: unknown };

export type SubmissionState = 'not_sent' | 'maybe_sent' | 'accepted' | 'terminal';
export type TerminalState = 'succeeded' | 'failed' | 'not_created';
export type CostState = 'reserved' | 'unknown' | 'settled' | 'released';

export interface ExecutionScope { resourceType: string; resourceId: string }
export interface InstanceFence { instanceId: string; fence: number }

export interface OperationRecord {
  id: string;
  operationKey: string;
  actorId: string;
  scopeType: string;
  scopeId: string;
  module: string;
  taskId: string;
  step: string;
  inputRevision: string;
  businessAttemptId: string;
  businessAttemptNo: number;
  inputHash: string;
  inputSnapshot: unknown;
  continuationKey: string;
  providerSnapshot: unknown;
  configVersion: string | null;
  credentialVersionRef: string | null;
  requiredPools: string[];
  quote: CostQuote;
  status: string;
  readySeq: number;
  waitReason: string | null;
  waitDetail: string | null;
  currentPermitId: string | null;
  currentAttemptId: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRecord {
  id: string;
  operationId: string;
  permitId: string;
  actorId: string;
  businessAttemptNo: number;
  submitRound: number;
  transportSeq: number;
  requestHash: string | null;
  providerSnapshot: unknown;
  pricingSnapshot: unknown;
  submissionState: SubmissionState;
  terminalState: TerminalState | null;
  instanceId: string;
  fence: number;
  leaseOwner: string;
  leaseUntil: string;
  remoteId: string | null;
  receipt: unknown;
  intentJournalSeq: number | null;
  receiptJournalSeq: number | null;
  errorCode: string | null;
  policyVersion: number;
  accountingPeriod: string;
  currency: Currency;
  reservedMinor: number;
  actualMinor: number | null;
  costState: CostState;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  operationKey: string;
  actor: { userId: string };
  scope: ExecutionScope;
  module: string;
  taskId: string;
  step: string;
  inputRevision: string;
  businessAttempt: { id: string; number: number };
  inputSnapshot: unknown;
  inputHash: string;
  continuationKey: string;
  providerSnapshot: unknown;
  configVersion?: string;
  credentialVersionRef?: string;
  requiredPools: readonly string[];
  quote: CostQuote;
  persistCheckpoint?: (db: Database.Database) => void;
}

export interface EnqueueResult {
  kind: 'deferred' | 'completed';
  operation: OperationRecord;
  replayed: boolean;
}

export type AdmissionWaitReason =
  | 'maintenance'
  | 'actor_disabled'
  | 'scope_forbidden'
  | 'actor_paused'
  | 'personal_concurrency'
  | 'pool_missing'
  | 'pool_disabled'
  | 'pool_capacity'
  | 'pricing_required'
  | 'currency_mismatch'
  | 'monthly_budget'
  | 'cost_unknown';

export type AdmitResult =
  | { kind: 'admitted'; grant: ExecutionGrant }
  | { kind: 'idle' }
  | { kind: 'deferred'; reasons: AdmissionWaitReason[] };

export interface ExecutionGrant {
  operation: OperationRecord;
  permitId: string;
  attempt: AttemptRecord;
  inputSnapshot: unknown;
  continuationKey: string;
  instance: InstanceFence;
}

export interface ExecutionJournalRecord {
  schemaVersion: 1;
  deploymentId: string;
  seq: number;
  prevHash: string | null;
  hash: string;
  eventType: 'submit_intent' | 'receipt';
  at: string;
  operationId: string;
  attemptId: string;
  permitId: string;
  actorId: string;
  module: string;
  step: string;
  inputHash: string;
  requestHash?: string;
  transportSeq: number;
  requiredPools: string[];
  policyVersion: number;
  accountingPeriod: string;
  currency: Currency;
  reservedMinor: number;
  remoteId?: string;
  resultRef?: string;
  terminalState?: TerminalState | 'unknown';
  actualCost?: Money | null;
  costState?: CostState;
  errorCode?: string;
  reconciliationSource?: string;
}

export interface ExecutionJournal {
  appendIntent(input: Omit<ExecutionJournalRecord,
    'schemaVersion' | 'deploymentId' | 'seq' | 'prevHash' | 'hash' | 'eventType' | 'at'
    | 'remoteId' | 'resultRef' | 'terminalState' | 'actualCost' | 'costState' | 'errorCode' | 'reconciliationSource'> & {
      at?: string;
      [key: string]: unknown;
    }): ExecutionJournalRecord;
  appendReceipt(input: Omit<ExecutionJournalRecord,
    'schemaVersion' | 'deploymentId' | 'seq' | 'prevHash' | 'hash' | 'eventType' | 'at'> & {
      at?: string;
      [key: string]: unknown;
    }): ExecutionJournalRecord;
  verify(options?: { repairTail?: boolean }): { valid: boolean; records: ExecutionJournalRecord[] };
  scan(): ExecutionJournalRecord[];
}

export interface SubmitIntent extends InstanceFence {
  operationId: string;
  attemptId: string;
  permitId: string;
  actorId: string;
  submitRound: number;
  transportSeq: number;
  intentJournalSeq: number;
  requestHash: string;
}

export interface ExecutionReceipt {
  remoteId?: string;
  resultRef?: string;
  terminalState?: TerminalState;
  actualCost?: Money | null;
  errorCode?: string;
}

export interface MarkSubmittingInput {
  grant: ExecutionGrant;
  requestSnapshot: unknown;
  quote?: CostQuote;
  retryKind?: 'initial' | 'protocol_fallback';
}

export interface AttachReceiptInput { intent: SubmitIntent; receipt: ExecutionReceipt }

export type ReconcileEvidence =
  | { kind: 'remote_id'; remoteId: string; resultRef?: string }
  | { kind: 'confirmed_not_created'; errorCode?: string }
  | { kind: 'terminal'; outcome: 'succeeded' | 'failed'; actualCost?: Money | null; resultRef?: string; errorCode?: string }
  | { kind: 'still_unknown'; errorCode?: string };

export interface ReconcileInput {
  attemptId: string;
  evidence: ReconcileEvidence;
  source: 'provider' | 'journal' | 'operator';
}

export interface SettleInput {
  attemptId: string;
  outcome: 'succeeded' | 'failed' | 'not_created';
  actualCost?: Money | null;
  remoteTerminal: boolean;
  result?: unknown;
  errorCode?: string;
}

export interface ExecutionFacade {
  enqueue(input: EnqueueInput): EnqueueResult;
  admit(instance: InstanceFence & { leaseMs?: number; operationId?: string }): AdmitResult;
  markSubmitting(input: MarkSubmittingInput): Promise<SubmitIntent>;
  attachReceipt(input: AttachReceiptInput): Promise<AttemptRecord>;
  reconcile(input: ReconcileInput): Promise<AttemptRecord>;
  settle(input: SettleInput): Promise<AttemptRecord>;
  transmit(intent: SubmitIntent, send: (intent: SubmitIntent) => Promise<ExecutionReceipt>): Promise<AttemptRecord>;
}

export interface ExecutionFacadeOptions {
  db: Database.Database;
  deploymentId: string;
  journal: ExecutionJournal;
  actorAllowed(actorId: string): boolean;
  scopeAllowed(actorId: string, scope: ExecutionScope): boolean;
  maintenance(): boolean;
  now?: () => Date;
  newId?: () => string;
  mirrorUsage?: (record: { attemptId: string; actualCost: Money | null; outcome: TerminalState }) => void | Promise<void>;
  faults?: {
    beforeIntentDatabase?: () => void;
    beforeReceiptDatabase?: () => void;
  };
}

export interface ExecutionRuntime {
  facade: ExecutionFacade;
  lifecycle: ExecutionModuleLifecycle;
  closeNewWork(): void;
}

export class ExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export function assertExecutionContext(options: Partial<ExecutionFacadeOptions>): void {
  if (!options.db) throw new ExecutionError('execution_context_required', 'server 执行缺少数据库上下文。');
  if (!options.deploymentId?.trim()) throw new ExecutionError('execution_context_required', 'server 执行缺少 deploymentId。');
  if (!options.journal) throw new ExecutionError('execution_journal_required', 'server 执行缺少独立 journal。');
  if (!options.actorAllowed || !options.scopeAllowed || !options.maintenance) {
    throw new ExecutionError('execution_context_required', 'server 执行缺少用户或 scope 状态检查。');
  }
}

export function assertMoney(value: Money): void {
  if (value.currency !== 'CNY') {
    throw new ExecutionError('currency_mismatch', '执行费用只支持 CNY 整数最小货币单位。');
  }
  if (!Number.isSafeInteger(value.minor) || value.minor < 0) {
    throw new ExecutionError('invalid_money', '费用必须是非负安全整数 minor。');
  }
}

export function executionContext(instance: InstanceFence, deploymentId: string, signal: AbortSignal): ExecutionModuleContext {
  return { ...instance, deploymentId, signal };
}
