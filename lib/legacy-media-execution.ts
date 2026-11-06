import { createHash } from 'node:crypto';
import { getDb } from './db.ts';
import { requireAccessContext } from './media-core/access-context.ts';
import {
  ExecutionError,
  type AttemptRecord,
  type CostQuote,
  type ExecutionFacade,
  type ExecutionGrant,
  type ExecutionReceipt,
  type InstanceFence,
} from './media-core/execution/context.ts';
import { readExecutionPool, readExecutionPoolBinding, mediaUpstreamBindingKey } from './media-core/execution/pools.ts';

export function isServerMediaExecution(): boolean {
  return (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local') === 'server';
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}

function upstreamFingerprint(baseUrl: string, apiKey: string): string {
  return createHash('sha256').update(`${normalizedBaseUrl(baseUrl)}\0${apiKey.trim()}`).digest('hex');
}

export function legacyMediaProviderPoolKey(baseUrl: string, apiKey: string): string {
  return `media-upstream:${upstreamFingerprint(baseUrl, apiKey).slice(0, 32)}`;
}

export function legacyMediaProviderCredentialFingerprint(baseUrl: string, apiKey: string): string {
  return upstreamFingerprint(baseUrl, apiKey);
}

export function configureLegacyMediaProviderPool(input: {
  baseUrl: string;
  apiKey: string;
  capacity?: number;
}): string {
  const poolKey = legacyMediaProviderPoolKey(input.baseUrl, input.apiKey);
  const capacity = input.capacity ?? 10;
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error('媒体上游池容量必须是非负整数。');
  const db = getDb();
  const fingerprint = upstreamFingerprint(input.baseUrl, input.apiKey);
  db.prepare(`
    INSERT INTO execution_pools (poolKey, kind, capacity, enabled, mappingSnapshotJson, version, updatedAt)
    VALUES (?, 'remote', ?, 1, ?, 1, ?)
    ON CONFLICT(poolKey) DO UPDATE SET capacity = excluded.capacity, updatedAt = excluded.updatedAt
  `).run(poolKey, capacity, JSON.stringify({
    protocol: 'legacy-media-upstream/1',
    baseUrl: normalizedBaseUrl(input.baseUrl),
    credentialFingerprint: fingerprint,
  }), new Date().toISOString());
  return poolKey;
}

function ensureProviderPool(baseUrl: string, apiKey: string): string {
  const fingerprint = upstreamFingerprint(baseUrl, apiKey);
  const binding = readExecutionPoolBinding(getDb(), mediaUpstreamBindingKey(fingerprint));
  const poolKey = binding?.poolKey ?? legacyMediaProviderPoolKey(baseUrl, apiKey);
  const pool = readExecutionPool(getDb(), poolKey);
  const mapping = pool.mappingSnapshot as {
    protocol?: unknown; baseUrl?: unknown; credentialFingerprint?: unknown; credentialFingerprints?: unknown;
  } | null;
  if (binding) {
    const members = Array.isArray(mapping?.credentialFingerprints)
      ? mapping!.credentialFingerprints.filter((item): item is string => typeof item === 'string') : [];
    if (pool.kind !== 'remote' || mapping?.protocol !== 'media-upstream-pool/1'
      || mapping?.baseUrl !== normalizedBaseUrl(baseUrl)
      || !members.includes(fingerprint)) {
      throw new ExecutionError('pool_mapping_mismatch', `受控资源池 ${poolKey} 的共享账户映射未核验，拒绝付费提交。`);
    }
    return poolKey;
  }
  if (pool.kind !== 'remote' || mapping?.protocol !== 'legacy-media-upstream/1'
    || mapping?.baseUrl !== normalizedBaseUrl(baseUrl)
    || mapping?.credentialFingerprint !== fingerprint) {
    throw new ExecutionError('pool_mapping_mismatch', `受控资源池 ${poolKey} 的供应商映射未核验，拒绝付费提交。`);
  }
  return poolKey;
}

export function isLegacyMediaPoolConfigurationError(error: unknown): boolean {
  return error instanceof ExecutionError && ['pool_missing', 'pool_mapping_mismatch'].includes(error.code);
}

interface LegacyExecutionInjection {
  facade: ExecutionFacade;
  instance: InstanceFence;
}

const INJECTION_KEY = Symbol.for('creative-studio.legacy-media-execution');

function injection(): LegacyExecutionInjection {
  const value = (globalThis as unknown as Record<symbol, LegacyExecutionInjection | undefined>)[INJECTION_KEY];
  if (!value) throw new ExecutionError('execution_not_ready', '旧媒体队列缺少 server 执行上下文。');
  return value;
}

export function setLegacyMediaExecutionRuntime(value: LegacyExecutionInjection | null): void {
  const globals = globalThis as unknown as Record<symbol, LegacyExecutionInjection | undefined>;
  if (value) globals[INJECTION_KEY] = value;
  else delete globals[INJECTION_KEY];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export class LegacyMediaSubmissionUnknownError extends Error {
  readonly attemptId?: string;

  constructor(message: string, attemptId?: string) {
    super(message);
    this.name = 'LegacyMediaSubmissionUnknownError';
    this.attemptId = attemptId;
  }
}

export class LegacyMediaNotCreatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyMediaNotCreatedError';
  }
}

export class LegacyMediaProviderRecoveryBlockedError extends Error {
  constructor() {
    super('在途任务的供应商配置或凭据版本已变化，缺少原凭据版本解析设施，已停止续查；恢复原配置后再试。');
    this.name = 'LegacyMediaProviderRecoveryBlockedError';
  }
}

export function isLegacyMediaSubmissionUnknown(error: unknown): error is LegacyMediaSubmissionUnknownError {
  return error instanceof LegacyMediaSubmissionUnknownError;
}

export function isLegacyMediaProviderRecoveryBlocked(error: unknown): error is LegacyMediaProviderRecoveryBlockedError {
  return error instanceof LegacyMediaProviderRecoveryBlockedError;
}

function explicitNotCreated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:API error|submit error|HTTP)[ )]*(400|401|403|404|409|413|422)\b/i.test(message);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/(?:API error|submit error|HTTP[ )]+)(\d{3})\b/i)?.[1];
  return status ? `provider_http_${status}` : 'provider_rejected';
}

export class LegacyMediaExecutionDeferredError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`旧媒体操作已持久 deferred：${reasons.join(',') || '等待重新领取'}`);
    this.name = 'LegacyMediaExecutionDeferredError';
    this.reasons = reasons;
  }
}

export function isLegacyMediaExecutionDeferred(error: unknown): error is LegacyMediaExecutionDeferredError {
  return error instanceof LegacyMediaExecutionDeferredError;
}

function admitFor(operationId: string): ExecutionGrant {
  const { facade, instance } = injection();
  const result = facade.admit({ ...instance, operationId });
  if (result.kind === 'admitted') return result.grant;
  if (result.kind === 'deferred') throw new LegacyMediaExecutionDeferredError(result.reasons);
  throw new ExecutionError('execution_not_ready', '旧媒体操作当前不可领取，禁止绕过定向准入。');
}

function currentAttempt(operationId: string): AttemptRecord | null {
  const row = getDb().prepare(`
    SELECT a.* FROM execution_operations o
    JOIN execution_attempts a ON a.id = o.currentAttemptId
    WHERE o.id = ?
  `).get(operationId) as AttemptRecord | undefined;
  return row ?? null;
}

export interface LegacyMediaProviderSnapshot {
  providerId: string;
  type: string;
  model: string;
  baseUrl: string;
}

export function assertLegacyMediaProviderRecovery(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
  providerSnapshot: LegacyMediaProviderSnapshot;
  credentialIdentity: string;
}): void {
  if (!isServerMediaExecution()) return;
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const row = getDb().prepare(`
    SELECT providerSnapshotJson, configVersion, credentialVersionRef FROM execution_operations
    WHERE module = ? AND taskId = ? AND operationKey = ?
  `).get(input.module, input.taskId, operationKey) as {
    providerSnapshotJson: string; configVersion: string | null; credentialVersionRef: string | null;
  } | undefined;
  if (!row) return;
  let frozenProvider: unknown;
  try {
    frozenProvider = JSON.parse(row.providerSnapshotJson);
  } catch {
    throw new LegacyMediaProviderRecoveryBlockedError();
  }
  const configVersion = row.configVersion ?? hash(frozenProvider);
  const credentialVersion = upstreamFingerprint(input.providerSnapshot.baseUrl, input.credentialIdentity);
  if (configVersion !== hash(input.providerSnapshot) || row.credentialVersionRef !== credentialVersion) {
    throw new LegacyMediaProviderRecoveryBlockedError();
  }
}

export interface LegacyMediaSubmitInput<T> {
  module: 'image' | 'video';
  taskId: string;
  projectId: string;
  inputRevision: string;
  inputSnapshot: unknown;
  requestSnapshot: unknown;
  providerSnapshot: LegacyMediaProviderSnapshot;
  baseUrl: string;
  apiKey: string;
  credentialIdentity?: string;
  quote: CostQuote;
  signal?: AbortSignal;
  onAdmitted?: () => void;
  send: () => Promise<{ value: T; receipt: ExecutionReceipt }>;
}

export interface LegacyMediaSubmitResult<T> {
  value?: T;
  attemptId: string;
  remoteId?: string;
  resumed: boolean;
}

export async function submitLegacyMediaOperation<T>(input: LegacyMediaSubmitInput<T>): Promise<LegacyMediaSubmitResult<T>> {
  if (!isServerMediaExecution()) throw new Error('本地媒体提交不得进入 server execution。');
  const access = requireAccessContext();
  if (access.kind !== 'team') throw new ExecutionError('execution_context_required', '旧媒体提交缺少团队发起人。');
  const { facade } = injection();
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const revisionNumber = Number(input.inputRevision.replace(/\D/g, '')) + 1 || 1;
  const credentialIdentity = input.credentialIdentity ?? input.apiKey;
  const poolKey = ensureProviderPool(input.baseUrl, credentialIdentity);
  const enqueued = facade.enqueue({
    operationKey,
    actor: { userId: access.actor.userId },
    scope: { resourceType: 'project', resourceId: input.projectId },
    module: input.module,
    taskId: input.taskId,
    step: 'submit',
    inputRevision: input.inputRevision,
    businessAttempt: { id: `${input.taskId}:${input.inputRevision}`, number: revisionNumber },
    inputSnapshot: input.inputSnapshot,
    inputHash: hash(input.inputSnapshot),
    continuationKey: `legacy-${input.module}.submit`,
    providerSnapshot: input.providerSnapshot,
    configVersion: hash(input.providerSnapshot),
    credentialVersionRef: upstreamFingerprint(input.baseUrl, credentialIdentity),
    requiredPools: [poolKey],
    quote: input.quote,
  });
  if (enqueued.replayed && ['unknown', 'maybe_sent', 'reconciling', 'succeeded', 'failed'].includes(enqueued.operation.status)) {
    throw new LegacyMediaSubmissionUnknownError('该提交结果尚未明确，禁止重复付费。', enqueued.operation.currentAttemptId ?? undefined);
  }
  const existing = currentAttempt(enqueued.operation.id);
  if (existing?.submissionState === 'accepted' && existing.remoteId) {
    return { attemptId: existing.id, remoteId: existing.remoteId, resumed: true };
  }

  const grant = admitFor(enqueued.operation.id);
  input.onAdmitted?.();
  let intent;
  try {
    intent = await facade.markSubmitting({ grant, requestSnapshot: input.requestSnapshot });
  } catch (error) {
    if (grant.attempt.submissionState === 'not_sent') {
      await facade.settle({ attemptId: grant.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true });
    }
    throw error;
  }

  let value: T | undefined;
  let submissionError: unknown;
  try {
    const attempt = await facade.transmit(intent, async () => {
      try {
        const produced = await input.send();
        value = produced.value;
        return produced.receipt;
      } catch (error) {
        if (explicitNotCreated(error)) {
          submissionError = error;
          return { terminalState: 'not_created', errorCode: safeErrorCode(error) };
        }
        throw error;
      }
    });
    if (attempt.terminalState === 'not_created') {
      await facade.settle({ attemptId: attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true });
      throw new LegacyMediaNotCreatedError(submissionError instanceof Error ? submissionError.message : '供应商明确未创建任务。');
    }
    if (attempt.terminalState) {
      const outcome = attempt.terminalState;
      const actualCost = attempt.actualMinor !== null
        ? { currency: 'CNY' as const, minor: attempt.actualMinor }
        : outcome === 'succeeded' && input.quote.kind === 'priced'
          ? input.quote.reserve
          : null;
      await facade.settle({ attemptId: attempt.id, outcome, actualCost, remoteTerminal: true });
      if (outcome === 'failed') {
        await facade.captureError({ attemptId: attempt.id, outcome: 'failed', stage: 'remote_submit', errorCode: attempt.errorCode ?? 'provider_failed' });
        throw new Error('供应商同步返回失败。');
      }
    }
    return { value, attemptId: attempt.id, remoteId: attempt.remoteId ?? undefined, resumed: false };
  } catch (error) {
    if (error instanceof LegacyMediaNotCreatedError) throw error;
    if (error instanceof ExecutionError && !['transport_unknown'].includes(error.code)) throw error;
    throw new LegacyMediaSubmissionUnknownError(
      error instanceof Error ? error.message : String(error),
      intent.attemptId,
    );
  }
}

export function failLegacyMediaOperation(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
}): void {
  if (!isServerMediaExecution()) return;
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  getDb().prepare(`
    UPDATE execution_operations SET status = 'failed', waitReason = 'business_failed',
      waitDetail = NULL, updatedAt = ?
    WHERE module = ? AND taskId = ? AND operationKey = ? AND status IN ('pending', 'deferred')
  `).run(new Date().toISOString(), input.module, input.taskId, operationKey);
}

export async function settleLegacyMediaRemote(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
  outcome: 'succeeded' | 'failed';
  actualCost?: { currency: 'CNY'; minor: number } | null;
  resultRef?: string;
  errorCode?: string;
  errorStage?: 'remote_submit' | 'remote_poll' | 'download' | 'local_media' | 'storage';
}): Promise<void> {
  if (!isServerMediaExecution()) return;
  const access = requireAccessContext();
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const row = getDb().prepare(`
    SELECT currentAttemptId FROM execution_operations WHERE actorId = ? AND operationKey = ?
  `).get(access.actor.userId, operationKey) as { currentAttemptId: string | null } | undefined;
  if (!row?.currentAttemptId) return;
  if (input.outcome === 'failed' && input.errorStage && !['remote_submit', 'remote_poll'].includes(input.errorStage)) {
    await injection().facade.captureError({
      attemptId: row.currentAttemptId,
      outcome: 'failed', stage: input.errorStage, errorCode: input.errorCode,
    });
    return;
  }
  await injection().facade.settle({
    attemptId: row.currentAttemptId,
    outcome: input.outcome,
    actualCost: input.actualCost,
    remoteTerminal: true,
    result: input.resultRef ? { resultRef: input.resultRef } : undefined,
    errorCode: input.errorCode,
    errorStage: input.errorStage === 'remote_poll' ? 'remote_poll' : undefined,
  });
}

/** 已受理下载/媒体处理失败：关联原尝试，不篡改已成功的远端终态或费用。 */
export async function captureLegacyMediaFailure(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
  stage: 'download' | 'storage' | 'local_media';
  errorCode: string;
}): Promise<void> {
  if (!isServerMediaExecution()) return;
  const access = requireAccessContext();
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const row = getDb().prepare(`SELECT currentAttemptId FROM execution_operations WHERE actorId = ? AND operationKey = ?`)
    .get(access.actor.userId, operationKey) as { currentAttemptId: string | null } | undefined;
  if (!row?.currentAttemptId) return;
  await injection().facade.captureError({
    attemptId: row.currentAttemptId, outcome: 'failed', stage: input.stage, errorCode: input.errorCode,
  });
}

export async function recoverLegacyMediaDownload(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
}): Promise<void> {
  if (!isServerMediaExecution()) return;
  const access = requireAccessContext();
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const row = getDb().prepare(`SELECT currentAttemptId FROM execution_operations WHERE actorId = ? AND operationKey = ?`)
    .get(access.actor.userId, operationKey) as { currentAttemptId: string | null } | undefined;
  if (!row?.currentAttemptId) return;
  await injection().facade.captureRecovery({ taskId: input.taskId, module: input.module, stage: 'download' });
}

export async function cancelLegacyMediaNewStage(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
}): Promise<void> {
  if (!isServerMediaExecution()) return;
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const db = getDb();
  const operation = db.prepare(`
    SELECT id, currentAttemptId FROM execution_operations
    WHERE module = ? AND taskId = ? AND operationKey = ? AND status IN ('pending', 'deferred', 'admitted')
  `).get(input.module, input.taskId, operationKey) as { id: string; currentAttemptId: string | null } | undefined;
  if (!operation) return;
  if (operation.currentAttemptId) {
    const state = db.prepare('SELECT submissionState FROM execution_attempts WHERE id = ?')
      .pluck().get(operation.currentAttemptId) as string | undefined;
    if (state === 'not_sent') {
      await injection().facade.settle({
        attemptId: operation.currentAttemptId,
        outcome: 'not_created',
        actualCost: null,
        remoteTerminal: true,
        errorCode: 'stage_canceled',
      });
    }
  }
  db.prepare(`
    UPDATE execution_operations SET status = 'failed', waitReason = 'stage_canceled',
      waitDetail = NULL, updatedAt = ?
    WHERE id = ? AND status IN ('pending', 'deferred')
  `).run(new Date().toISOString(), operation.id);
}

export function legacyMediaExecutionRevision(value: unknown): string {
  const revision = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return `r${revision}`;
}

export function recoverLegacyMediaSubmission(input: {
  module: 'image' | 'video';
  taskId: string;
  inputRevision: string;
  providerTaskId?: string | null;
}): { status: 'pending' | 'needs_check'; remoteId?: string; resultRef?: string } {
  const operationKey = `${input.module}/${input.taskId}/submit/${input.inputRevision}`;
  const row = getDb().prepare(`
    SELECT o.status, o.resultJson, a.remoteId, a.receiptJson
    FROM execution_operations o
    LEFT JOIN execution_attempts a ON a.id = o.currentAttemptId
    WHERE o.module = ? AND o.taskId = ? AND o.operationKey = ?
  `).get(input.module, input.taskId, operationKey) as {
    status: string; resultJson: string | null; remoteId: string | null; receiptJson: string | null;
  } | undefined;
  let resultRef: string | undefined;
  for (const serialized of [row?.resultJson, row?.receiptJson]) {
    if (resultRef || !serialized) continue;
    try {
      const parsed = JSON.parse(serialized) as { resultRef?: unknown };
      if (typeof parsed.resultRef === 'string' && parsed.resultRef.trim()) resultRef = parsed.resultRef;
    } catch {
      // 损坏的回执不能凭猜测变成可下载地址；保留 needs_check。
    }
  }
  if (input.providerTaskId?.trim()) {
    return { status: 'needs_check', remoteId: input.providerTaskId.trim(), resultRef };
  }
  if (!row) return { status: 'needs_check' };
  if (row.status === 'pending' || row.status === 'deferred') return { status: 'pending' };
  return { status: 'needs_check', remoteId: row.remoteId ?? undefined, resultRef };
}
