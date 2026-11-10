import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isPlaceholderValue } from '../../video-auth.ts';
import { requireAccessContext } from '../access-context.ts';
import { ensureMediaProviderPool } from '../execution/media-provider-pool.ts';
import type { SubmissionEvidence } from '../submission-evidence.ts';
import {
  UNIFIED_IMAGE_ANCHOR_ID,
  UNIFIED_IMAGE_CHANNELS,
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  unifiedImageCompatibleChannels,
  type UnifiedImageChannelDefinition,
} from './catalog.ts';
import {
  UnifiedImageRequestError,
  freezeUnifiedImageRequest,
  type FrozenUnifiedImageRequest,
} from './requests.ts';

/**
 * Shared unified-image routing contract:
 * - `prepareUnifiedImageExecution` selects/rebinds a channel and never sends.
 * - The legacy queue submits through `submitLegacyMediaOperation`, which owns
 *   admission, submit-intent, transport and settlement.
 * - `handleUnifiedImageExplicitFailure` advances only after terminal evidence;
 *   unknown/query/download failures stay on their original channel.
 * - The queue registers the single business result; channel attempts remain in
 *   execution operations/attempts and are projected by
 *   `listUnifiedImageChannelAttempts` for admin and usage views.
 */
interface UnifiedJobRow {
  id: string;
  projectId: string;
  inputImageId: string;
  referenceImageIds: string;
  providerId: string;
  model: string;
  prompt: string;
  size: string;
  quality: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  executionRevision: number;
  providerTaskId: string | null;
  providerStatus: string | null;
  remoteImageUrl: string | null;
  errorMessage: string | null;
  unifiedModel: string | null;
  unifiedRuleVersion: string | null;
  unifiedTaskId: string | null;
  unifiedRequestJson: string | null;
  cancelRequestedAt: string | null;
}

interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  type: string;
  enabled: number;
  defaultCostPerImage: number | null;
}

interface MediaTaskRow {
  id: string;
  taskKey: string;
  actorId: string;
  scopeType: string;
  scopeId: string;
  module: string;
  taskId: string;
  unifiedModel: string;
  ruleVersion: string;
  inputHash: string;
  inputSnapshotJson: string;
  outputContractJson: string;
  status: string;
  cancelRequestedAt: string | null;
  currentChannelKey: string | null;
}

interface MediaChannelRow {
  id: string;
  mediaTaskId: string;
  channelKey: string;
  providerTable: string;
  providerId: string;
  providerModel: string;
  priority: number;
  state: string;
  executionRevision: number;
  operationId: string | null;
  remoteId: string | null;
  evidenceJson: string | null;
  nextEligibleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ChannelOperationRow {
  id: string;
  operationKey: string;
  inputRevision: string;
  status: string;
  waitReason: string | null;
  waitDetail: string | null;
  configVersion: string | null;
  credentialVersionRef: string | null;
  quoteJson: string;
  currentAttemptId: string | null;
  resultJson: string | null;
  updatedAt: string;
}

export class UnifiedImageExecutionError extends Error {
  readonly code:
    | 'no_available_channel'
    | 'channel_identity_mismatch'
    | 'invalid_frozen_contract'
    | 'invalid_failure_evidence'
    | 'channel_exhausted';

  constructor(code: UnifiedImageExecutionError['code'], message: string) {
    super(message);
    this.name = 'UnifiedImageExecutionError';
    this.code = code;
  }
}

export class UnifiedImageCanceledError extends Error {
  constructor() {
    super('任务已记录取消意图，不再选择新通道或提交。');
    this.name = 'UnifiedImageCanceledError';
  }
}

export class UnifiedImageStaleSubmissionError extends Error {
  constructor() {
    super('统一图片任务已被取消或切换到其他通道，本次未发送请求。');
    this.name = 'UnifiedImageStaleSubmissionError';
  }
}

export class UnifiedImageChannelUnavailableError extends Error {
  constructor() {
    super('Image 2 当前通道已停用或凭据不可用，本次未发送请求。');
    this.name = 'UnifiedImageChannelUnavailableError';
  }
}

export interface PreparedUnifiedImageExecution {
  taskId: string;
  channel: {
    channelKey: string;
    executionRevision: number;
    definition: UnifiedImageChannelDefinition;
    provider: ProviderRow;
  };
}

export interface UnifiedImageAttemptView {
  attemptId: string;
  operationId: string;
  operationKey: string;
  permitId: string;
  providerSnapshot: Record<string, unknown>;
  pricingSnapshot: unknown;
  receipt: Record<string, unknown> | null;
  submissionState: string;
  terminalState: string | null;
  remoteId: string | null;
  intentJournalSeq: number | null;
  reservedMinor: number;
  actualMinor: number | null;
  costState: string;
  errorCode: string | null;
  createdAt: string;
}

export interface UnifiedImageChannelAttemptView {
  channelKey: string;
  providerId: string;
  providerModel: string;
  priority: number;
  state: string;
  executionRevision: number;
  operationId: string | null;
  operationKey: string | null;
  inputRevision: string | null;
  configVersion: string | null;
  credentialVersionRef: string | null;
  quote: unknown;
  operationStatus: string | null;
  operationWaitReason: string | null;
  operationWaitDetail: unknown;
  remoteId: string | null;
  evidence: Record<string, unknown> | null;
  attempts: UnifiedImageAttemptView[];
}

export interface UnifiedImageAttemptLedger {
  mediaTaskId: string;
  jobId: string;
  actorId: string;
  unifiedModel: string;
  ruleVersion: string;
  scopeType: string;
  scopeId: string;
  sourceType: string;
  sourceId: string | null;
  sourceMeta: unknown;
  parentStatus: string;
  currentChannelKey: string | null;
  cancelRequestedAt: string | null;
  result: unknown;
  submissionCount: number;
  usedChannelCount: number;
  channels: UnifiedImageChannelAttemptView[];
}

export type UnifiedImageFailureDecision =
  | {
    outcome: 'next_channel';
    previousChannelKey: string;
    nextChannelKey: string;
    nextExecutionRevision: number;
    submissionCount: number;
    usedChannelCount: number;
  }
  | {
    outcome: 'exhausted' | 'canceled' | 'ignored';
    previousChannelKey: string | null;
    nextChannelKey?: undefined;
    nextExecutionRevision?: undefined;
    reason?: string;
    submissionCount: number;
    usedChannelCount: number;
  };

export interface UnifiedImageExplicitFailureInput {
  evidence: SubmissionEvidence;
  attemptId?: string;
  operationId?: string;
  channelKey?: string | null;
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

function readJob(db: Database.Database, jobId: string): UnifiedJobRow {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as UnifiedJobRow | undefined;
  if (!job) throw new Error(`统一图片任务 ${jobId} 不存在。`);
  if (!job.unifiedModel) throw new Error(`图片任务 ${jobId} 不是统一模型任务。`);
  if (job.providerId !== UNIFIED_IMAGE_ANCHOR_ID || job.model !== UNIFIED_IMAGE_MODEL_KEY) {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务没有冻结统一模型锚点身份。');
  }
  return job;
}

function readFrozenRequest(job: UnifiedJobRow): FrozenUnifiedImageRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(job.unifiedRequestJson ?? '');
  } catch {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务的冻结输入无法读取。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务的冻结输入结构无效。');
  }
  const source = raw as Record<string, unknown>;
  let frozen: FrozenUnifiedImageRequest;
  try {
    frozen = freezeUnifiedImageRequest({
      inputImageId: String(source.inputImageId ?? ''),
      referenceImageIds: Array.isArray(source.referenceImageIds)
        ? source.referenceImageIds.map((item) => String(item ?? '')) : [],
      prompt: String(source.prompt ?? ''),
      tier: source.tier,
      ratio: source.ratio,
      referenceGuidanceMode: source.referenceGuidanceMode === 'none' ? 'none' : 'preserve_subject',
    });
  } catch (error) {
    if (error instanceof UnifiedImageRequestError) {
      throw new UnifiedImageExecutionError('invalid_frozen_contract', error.message);
    }
    throw error;
  }
  if (frozen.unifiedModel !== job.unifiedModel
    || frozen.ruleVersion !== job.unifiedRuleVersion
    || frozen.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION
    || frozen.inputImageId !== job.inputImageId
    || frozen.prompt !== job.prompt
    || frozen.size !== job.size
    || frozen.quality !== job.quality) {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务冻结输入与业务行不一致。');
  }
  let referenceIds: unknown;
  try { referenceIds = JSON.parse(job.referenceImageIds || '[]'); } catch { referenceIds = null; }
  if (!Array.isArray(referenceIds)
    || referenceIds.map((item) => String(item)).join('\0') !== frozen.referenceImageIds.join('\0')) {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务的参考图顺序已被改写。');
  }
  return frozen;
}

function ensureLogicalTask(
  db: Database.Database,
  job: UnifiedJobRow,
  frozen: FrozenUnifiedImageRequest,
): MediaTaskRow {
  const access = requireAccessContext();
  if (access.kind !== 'team') throw new Error('统一图片任务缺少团队发起人。');
  const taskKey = `image:${job.id}`;
  const inputHash = hash(frozen);
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO execution_media_tasks (
        id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
        inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
        status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
        resultJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'project', ?, 'image', ?, ?, ?, ?, ?, ?, 'project_scene', ?, ?, 'routing', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      randomUUID(), taskKey, access.actor.userId, job.projectId, job.id,
      UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, inputHash,
      JSON.stringify(frozen), JSON.stringify({
        tier: frozen.tier, ratio: frozen.ratio, size: frozen.size, quality: frozen.quality,
      }), job.projectId, JSON.stringify({ entry: 'project_scene', jobId: job.id }), at, at,
    );
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?').get(taskKey) as MediaTaskRow | undefined;
    if (!task) throw new Error('统一图片逻辑任务创建失败。');
    if (job.unifiedTaskId && job.unifiedTaskId !== task.id) {
      throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片任务关联的逻辑任务身份已漂移。');
    }
    if (task.actorId !== access.actor.userId || task.scopeType !== 'project' || task.scopeId !== job.projectId
      || task.module !== 'image' || task.taskId !== job.id || task.unifiedModel !== UNIFIED_IMAGE_MODEL_KEY
      || task.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION || task.inputHash !== inputHash) {
      throw new UnifiedImageExecutionError('invalid_frozen_contract', '统一图片逻辑任务身份与冻结合同不一致。');
    }
    db.prepare('UPDATE jobs SET unifiedTaskId = ? WHERE id = ?').run(task.id, job.id);
    for (const definition of unifiedImageCompatibleChannels(frozen.tier, frozen.ratio)) {
      db.prepare(`
        INSERT OR IGNORE INTO execution_media_channels (
          id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
          state, executionRevision, operationId, remoteId, evidenceJson, nextEligibleAt, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 0, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        randomUUID(), task.id, definition.channelKey, definition.providerTable,
        definition.providerId, definition.model, definition.priority, at, at,
      );
    }
  }).immediate();
  return db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?').get(taskKey) as MediaTaskRow;
}

function inspectExactProvider(
  db: Database.Database,
  definition: UnifiedImageChannelDefinition,
): { provider: ProviderRow; problem: null } | { provider: null; problem: 'missing' | 'identity_mismatch' } {
  const provider = db.prepare(`SELECT id, name, baseUrl, apiKey, model, type, enabled, defaultCostPerImage
    FROM providers WHERE id = ?`).get(definition.providerId) as ProviderRow | undefined;
  if (!provider) return { provider: null, problem: 'missing' };
  if (provider.model !== definition.model || provider.type !== 'gateway-task-image') {
    return { provider: null, problem: 'identity_mismatch' };
  }
  return { provider, problem: null };
}

function readExactProvider(
  db: Database.Database,
  definition: UnifiedImageChannelDefinition,
): ProviderRow {
  const inspected = inspectExactProvider(db, definition);
  if (inspected.problem === 'missing') {
    throw new UnifiedImageExecutionError(
      'no_available_channel',
      `Image 2 ${definition.channelKey} 通道的真实供应商行不存在。`,
    );
  }
  if (inspected.problem === 'identity_mismatch') {
    throw new UnifiedImageExecutionError(
      'channel_identity_mismatch',
      `Image 2 ${definition.channelKey} 通道的供应商身份与冻结映射不一致，已拒绝提交。`,
    );
  }
  if (!inspected.provider) throw new Error('统一图片通道供应商检查未返回可用行。');
  return inspected.provider;
}

function providerUsable(provider: ProviderRow): boolean {
  return provider.enabled === 1
    && Boolean(provider.baseUrl.trim())
    && Boolean(provider.apiKey.trim())
    && !isPlaceholderValue(provider.apiKey);
}

export function unifiedImageProviderAvailability(db: Database.Database): Array<{
  channelKey: string;
  providerId: string;
  model: string;
  configured: boolean;
  identityValid: boolean;
}> {
  return UNIFIED_IMAGE_CHANNELS.map((definition) => {
    const inspected = inspectExactProvider(db, definition);
    if (!inspected.provider) {
      return {
        channelKey: definition.channelKey,
        providerId: definition.providerId,
        model: definition.model,
        configured: false,
        identityValid: false,
      };
    }
    return {
      channelKey: definition.channelKey,
      providerId: definition.providerId,
      model: definition.model,
      configured: providerUsable(inspected.provider),
      identityValid: true,
    };
  });
}

function setChannelSkipped(
  db: Database.Database,
  taskId: string,
  channelKey: string,
  reason: string,
): void {
  db.prepare(`UPDATE execution_media_channels
    SET state = 'skipped', evidenceJson = ?, updatedAt = ?
    WHERE mediaTaskId = ? AND channelKey = ? AND state IN ('candidate', 'skipped')`)
    .run(JSON.stringify({ reason }), new Date().toISOString(), taskId, channelKey);
}

interface ChannelSelection {
  definition: UnifiedImageChannelDefinition;
  provider: ProviderRow;
}

interface ChannelSelectionFailure {
  reason: 'channel_limit' | 'no_available_channel' | 'channel_identity_mismatch' | 'pool_configuration_invalid';
  message: string;
}

function channelHasSubmission(db: Database.Database, taskId: string, channelKey: string): boolean {
  const attempts = db.prepare(`
    SELECT COUNT(*) FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ? AND o.channelKey = ? AND a.intentJournalSeq IS NOT NULL
  `).pluck().get(taskId, channelKey) as number;
  if (attempts > 0) return true;
  const operation = db.prepare(`SELECT status FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(taskId, channelKey) as { status: string } | undefined;
  return Boolean(operation && ['maybe_sent', 'accepted', 'reconciling', 'unknown', 'succeeded'].includes(operation.status));
}

function channelHasOperation(db: Database.Database, taskId: string, channelKey: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(taskId, channelKey));
}

function submittedChannelCount(db: Database.Database, taskId: string): number {
  return db.prepare(`
    SELECT COUNT(DISTINCT o.channelKey) FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ? AND o.channelKey IS NOT NULL AND a.intentJournalSeq IS NOT NULL
  `).pluck().get(taskId) as number;
}

function findNextChannel(
  db: Database.Database,
  task: MediaTaskRow,
  frozen: FrozenUnifiedImageRequest,
  excludeChannelKey?: string,
): ChannelSelection | ChannelSelectionFailure {
  if (submittedChannelCount(db, task.id) >= 2) {
    return {
      reason: 'channel_limit',
      message: 'Image 2 的两条通道都已真实提交过，不会再发起第三次生成。',
    };
  }
  for (const definition of unifiedImageCompatibleChannels(frozen.tier, frozen.ratio)) {
    if (definition.channelKey === excludeChannelKey) continue;
    if (channelHasSubmission(db, task.id, definition.channelKey)) continue;
    if (channelHasOperation(db, task.id, definition.channelKey)) continue;
    const channel = db.prepare(`SELECT state FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, definition.channelKey) as
      { state: string } | undefined;
    if (!channel || !['candidate', 'skipped'].includes(channel.state)) continue;

    const inspected = inspectExactProvider(db, definition);
    if (inspected.problem === 'missing') {
      // Missing canonical rows are skips. A tencent-only request must still run
      // when qiniu was never configured.
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_missing');
      continue;
    }
    if (inspected.problem === 'identity_mismatch') {
      // A present canonical ID with a different exact model/type is config
      // drift. Fail the unified request rather than silently switching.
      return {
        reason: 'channel_identity_mismatch',
        message: `Image 2 ${definition.channelKey} 通道的供应商身份与冻结映射不一致，已拒绝提交。`,
      };
    }
    if (!inspected.provider) continue;
    if (!providerUsable(inspected.provider)) {
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_unavailable');
      continue;
    }
    try {
      ensureMediaProviderPool(db, inspected.provider.baseUrl, inspected.provider.apiKey);
    } catch (error) {
      return {
        reason: 'pool_configuration_invalid',
        message: error instanceof Error
          ? error.message
          : `Image 2 ${definition.channelKey} 通道资源池未通过核验。`,
      };
    }
    return { definition, provider: inspected.provider };
  }
  return {
    reason: 'no_available_channel',
    message: '当前没有另一条已启用、凭据可用且未提交过的 Image 2 通道，任务未继续提交。',
  };
}

function markSelectedChannel(
  db: Database.Database,
  taskId: string,
  definition: UnifiedImageChannelDefinition,
  revision: number,
): string {
  const at = new Date().toISOString();
  db.prepare(`UPDATE execution_media_channels
    SET state = 'selected', executionRevision = ?, evidenceJson = NULL,
      nextEligibleAt = NULL, updatedAt = ?
    WHERE mediaTaskId = ? AND channelKey = ?`)
    .run(revision, at, taskId, definition.channelKey);
  db.prepare(`UPDATE execution_media_tasks
    SET currentChannelKey = ?, status = 'routing', waitReason = NULL, waitDetailJson = NULL,
      nextEligibleAt = NULL, updatedAt = ?
    WHERE id = ?`).run(definition.channelKey, at, taskId);
  return at;
}

function chooseInitialChannel(
  db: Database.Database,
  job: UnifiedJobRow,
  task: MediaTaskRow,
  frozen: FrozenUnifiedImageRequest,
): PreparedUnifiedImageExecution {
  let failureMessage = '当前没有已启用且凭据可用的 Image 2 通道，任务未提交。';
  let identityError: UnifiedImageExecutionError | null = null;
  const selected = db.transaction((): PreparedUnifiedImageExecution | null => {
    const selection = findNextChannel(db, task, frozen);
    if ('reason' in selection) {
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'failed', resultJson = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify({ errorCode: selection.reason, message: selection.message }), new Date().toISOString(), task.id);
      if (selection.reason === 'channel_identity_mismatch') {
        identityError = new UnifiedImageExecutionError('channel_identity_mismatch', selection.message);
        return null;
      }
      failureMessage = selection.message;
      return null;
    }
    const { definition, provider } = selection;
    const revision = Math.max(1, job.executionRevision + 1);
    const changed = db.prepare(`UPDATE jobs SET executionRevision = ?
      WHERE id = ? AND cancelRequestedAt IS NULL AND status = 'running'`).run(revision, job.id);
    if (changed.changes !== 1) throw new UnifiedImageCanceledError();
    markSelectedChannel(db, task.id, definition, revision);
    return {
      taskId: task.id,
      channel: { channelKey: definition.channelKey, executionRevision: revision, definition, provider },
    };
  }).immediate();
  if (selected) return selected;
  if (identityError) throw identityError;
  throw new UnifiedImageExecutionError(
    'no_available_channel',
    failureMessage,
  );
}

function safeJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Read-only task-attempt projection for admin verification and usage reports.
 * The execution operations/attempts remain the single ledger; this function
 * only joins them to the logical Image 2 task.
 */
export function listUnifiedImageChannelAttempts(
  db: Database.Database,
  jobId: string,
): UnifiedImageAttemptLedger {
  const job = db.prepare(`SELECT id, unifiedTaskId FROM jobs WHERE id = ?`).get(jobId) as
    { id: string; unifiedTaskId: string | null } | undefined;
  if (!job?.unifiedTaskId) throw new Error(`统一图片任务 ${jobId} 尚未建立逻辑任务。`);
  const parent = db.prepare(`SELECT actorId, unifiedModel, ruleVersion, scopeType, scopeId,
      sourceType, sourceId, sourceMetaJson, status, currentChannelKey, cancelRequestedAt, resultJson
    FROM execution_media_tasks WHERE id = ?`).get(job.unifiedTaskId) as {
      actorId: string; unifiedModel: string; ruleVersion: string; scopeType: string; scopeId: string;
      sourceType: string; sourceId: string | null; sourceMetaJson: string; status: string;
      currentChannelKey: string | null; cancelRequestedAt: string | null; resultJson: string | null;
    } | undefined;
  if (!parent) throw new Error(`统一图片逻辑任务 ${job.unifiedTaskId} 不存在。`);
  const channels = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? ORDER BY priority, channelKey`).all(job.unifiedTaskId) as MediaChannelRow[];
  const operations = db.prepare(`SELECT * FROM execution_operations
    WHERE mediaTaskId = ? ORDER BY createdAt, id`).all(job.unifiedTaskId) as Array<
      ChannelOperationRow & { channelKey: string; mediaTaskId: string }
    >;
  const attempts = db.prepare(`
    SELECT a.id AS attemptId, a.operationId, o.operationKey, a.permitId,
      a.providerSnapshotJson, a.pricingSnapshotJson, a.submissionState, a.terminalState,
      a.remoteId, a.intentJournalSeq, a.reservedMinor, a.actualMinor, a.costState,
      a.errorCode, a.receiptJson, a.createdAt, o.channelKey
    FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ?
    ORDER BY a.createdAt, a.transportSeq, a.id
  `).all(job.unifiedTaskId) as Array<{
    attemptId: string; operationId: string; operationKey: string; permitId: string;
    providerSnapshotJson: string; pricingSnapshotJson: string | null;
    receiptJson: string | null;
    submissionState: string; terminalState: string | null; remoteId: string | null;
    intentJournalSeq: number | null; reservedMinor: number; actualMinor: number | null;
    costState: string; errorCode: string | null; createdAt: string; channelKey: string;
  }>;
  const operationByChannel = new Map(operations.map((operation) => [operation.channelKey, operation]));
  const attemptsByChannel = new Map<string, UnifiedImageAttemptView[]>();
  for (const attempt of attempts) {
    const group = attemptsByChannel.get(attempt.channelKey) ?? [];
    group.push({
      attemptId: attempt.attemptId,
      operationId: attempt.operationId,
      operationKey: attempt.operationKey,
      permitId: attempt.permitId,
      providerSnapshot: safeJsonObject(attempt.providerSnapshotJson) ?? {},
      pricingSnapshot: safeJsonObject(attempt.pricingSnapshotJson),
      receipt: safeJsonObject(attempt.receiptJson),
      submissionState: attempt.submissionState,
      terminalState: attempt.terminalState,
      remoteId: attempt.remoteId,
      intentJournalSeq: attempt.intentJournalSeq,
      reservedMinor: attempt.reservedMinor,
      actualMinor: attempt.actualMinor,
      costState: attempt.costState,
      errorCode: attempt.errorCode,
      createdAt: attempt.createdAt,
    });
    attemptsByChannel.set(attempt.channelKey, group);
  }
  const channelViews: UnifiedImageChannelAttemptView[] = channels.map((channel) => {
    const operation = operationByChannel.get(channel.channelKey);
    return {
      channelKey: channel.channelKey,
      providerId: channel.providerId,
      providerModel: channel.providerModel,
      priority: channel.priority,
      state: channel.state,
      executionRevision: channel.executionRevision,
      operationId: channel.operationId ?? operation?.id ?? null,
      operationKey: operation?.operationKey ?? null,
      inputRevision: operation?.inputRevision ?? null,
      configVersion: operation?.configVersion ?? null,
      credentialVersionRef: operation?.credentialVersionRef ?? null,
      quote: safeJsonObject(operation?.quoteJson ?? null),
      operationStatus: operation?.status ?? null,
      operationWaitReason: operation?.waitReason ?? null,
      operationWaitDetail: safeJsonObject(operation?.waitDetail ?? null),
      remoteId: channel.remoteId
        ?? attemptsByChannel.get(channel.channelKey)?.at(-1)?.remoteId
        ?? null,
      evidence: safeJsonObject(channel.evidenceJson),
      attempts: attemptsByChannel.get(channel.channelKey) ?? [],
    };
  });
  const submissionCount = channelViews.reduce(
    (sum, channel) => sum + channel.attempts.filter((attempt) => attempt.intentJournalSeq !== null).length,
    0,
  );
  return {
    mediaTaskId: job.unifiedTaskId,
    jobId,
    actorId: parent.actorId,
    unifiedModel: parent.unifiedModel,
    ruleVersion: parent.ruleVersion,
    scopeType: parent.scopeType,
    scopeId: parent.scopeId,
    sourceType: parent.sourceType,
    sourceId: parent.sourceId,
    sourceMeta: safeJsonObject(parent.sourceMetaJson),
    parentStatus: parent.status,
    currentChannelKey: parent.currentChannelKey,
    cancelRequestedAt: parent.cancelRequestedAt,
    result: safeJsonObject(parent.resultJson),
    submissionCount,
    usedChannelCount: channelViews.filter((channel) =>
      channel.attempts.some((attempt) => attempt.intentJournalSeq !== null)).length,
    channels: channelViews,
  };
}

/** Sum a task's real attempt cost evidence without treating released failures as zero-priced successes. */
export function unifiedImageAttemptCostMinor(db: Database.Database, jobId: string): number {
  const job = db.prepare('SELECT unifiedTaskId FROM jobs WHERE id = ?').get(jobId) as
    { unifiedTaskId: string | null } | undefined;
  if (!job?.unifiedTaskId) return 0;
  const rows = db.prepare(`
    SELECT a.actualMinor, a.reservedMinor, a.costState FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ?
  `).all(job.unifiedTaskId) as Array<{
    actualMinor: number | null; reservedMinor: number; costState: string;
  }>;
  return rows.reduce((sum, row) => {
    if (row.costState === 'released') return sum;
    return sum + (row.actualMinor ?? row.reservedMinor);
  }, 0);
}

/**
 * Advance a logical Image 2 task only after explicit not-created / terminal
 * failure evidence. Unknown, query failures and download failures never call
 * this function.
 */
export function handleUnifiedImageExplicitFailure(
  db: Database.Database,
  jobId: string,
  input: UnifiedImageExplicitFailureInput,
): UnifiedImageFailureDecision {
  const evidence = input.evidence;
  if (evidence.identity.taskId !== jobId
    || !['submit', 'poll'].includes(evidence.identity.stage)
    || !['confirmed_not_created', 'terminal_failed'].includes(evidence.state)) {
    throw new UnifiedImageExecutionError(
      'invalid_failure_evidence',
      '统一图片任务只接受明确未创建或远端明确失败证据。',
    );
  }
  const kind = evidence.state === 'confirmed_not_created' ? 'not_created' : 'failed';
  return db.transaction((): UnifiedImageFailureDecision => {
    const job = readJob(db, jobId);
    if (!job.unifiedTaskId) {
      return {
        outcome: 'ignored', previousChannelKey: null,
        submissionCount: 0, usedChannelCount: 0,
      };
    }
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
      MediaTaskRow | undefined;
    if (!task?.currentChannelKey || job.status === 'succeeded') {
      return {
        outcome: 'ignored', previousChannelKey: task?.currentChannelKey ?? null,
        submissionCount: submittedChannelCount(db, task?.id ?? ''),
        usedChannelCount: submittedChannelCount(db, task?.id ?? ''),
      };
    }
    const channel = db.prepare(`SELECT * FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
      MediaChannelRow | undefined;
    if (!channel) {
      return {
        outcome: 'ignored', previousChannelKey: null,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    const operation = (input.operationId
      ? db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(input.operationId)
      : db.prepare('SELECT * FROM execution_operations WHERE mediaTaskId = ? AND channelKey = ?')
        .get(task.id, channel.channelKey)) as (ChannelOperationRow & {
          mediaTaskId: string | null; channelKey: string | null;
        }) | undefined;
    const operationChannel = operation?.channelKey ?? null;
    if ((input.channelKey && input.channelKey !== channel.channelKey)
      || (operationChannel && operationChannel !== channel.channelKey)) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    if (!operation || operation.mediaTaskId !== task.id || operation.channelKey !== channel.channelKey) {
      throw new UnifiedImageExecutionError(
        'invalid_failure_evidence',
        '显式失败证据没有关联到当前通道的真实执行操作。',
      );
    }
    if (['failed', 'not_created', 'succeeded', 'canceled'].includes(channel.state)) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    const attempt = (input.attemptId
      ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(input.attemptId)
      : operation?.currentAttemptId
        ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(operation.currentAttemptId)
        : undefined) as {
          id: string; operationId: string; remoteId: string | null; submissionState: string;
          terminalState: string | null; reservedMinor: number; actualMinor: number | null;
          costState: string; errorCode: string | null;
        } | undefined;
    if (attempt?.operationId && operation?.id && attempt.operationId !== operation.id) {
      throw new UnifiedImageExecutionError(
        'invalid_failure_evidence',
        '显式失败证据的执行尝试与当前通道不一致。',
      );
    }
    const expectedTerminal = kind === 'not_created' ? 'not_created' : 'failed';
    if (!attempt || attempt.terminalState !== expectedTerminal) {
      throw new UnifiedImageExecutionError(
        'invalid_failure_evidence',
        '显式失败证据对应的执行尝试尚未完成同终态结算。',
      );
    }
    const at = new Date().toISOString();
    const remoteId = channel.remoteId?.trim()
      || attempt?.remoteId?.trim()
      || evidence.remoteId?.trim()
      || job.providerTaskId?.trim()
      || null;
    const channelEvidence = {
      kind,
      at,
      attemptId: attempt?.id ?? input.attemptId ?? null,
      operationId: operation?.id ?? input.operationId ?? null,
      remoteId,
      submissionState: attempt?.submissionState ?? evidence.state,
      terminalState: attempt?.terminalState ?? kind,
      costState: attempt?.costState ?? null,
      reservedMinor: attempt?.reservedMinor ?? null,
      actualMinor: attempt?.actualMinor ?? null,
      errorCode: attempt?.errorCode ?? evidence.error?.code ?? null,
      submissionEvidence: evidence,
    };
    db.prepare(`UPDATE execution_media_channels
      SET state = ?, operationId = COALESCE(?, operationId), remoteId = COALESCE(remoteId, ?, ?),
        evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(
      kind, operation?.id ?? null, remoteId, evidence.remoteId,
      JSON.stringify(channelEvidence), at, channel.id,
    );
    if (operation) {
      db.prepare(`UPDATE execution_operations
        SET status = 'failed', waitReason = NULL, waitDetail = NULL, updatedAt = ?
        WHERE id = ?`).run(at, operation.id);
    }

    if (job.cancelRequestedAt || task.cancelRequestedAt) {
      db.prepare(`UPDATE jobs
        SET status = 'canceled', errorMessage = 'Canceled by user',
          cancelRequestedAt = COALESCE(cancelRequestedAt, ?), finishedAt = COALESCE(finishedAt, ?),
          providerTaskId = NULL, providerStatus = NULL, remoteImageUrl = NULL
        WHERE id = ? AND status IN ('running', 'failed', 'needs_check')`).run(at, at, job.id);
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'canceled', currentChannelKey = NULL,
          cancelRequestedAt = COALESCE(cancelRequestedAt, ?), resultJson = ?, updatedAt = ?
        WHERE id = ?`).run(at, JSON.stringify({
          errorCode: 'canceled', previousChannelKey: channel.channelKey, reason: kind,
        }), at, task.id);
      return {
        outcome: 'canceled', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }

    const frozen = readFrozenRequest(job);
    const selection = findNextChannel(db, task, frozen, channel.channelKey);
    if ('reason' in selection) {
      const message = selection.reason === 'channel_limit'
        ? 'Image 2 的两条可用通道均已明确失败，任务已停止，不会发起第三次生成。'
        : selection.message;
      db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = ?, errorMessage = ?
        WHERE id = ? AND status IN ('running', 'failed', 'needs_check')`).run(at, message, job.id);
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'failed', currentChannelKey = ?, resultJson = ?, updatedAt = ?
        WHERE id = ?`).run(channel.channelKey, JSON.stringify({
        errorCode: selection.reason,
        message,
        previousChannelKey: channel.channelKey,
        submittedChannelCount: submittedChannelCount(db, task.id),
      }), at, task.id);
      return {
        outcome: 'exhausted', previousChannelKey: channel.channelKey, reason: selection.reason,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }

    const revision = Math.max(1, job.executionRevision + 1);
    const changed = db.prepare(`UPDATE jobs SET
        status = 'pending', executionRevision = ?, errorMessage = NULL, finishedAt = NULL,
        providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL,
        remoteImageUrl = NULL, submittedAt = NULL, lastPolledAt = NULL, pollCount = 0,
        startedAt = NULL, latencyMs = NULL, usageSnapshotJson = NULL, estimatedCost = NULL
      WHERE id = ? AND cancelRequestedAt IS NULL AND status IN ('running', 'failed', 'needs_check')`)
      .run(revision, job.id);
    if (changed.changes !== 1) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    markSelectedChannel(db, task.id, selection.definition, revision);
    return {
      outcome: 'next_channel',
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
      nextExecutionRevision: revision,
      submissionCount: submittedChannelCount(db, task.id),
      usedChannelCount: submittedChannelCount(db, task.id),
    };
  }).immediate();
}

/** Last-moment guard immediately before a paid unified-media POST. */
export function assertUnifiedImageSubmissionStillCurrent(
  db: Database.Database,
  input: {
    jobId: string;
    mediaTaskId: string;
    channelKey: string;
    executionRevision: number;
  },
): void {
  const job = db.prepare(`SELECT status, unifiedTaskId, executionRevision, cancelRequestedAt
    FROM jobs WHERE id = ?`).get(input.jobId) as {
      status: string; unifiedTaskId: string | null; executionRevision: number;
      cancelRequestedAt: string | null;
    } | undefined;
  if (!job || job.unifiedTaskId !== input.mediaTaskId) throw new UnifiedImageStaleSubmissionError();
  if (job.cancelRequestedAt) throw new UnifiedImageCanceledError();
  const task = db.prepare(`SELECT status, currentChannelKey, cancelRequestedAt
    FROM execution_media_tasks WHERE id = ?`).get(input.mediaTaskId) as {
      status: string; currentChannelKey: string | null; cancelRequestedAt: string | null;
    } | undefined;
  if (!task) throw new UnifiedImageStaleSubmissionError();
  if (task.cancelRequestedAt) throw new UnifiedImageCanceledError();
  const channel = db.prepare(`SELECT state, executionRevision, providerId FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(input.mediaTaskId, input.channelKey) as
    { state: string; executionRevision: number; providerId: string } | undefined;
  if (job.status !== 'running'
    || job.executionRevision !== input.executionRevision
    || task.currentChannelKey !== input.channelKey
    || !channel
    || channel.executionRevision !== input.executionRevision
    || !['selected', 'waiting_capacity'].includes(channel.state)) {
    throw new UnifiedImageStaleSubmissionError();
  }
  const provider = db.prepare(`SELECT enabled, baseUrl, apiKey FROM providers WHERE id = ?`)
    .get(channel.providerId) as { enabled: number; baseUrl: string; apiKey: string } | undefined;
  if (!provider || provider.enabled !== 1 || !provider.baseUrl.trim() || !provider.apiKey.trim()
    || isPlaceholderValue(provider.apiKey)) {
    throw new UnifiedImageChannelUnavailableError();
  }
}

function readCurrentChannel(
  db: Database.Database,
  task: MediaTaskRow,
): { channel: MediaChannelRow; definition: UnifiedImageChannelDefinition; provider: ProviderRow } | null {
  if (!task.currentChannelKey) return null;
  const channel = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as MediaChannelRow | undefined;
  if (!channel) return null;
  const definition = UNIFIED_IMAGE_CHANNELS.find((item) => item.channelKey === channel.channelKey);
  if (!definition || definition.providerId !== channel.providerId
    || definition.model !== channel.providerModel || channel.providerTable !== definition.providerTable) {
    throw new UnifiedImageExecutionError('channel_identity_mismatch', '统一图片通道快照与精确目录不一致。');
  }
  const provider = readExactProvider(db, definition);
  if (!provider.baseUrl.trim() || !provider.apiKey.trim() || isPlaceholderValue(provider.apiKey)) {
    throw new Error('Image 2 原通道凭据不可用，已停止续查。');
  }
  return { channel, definition, provider };
}

function hasAcceptedEvidence(
  db: Database.Database,
  job: UnifiedJobRow,
  channel: MediaChannelRow,
): boolean {
  if (job.providerTaskId?.trim() || job.remoteImageUrl?.trim() || channel.remoteId?.trim()) return true;
  const operation = db.prepare(`SELECT status FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(channel.mediaTaskId, channel.channelKey) as
    | { status: string } | undefined;
  return Boolean(operation && ['maybe_sent', 'accepted', 'reconciling', 'unknown', 'succeeded'].includes(operation.status));
}

function cancelUnsubmittedTask(
  db: Database.Database,
  job: UnifiedJobRow,
  task: MediaTaskRow,
  current: ReturnType<typeof readCurrentChannel>,
): never {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE jobs SET status = 'canceled', errorMessage = 'Canceled by user',
      cancelRequestedAt = COALESCE(cancelRequestedAt, ?), finishedAt = COALESCE(finishedAt, ?)
      WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'deferred')`).run(at, at, job.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'canceled', cancelRequestedAt = COALESCE(cancelRequestedAt, ?), updatedAt = ?
      WHERE id = ?`).run(at, at, task.id);
    if (current) {
      db.prepare(`UPDATE execution_media_channels SET state = 'canceled', updatedAt = ?
        WHERE id = ?`).run(at, current.channel.id);
      db.prepare(`UPDATE execution_operations
        SET status = 'failed', waitReason = 'stage_canceled', waitDetail = NULL, updatedAt = ?
        WHERE mediaTaskId = ? AND channelKey = ? AND status IN ('pending', 'deferred')`)
        .run(at, task.id, current.channel.channelKey);
    }
  }).immediate();
  throw new UnifiedImageCanceledError();
}

export function prepareUnifiedImageExecution(
  db: Database.Database,
  jobId: string,
): PreparedUnifiedImageExecution {
  const job = readJob(db, jobId);
  if (job.unifiedModel !== UNIFIED_IMAGE_MODEL_KEY) {
    throw new UnifiedImageExecutionError('invalid_frozen_contract', '当前批次只支持 Image 2 统一任务。');
  }
  const frozen = readFrozenRequest(job);
  const task = ensureLogicalTask(db, job, frozen);
  const current = readCurrentChannel(db, task);
  const canceled = Boolean(job.cancelRequestedAt || task.cancelRequestedAt);
  if (current) {
    if (canceled && !hasAcceptedEvidence(db, job, current.channel)) {
      cancelUnsubmittedTask(db, job, task, current);
    }
    if (['selected', 'waiting_capacity'].includes(current.channel.state)
      && !hasAcceptedEvidence(db, job, current.channel)
      && !providerUsable(current.provider)) {
      throw new UnifiedImageChannelUnavailableError();
    }
    if (['failed', 'not_created', 'canceled'].includes(current.channel.state)) {
      throw new UnifiedImageExecutionError(
        'channel_exhausted',
        current.channel.state === 'canceled'
          ? '任务已取消，未选择新通道。'
          : 'Image 2 当前通道已终止；任务 03 接入备用通道前不会自动重试。',
      );
    }
    return {
      taskId: task.id,
      channel: {
        channelKey: current.channel.channelKey,
        executionRevision: current.channel.executionRevision,
        definition: current.definition,
        provider: current.provider,
      },
    };
  }
  if (canceled) cancelUnsubmittedTask(db, job, task, null);
  return chooseInitialChannel(db, job, task, frozen);
}

export function requestUnifiedImageCancellation(db: Database.Database, jobId: string): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE jobs SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?) WHERE id = ?`)
      .run(at, jobId);
    db.prepare(`UPDATE execution_media_tasks SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?), updatedAt = ?
      WHERE taskId = ? AND module = 'image'`).run(at, at, jobId);
  }).immediate();
}

export function synchronizeUnifiedImageExecution(db: Database.Database, jobId: string): void {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as UnifiedJobRow | undefined;
  if (!job?.unifiedModel || !job.unifiedTaskId) return;
  const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
    | MediaTaskRow | undefined;
  if (!task?.currentChannelKey) return;
  const channel = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as MediaChannelRow | undefined;
  if (!channel) return;
  if (['failed', 'not_created'].includes(channel.state)
    && ['failed', 'canceled'].includes(job.status)) {
    // The explicit-failure handler already stored the precise terminal reason
    // and remote evidence. A generic queue-state projection must not erase it.
    return;
  }
  const operation = db.prepare(`SELECT *
    FROM execution_operations WHERE mediaTaskId = ? AND channelKey = ?`)
    .get(task.id, channel.channelKey) as ChannelOperationRow | undefined;
  const attempt = operation?.currentAttemptId
    ? db.prepare('SELECT remoteId, submissionState, terminalState FROM execution_attempts WHERE id = ?')
      .get(operation.currentAttemptId) as {
        remoteId: string | null; submissionState: string; terminalState: string | null;
      } | undefined
    : undefined;
  const remoteId = job.providerTaskId?.trim() || channel.remoteId?.trim() || attempt?.remoteId?.trim() || null;
  const downloadRecovery = job.providerStatus === 'download_failed' && Boolean(job.remoteImageUrl);
  const channelState = downloadRecovery ? 'accepted'
    : job.status === 'succeeded' ? 'succeeded'
      : job.status === 'failed' ? 'failed'
        : job.status === 'canceled' ? 'canceled'
          : job.status === 'deferred' ? (operation?.waitReason === 'pool_capacity' ? 'waiting_capacity' : 'selected')
            : job.status === 'needs_check'
              ? (job.providerStatus === 'unknown' ? 'unknown' : 'accepted')
              : 'selected';
  const taskStatus = job.status === 'deferred' ? 'waiting'
    : channelState === 'succeeded' ? 'succeeded'
      : channelState === 'failed' ? 'failed'
        : channelState === 'canceled' ? 'canceled'
          : channelState === 'unknown' ? 'unknown'
            : channelState === 'accepted' ? 'accepted'
              : 'routing';
  const at = new Date().toISOString();
  const evidence = {
    jobStatus: job.status,
    providerStatus: job.providerStatus,
    attemptId: operation?.currentAttemptId ?? null,
    operationWaitReason: operation?.waitReason ?? null,
    operationStatus: operation?.status ?? null,
    attemptSubmissionState: attempt?.submissionState ?? null,
    attemptTerminalState: attempt?.terminalState ?? null,
    errorMessage: job.errorMessage,
  };
  const result = downloadRecovery ? null
    : job.status === 'succeeded'
    ? { jobId: job.id, channelKey: channel.channelKey, remoteId }
    : job.status === 'failed' || job.status === 'canceled'
      ? { jobId: job.id, channelKey: channel.channelKey, remoteId, errorMessage: job.errorMessage }
      : null;
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = ?, operationId = COALESCE(?, operationId), remoteId = COALESCE(?, remoteId),
        evidenceJson = ?, updatedAt = ? WHERE id = ?`)
      .run(channelState, operation?.id ?? null, remoteId, JSON.stringify(evidence), at, channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = ?, currentChannelKey = ?, waitReason = ?, waitDetailJson = ?,
        resultJson = COALESCE(?, resultJson), updatedAt = ? WHERE id = ?`)
      .run(
        taskStatus, channel.channelKey,
        job.status === 'deferred' ? operation?.waitReason ?? 'waiting' : null,
        job.status === 'deferred'
          ? JSON.stringify(safeJsonObject(operation?.waitDetail ?? null) ?? {
            reason: operation?.waitReason ?? 'waiting',
          })
          : null,
        result === null ? null : JSON.stringify(result), at, task.id,
      );
  }).immediate();
}
