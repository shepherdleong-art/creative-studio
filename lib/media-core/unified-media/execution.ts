import { randomUUID } from 'node:crypto';
import { sha256Canonical } from '../../canonical-json.ts';
import type Database from 'better-sqlite3';
import { isPlaceholderValue } from '../../video-auth.ts';
import { requireAccessContext } from '../access-context.ts';
import { ensureMediaProviderPool } from '../execution/media-provider-pool.ts';
import {
  monthlyCostUsage,
  personalConcurrencyPoolKey,
  readActorPolicy,
  shanghaiAccountingPeriod,
} from '../execution/pools.ts';
import { classifySubmissionOutcome, type SubmissionEvidence } from '../submission-evidence.ts';
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
import { unifiedTaskSourceForJob } from './task-source.ts';
import {
  imageCongestionDeadline,
  readUnifiedImageCongestionSettings,
} from './settings.ts';
import {
  claimUnifiedChannelHealthForSelection,
  recordUnifiedChannelFailure,
  releaseUnifiedChannelRecoveryProbe,
  unifiedChannelFailureReasonFromEvidence,
} from './health.ts';

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
  parentJobId: string | null;
  creationSource: string | null;
  status: string;
  attempt: number;
  maxAttempts: number;
  executionRevision: number;
  providerTaskId: string | null;
  providerStatus: string | null;
  remoteImageUrl: string | null;
  outputImageId: string | null;
  errorMessage: string | null;
  unifiedModel: string | null;
  unifiedRuleVersion: string | null;
  unifiedTaskId: string | null;
  unifiedGenerationId: string | null;
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

export type UnifiedImageRouteProvider = ProviderRow;

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
  nextEligibleAt: string | null;
  waitReason: string | null;
  waitDetailJson: string | null;
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

export class UnifiedImageRecoveryPendingError extends Error {
  constructor() {
    super('已从持久失败记录恢复 Image 2 备用通道，等待下一次领取。');
    this.name = 'UnifiedImageRecoveryPendingError';
  }
}

export class UnifiedImageWaitingError extends Error {
  readonly nextEligibleAt: string;
  readonly waitReason: string;
  readonly waitDetail: Record<string, unknown> | null;

  constructor(input: {
    nextEligibleAt: string;
    waitReason?: string;
    waitDetail?: Record<string, unknown> | null;
  }) {
    super('Image 2 正在等待云端名额，达到管理员设置的拥堵阈值后会重新准入。');
    this.name = 'UnifiedImageWaitingError';
    this.nextEligibleAt = input.nextEligibleAt;
    this.waitReason = input.waitReason ?? 'pool_capacity';
    this.waitDetail = input.waitDetail ?? null;
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

export type UnifiedImageCapacityDecision =
  | {
    outcome: 'waiting';
    channelKey: string;
    nextEligibleAt: string;
    thresholdSec: number;
    waitDetail: Record<string, unknown>;
  }
  | {
    outcome: 'overflowed';
    previousChannelKey: string;
    nextChannelKey: string;
    nextExecutionRevision: number;
    thresholdSec: number;
    nextEligibleAt: null;
  }
  | {
    outcome: 'not_capacity' | 'ignored' | 'canceled';
    reason: string;
  };

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
  const inputHash = sha256Canonical(frozen);
  const at = new Date().toISOString();
  const fallbackSourceType = job.creationSource
    || (job.parentJobId ? 'project_regenerate' : 'project_scene');
  const source = unifiedTaskSourceForJob(db, {
    module: 'image',
    jobId: job.id,
    fallbackType: fallbackSourceType,
    fallbackId: job.projectId,
    fallbackMeta: { parentJobId: job.parentJobId },
  });
  db.transaction(() => {
    let task = job.unifiedTaskId
      ? db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as MediaTaskRow | undefined
      : undefined;
    if (!task) {
      if (!job.unifiedGenerationId) {
        const candidate = randomUUID();
        db.prepare(`UPDATE jobs SET unifiedGenerationId = COALESCE(unifiedGenerationId, ?)
          WHERE id = ?`).run(candidate, job.id);
        job.unifiedGenerationId = db.prepare('SELECT unifiedGenerationId FROM jobs WHERE id = ?')
          .pluck().get(job.id) as string;
      }
      const taskKey = `image:${job.id}:${job.unifiedGenerationId}`;
      db.prepare(`
        INSERT OR IGNORE INTO execution_media_tasks (
          id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
          inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
          status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
          resultJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, 'project', ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'routing', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        randomUUID(), taskKey, access.actor.userId, job.projectId, job.id,
        UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, inputHash,
        JSON.stringify(frozen), JSON.stringify({
          tier: frozen.tier, ratio: frozen.ratio, size: frozen.size, quality: frozen.quality,
        }), source.sourceType, source.sourceId, JSON.stringify(source.sourceMeta),
        at, at,
      );
      task = db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?').get(taskKey) as MediaTaskRow | undefined;
    }
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
  const bound = db.prepare('SELECT unifiedTaskId FROM jobs WHERE id = ?').pluck().get(job.id) as string | null;
  if (!bound) throw new Error('统一图片逻辑任务关联失败。');
  return db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(bound) as MediaTaskRow;
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

export interface UnifiedImageRouteSelection {
  definition: UnifiedImageChannelDefinition;
  provider: ProviderRow;
  executionRevision: number;
}

export interface UnifiedImageRouteSelectionFailure {
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

function reusableChannelOperation(
  db: Database.Database,
  taskId: string,
  channelKey: string,
): { id: string; status: string; revision: number } | null {
  const row = db.prepare(`
    SELECT o.id, o.status, c.executionRevision AS revision
    FROM execution_operations o
    JOIN execution_media_channels c
      ON c.mediaTaskId = o.mediaTaskId AND c.channelKey = o.channelKey
    WHERE o.mediaTaskId = ? AND o.channelKey = ?
  `).get(taskId, channelKey) as { id: string; status: string; revision: number } | undefined;
  if (!row || !['pending', 'deferred'].includes(row.status)) return null;
  return row;
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
  output: Pick<FrozenUnifiedImageRequest, 'tier' | 'ratio'>,
  executionRevision: number,
  excludeChannelKey?: string,
): UnifiedImageRouteSelection | UnifiedImageRouteSelectionFailure {
  if (submittedChannelCount(db, task.id) >= 2) {
    return {
      reason: 'channel_limit',
      message: 'Image 2 的两条通道都已真实提交过，不会再发起第三次生成。',
    };
  }
  for (const definition of unifiedImageCompatibleChannels(output.tier, output.ratio)) {
    if (definition.channelKey === excludeChannelKey) continue;
    if (channelHasSubmission(db, task.id, definition.channelKey)) continue;
    const channel = db.prepare(`SELECT state, executionRevision FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, definition.channelKey) as
      { state: string; executionRevision: number } | undefined;
    if (!channel || !['candidate', 'skipped', 'overflowed'].includes(channel.state)) continue;
    const reusable = reusableChannelOperation(db, task.id, definition.channelKey);
    if (!reusable && channel.state === 'overflowed') continue;

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
    if (!claimUnifiedChannelHealthForSelection(db, {
      unifiedModel: task.unifiedModel,
      channelKey: definition.channelKey,
      providerId: definition.providerId,
    })) {
      // Health avoidance only affects new selection. The task keeps this
      // channel as a recoverable candidate, while another compatible channel
      // can take the work immediately.
      continue;
    }
    return {
      definition,
      provider: inspected.provider,
      executionRevision: reusable?.revision ?? Math.max(1, executionRevision + 1),
    };
  }
  return {
    reason: 'no_available_channel',
    message: '当前没有另一条已启用、凭据可用且未提交过的 Image 2 通道，任务未继续提交。',
  };
}

export function markUnifiedImageChannelSelected(
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

/**
 * Shared channel planner for any module that owns the logical media task.
 * It consumes the exact provider catalog, complete output combination,
 * provider availability, explicit pool mapping and channel health. It never
 * creates an admission permit or sends a request.
 */
export function selectUnifiedImageChannelForTask(
  db: Database.Database,
  input: {
    mediaTaskId: string;
    tier: FrozenUnifiedImageRequest['tier'];
    ratio: string;
    executionRevision: number;
    excludeChannelKey?: string;
  },
): UnifiedImageRouteSelection | UnifiedImageRouteSelectionFailure {
  const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(input.mediaTaskId) as
    | MediaTaskRow
    | undefined;
  if (!task) throw new Error(`统一图片逻辑任务 ${input.mediaTaskId} 不存在。`);
  return findNextChannel(
    db,
    task,
    { tier: input.tier, ratio: input.ratio },
    input.executionRevision,
    input.excludeChannelKey,
  );
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
    const selection = findNextChannel(db, task, frozen, job.executionRevision);
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
    const { definition, provider, executionRevision: revision } = selection;
    const changed = db.prepare(`UPDATE jobs SET executionRevision = ?
      WHERE id = ? AND cancelRequestedAt IS NULL AND status = 'running'`).run(revision, job.id);
    if (changed.changes !== 1) throw new UnifiedImageCanceledError();
    markUnifiedImageChannelSelected(db, task.id, definition, revision);
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

interface PersistedExplicitFailureRow {
  attemptId: string;
  operationId: string;
  businessAttemptNo: number;
  remoteId: string | null;
  terminalState: 'not_created' | 'failed';
  errorCode: string | null;
  providerSnapshotJson: string;
  operationProviderSnapshotJson: string;
}

/**
 * Rebuild the same submission evidence from a persisted, settled terminal
 * attempt. This closes the crash window between attempt settlement and the
 * queue's explicit-failure handler: an `not_created` operation is reset to
 * `pending` by the execution facade, so without this check a restart could
 * submit the same channel again.
 */
function persistedExplicitFailureInput(
  db: Database.Database,
  job: UnifiedJobRow,
  task: MediaTaskRow,
  channel: MediaChannelRow,
): UnifiedImageExplicitFailureInput | null {
  const row = db.prepare(`
    SELECT a.id AS attemptId, a.operationId, a.businessAttemptNo, a.remoteId, a.terminalState,
      a.errorCode, a.providerSnapshotJson, o.providerSnapshotJson AS operationProviderSnapshotJson
    FROM execution_operations o
    JOIN execution_attempts a ON a.operationId = o.id
    WHERE o.mediaTaskId = ? AND o.channelKey = ?
      AND a.intentJournalSeq IS NOT NULL
      AND a.submissionState = 'terminal'
      AND a.terminalState IN ('not_created', 'failed')
      AND a.costState IN ('released', 'settled', 'unknown')
    ORDER BY a.createdAt DESC, a.transportSeq DESC, a.id DESC
    LIMIT 1
  `).get(task.id, channel.channelKey) as PersistedExplicitFailureRow | undefined;
  if (!row) return null;
  const providerSnapshot = safeJsonObject(row.providerSnapshotJson)
    ?? safeJsonObject(row.operationProviderSnapshotJson);
  const adapterId = typeof providerSnapshot?.type === 'string' && providerSnapshot.type.trim()
    ? providerSnapshot.type.trim()
    : 'unified-image';
  return {
    evidence: classifySubmissionOutcome({
      entry: 'image',
      taskId: job.id,
      businessAttemptNo: row.businessAttemptNo,
      adapterId,
      stage: 'submit',
      source: 'persisted',
      outcome: row.terminalState === 'not_created' ? 'confirmed_not_created' : 'terminal_failed',
      remoteId: row.remoteId,
      errorCode: row.errorCode,
    }),
    attemptId: row.attemptId,
    operationId: row.operationId,
    channelKey: channel.channelKey,
  };
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

interface CapacityOperationRow {
  id: string;
  actorId: string;
  waitReason: string | null;
  waitDetail: string | null;
  quoteJson: string;
  requiredPoolsJson: string;
}

export function unifiedCapacityOnlyOperation(
  db: Database.Database,
  operationId: string,
  now: Date,
): { ok: boolean; reason: string; detail: Record<string, unknown> | null } {
  const operation = db.prepare(`
    SELECT id, actorId, waitReason, waitDetail, quoteJson, requiredPoolsJson
    FROM execution_operations WHERE id = ?
  `).get(operationId) as CapacityOperationRow | undefined;
  if (!operation) return { ok: false, reason: 'operation_missing', detail: null };
  const detail = safeJsonObject(operation.waitDetail);
  if (operation.waitReason !== 'pool_capacity' || detail?.reason !== 'pool_capacity') {
    return { ok: false, reason: operation.waitReason ?? 'not_capacity', detail };
  }
  const policy = readActorPolicy(db, operation.actorId);
  const personalHeld = db.prepare(`
    SELECT COUNT(*) FROM execution_reservations
    WHERE kind = 'concurrency' AND poolKey = ? AND state = 'held'
  `).pluck().get(personalConcurrencyPoolKey(operation.actorId)) as number;
  if (policy.effectiveConcurrency !== null && personalHeld >= policy.effectiveConcurrency) {
    return { ok: false, reason: 'personal_concurrency', detail };
  }
  if (policy.effectiveConcurrency === null && typeof detail?.poolKey === 'string') {
    const capacity = Number(detail.capacity);
    if (Number.isSafeInteger(capacity) && capacity >= 0) {
      const activeActors = new Set<string>(
        (db.prepare(`
          SELECT DISTINCT o.actorId
          FROM execution_operations o
          WHERE o.status IN ('pending', 'deferred')
            AND EXISTS (
              SELECT 1 FROM json_each(o.requiredPoolsJson) WHERE json_each.value = ?
            )
        `).all(detail.poolKey) as Array<{ actorId: string }>).map((row) => row.actorId),
      );
      for (const row of db.prepare(`
        SELECT DISTINCT r.actorId
        FROM execution_reservations r
        WHERE r.kind = 'concurrency' AND r.poolKey = ? AND r.state = 'held'
      `).all(detail.poolKey) as Array<{ actorId: string }>) {
        activeActors.add(row.actorId);
      }
      const fairLimit = Math.max(1, Math.ceil(capacity / Math.max(1, activeActors.size)));
      if (personalHeld >= fairLimit) return { ok: false, reason: 'fair_share', detail };
    }
  }
  if (policy.monthlyLimitMinor !== null) {
    const quote = safeJsonObject(operation.quoteJson);
    if (quote?.kind === 'unpriced') return { ok: false, reason: 'pricing_required', detail };
    const pinned = db.prepare(`
      SELECT 1 FROM execution_reservations
      WHERE kind = 'cost' AND actorId = ? AND state IN ('held', 'settled') AND costState = 'unknown'
      LIMIT 1
    `).get(operation.actorId);
    if (pinned) return { ok: false, reason: 'cost_unknown', detail };
    const reserve = quote?.kind === 'priced'
      && quote.reserve
      && typeof quote.reserve === 'object'
      && typeof (quote.reserve as { minor?: unknown }).minor === 'number'
      ? Number((quote.reserve as { minor: number }).minor)
      : 0;
    if (monthlyCostUsage(db, operation.actorId, shanghaiAccountingPeriod(now)) + reserve
      > policy.monthlyLimitMinor) {
      return { ok: false, reason: 'monthly_budget', detail };
    }
  }
  return { ok: true, reason: 'pool_capacity', detail };
}

interface CapacityTaskContext {
  job: UnifiedJobRow;
  task: MediaTaskRow;
  channel: MediaChannelRow;
  operation: ChannelOperationRow & { actorId: string };
}

function readCapacityTaskContext(db: Database.Database, jobId: string): CapacityTaskContext | null {
  const job = readJob(db, jobId);
  if (!job.unifiedTaskId) return null;
  const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
    MediaTaskRow | undefined;
  if (!task?.currentChannelKey) return null;
  const channel = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
    MediaChannelRow | undefined;
  if (!channel) return null;
  const operation = db.prepare(`SELECT * FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, channel.channelKey) as
    (ChannelOperationRow & { actorId: string }) | undefined;
  if (!operation) return null;
  return { job, task, channel, operation };
}

function waitingDetail(input: {
  taskId: string;
  channelKey: string;
  operationDetail: Record<string, unknown> | null;
  thresholdSec: number;
  waitingSinceAt: string;
  nextEligibleAt: string;
}): Record<string, unknown> {
  return {
    ...(input.operationDetail ?? {}),
    reason: 'pool_capacity',
    mediaTaskId: input.taskId,
    channelKey: input.channelKey,
    thresholdSec: input.thresholdSec,
    waitingSinceAt: input.waitingSinceAt,
    nextEligibleAt: input.nextEligibleAt,
  };
}

function waitingMessage(detail: Record<string, unknown>, channelKey: string): string {
  const thresholdSec = typeof detail.thresholdSec === 'number' ? detail.thresholdSec : 0;
  const channelLabel = channelKey === 'qiniu' ? '七牛' : '腾讯';
  return thresholdSec > 0
    ? `${channelLabel}云端名额已满，等待可用资源（已等待满 ${thresholdSec} 秒后重新检查通道），尚未提交。`
    : `${channelLabel}云端名额已满，等待可用资源，尚未提交。`;
}

function persistCapacityWait(
  db: Database.Database,
  context: CapacityTaskContext,
  input: {
    now: Date;
    thresholdSec: number;
    nextEligibleAt: string;
    detail: Record<string, unknown>;
  },
): UnifiedImageCapacityDecision {
  const at = input.now.toISOString();
  const evidence = {
    reason: 'pool_capacity',
    waitingSinceAt: input.detail.waitingSinceAt,
    nextEligibleAt: input.nextEligibleAt,
    thresholdSec: input.thresholdSec,
    operationWaitDetail: input.detail,
  };
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'waiting_capacity', nextEligibleAt = ?, evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(input.nextEligibleAt, JSON.stringify(evidence), at, context.channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'waiting', currentChannelKey = ?, nextEligibleAt = ?,
        waitReason = 'pool_capacity', waitDetailJson = ?, updatedAt = ?
      WHERE id = ?`).run(
      context.channel.channelKey, input.nextEligibleAt,
      JSON.stringify(input.detail), at, context.task.id,
    );
    db.prepare(`UPDATE jobs
      SET status = 'deferred', errorMessage = ?, startedAt = NULL, finishedAt = NULL
      WHERE id = ? AND status IN ('running', 'pending', 'retrying', 'deferred')`)
      .run(waitingMessage(input.detail, context.channel.channelKey), context.job.id);
  }).immediate();
  return {
    outcome: 'waiting',
    channelKey: context.channel.channelKey,
    nextEligibleAt: input.nextEligibleAt,
    thresholdSec: input.thresholdSec,
    waitDetail: input.detail,
  };
}

/**
 * Consume the precise execution-deferred reason. A threshold is started only
 * when the target pool is full and every later budget gate would otherwise
 * pass. At the deadline qiniu is retried first; only a second capacity result
 * may overflow to tencent.
 */
export function handleUnifiedImageCapacityDeferral(
  db: Database.Database,
  jobId: string,
  now = new Date(),
): UnifiedImageCapacityDecision {
  return db.transaction((): UnifiedImageCapacityDecision => {
    const context = readCapacityTaskContext(db, jobId);
    if (!context) return { outcome: 'ignored', reason: 'task_not_ready' };
    const { job, task, channel, operation } = context;
    if (job.cancelRequestedAt || task.cancelRequestedAt) {
      return { outcome: 'canceled', reason: 'canceled' };
    }
    const capacity = unifiedCapacityOnlyOperation(db, operation.id, now);
    if (!capacity.ok) {
      if ([
        'monthly_budget', 'cost_unknown', 'pricing_required',
        'personal_concurrency', 'fair_share',
      ].includes(capacity.reason)) {
        const at = now.toISOString();
        db.prepare(`UPDATE execution_operations
          SET waitReason = ?, waitDetail = ?, updatedAt = ?
          WHERE id = ? AND status IN ('pending', 'deferred')`)
          .run(capacity.reason, JSON.stringify({ reason: capacity.reason }), at, operation.id);
      }
      return { outcome: 'not_capacity', reason: capacity.reason };
    }
    if (channel.channelKey !== 'qiniu') {
      // Tencent has no 30-second overflow policy, but it still must not spin.
      const nextEligibleAt = new Date(now.getTime() + 1_000).toISOString();
      const detail = waitingDetail({
        taskId: task.id,
        channelKey: channel.channelKey,
        operationDetail: capacity.detail,
        thresholdSec: 0,
        waitingSinceAt: now.toISOString(),
        nextEligibleAt,
      });
      return persistCapacityWait(db, context, {
        now, thresholdSec: 0, nextEligibleAt, detail,
      });
    }

    const settings = readUnifiedImageCongestionSettings(db);
    const thresholdSec = settings.imageCongestionThresholdSec;
    if (channel.state !== 'waiting_capacity') {
      if (thresholdSec > 0) {
        const deadline = imageCongestionDeadline(now, thresholdSec);
        const nextEligibleAt = deadline.toISOString();
        const detail = waitingDetail({
          taskId: task.id,
          channelKey: channel.channelKey,
          operationDetail: capacity.detail,
          thresholdSec,
          waitingSinceAt: now.toISOString(),
          nextEligibleAt,
        });
        return persistCapacityWait(db, context, {
          now, thresholdSec, nextEligibleAt, detail,
        });
      }
    } else {
      const deadline = channel.nextEligibleAt ? new Date(channel.nextEligibleAt) : null;
      if (deadline && Number.isFinite(deadline.getTime()) && now < deadline) {
        const previous = safeJsonObject(channel.evidenceJson) ?? capacity.detail ?? {};
        return {
          outcome: 'waiting',
          channelKey: channel.channelKey,
          nextEligibleAt: deadline.toISOString(),
          thresholdSec: typeof previous.thresholdSec === 'number' ? previous.thresholdSec : thresholdSec,
          waitDetail: safeJsonObject(task.waitDetailJson) ?? previous,
        };
      }
    }

    const frozen = readFrozenRequest(job);
    const selection = findNextChannel(
      db, task, frozen, job.executionRevision, channel.channelKey,
    );
    const at = now.toISOString();
    if ('reason' in selection) {
      // No alternative is available. Keep qiniu waiting and retry after the
      // configured interval instead of spinning or pretending it failed.
      const retryAt = imageCongestionDeadline(now, Math.max(1, thresholdSec)).toISOString();
      const detail = waitingDetail({
        taskId: task.id,
        channelKey: channel.channelKey,
        operationDetail: capacity.detail,
        thresholdSec,
        waitingSinceAt:
          (safeJsonObject(channel.evidenceJson)?.waitingSinceAt as string | undefined) ?? at,
        nextEligibleAt: retryAt,
      });
      return persistCapacityWait(db, context, {
        now, thresholdSec, nextEligibleAt: retryAt, detail,
      });
    }

    const evidence = {
      reason: 'pool_capacity',
      overflowedAt: at,
      thresholdSec,
      operationWaitDetail: capacity.detail,
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
    };
    db.prepare(`UPDATE execution_media_channels
      SET state = 'overflowed', nextEligibleAt = NULL, evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify(evidence), at, channel.id);
    const revision = selection.executionRevision;
    const changed = db.prepare(`UPDATE jobs SET
        status = 'pending', executionRevision = ?, errorMessage = NULL, finishedAt = NULL,
        providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL,
        remoteImageUrl = NULL, submittedAt = NULL, lastPolledAt = NULL, pollCount = 0,
        startedAt = NULL, latencyMs = NULL
      WHERE id = ? AND cancelRequestedAt IS NULL
        AND status IN ('running', 'pending', 'retrying', 'deferred')`)
      .run(revision, job.id);
    if (changed.changes !== 1) return { outcome: 'ignored', reason: 'job_changed' };
    markUnifiedImageChannelSelected(db, task.id, selection.definition, revision);
    return {
      outcome: 'overflowed',
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
      nextExecutionRevision: revision,
      thresholdSec,
      nextEligibleAt: null,
    };
  }).immediate();
}

function pauseDetail(
  detail: Record<string, unknown> | null,
  now: Date,
  deadline: string | null,
): Record<string, unknown> {
  const remainingMs = deadline && Number.isFinite(Date.parse(deadline))
    ? Math.max(0, Date.parse(deadline) - now.getTime())
    : 0;
  return {
    ...(detail ?? {}),
    pausedAt: now.toISOString(),
    pausedRemainingMs: remainingMs,
  };
}

/** Persist the remaining capacity interval before a project queue pauses. */
export function pauseUnifiedImageQueueWaits(
  db: Database.Database,
  scopeId: string,
  now = new Date(),
): void {
  const tasks = db.prepare(`SELECT * FROM execution_media_tasks
    WHERE module = 'image' AND scopeId = ? AND status = 'waiting'
      AND currentChannelKey IS NOT NULL`).all(scopeId) as MediaTaskRow[];
  if (tasks.length === 0) return;
  db.transaction(() => {
    for (const task of tasks) {
      const channel = db.prepare(`SELECT * FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
        MediaChannelRow | undefined;
      if (!channel?.nextEligibleAt) continue;
      const detail = pauseDetail(safeJsonObject(task.waitDetailJson), now, channel.nextEligibleAt);
      db.prepare(`UPDATE execution_media_tasks SET waitDetailJson = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify(detail), now.toISOString(), task.id);
      const evidence = {
        ...(safeJsonObject(channel.evidenceJson) ?? {}),
        pausedAt: detail.pausedAt,
        pausedRemainingMs: detail.pausedRemainingMs,
      };
      db.prepare(`UPDATE execution_media_channels SET evidenceJson = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify(evidence), now.toISOString(), channel.id);
    }
  }).immediate();
}

/** Resume capacity waits without counting the paused interval. */
export function resumeUnifiedImageQueueWaits(
  db: Database.Database,
  scopeId: string,
  now = new Date(),
): void {
  const tasks = db.prepare(`SELECT * FROM execution_media_tasks
    WHERE module = 'image' AND scopeId = ? AND status = 'waiting'
      AND currentChannelKey IS NOT NULL`).all(scopeId) as MediaTaskRow[];
  if (tasks.length === 0) return;
  db.transaction(() => {
    for (const task of tasks) {
      const detail = safeJsonObject(task.waitDetailJson);
      if (!detail || typeof detail.pausedRemainingMs !== 'number') continue;
      const remainingMs = Math.max(0, detail.pausedRemainingMs);
      const nextEligibleAt = new Date(now.getTime() + remainingMs).toISOString();
      const rest = { ...detail };
      delete rest.pausedAt;
      delete rest.pausedRemainingMs;
      const resumed = {
        ...rest,
        nextEligibleAt,
        resumedAt: now.toISOString(),
      };
      const channel = db.prepare(`SELECT * FROM execution_media_channels
        WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
        MediaChannelRow | undefined;
      if (!channel) continue;
      const evidence = {
        ...(safeJsonObject(channel.evidenceJson) ?? {}),
        pausedAt: undefined,
        pausedRemainingMs: undefined,
        resumedAt: now.toISOString(),
        nextEligibleAt,
      };
      db.prepare(`UPDATE execution_media_channels
        SET nextEligibleAt = ?, evidenceJson = ?, updatedAt = ? WHERE id = ?`)
        .run(nextEligibleAt, JSON.stringify(evidence), now.toISOString(), channel.id);
      db.prepare(`UPDATE execution_media_tasks
        SET nextEligibleAt = ?, waitDetailJson = ?, updatedAt = ? WHERE id = ?`)
        .run(nextEligibleAt, JSON.stringify(resumed), now.toISOString(), task.id);
    }
  }).immediate();
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
  if (evidence.identity.entry !== 'image'
    || evidence.identity.taskId !== jobId
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
      const estimatedCost = unifiedImageAttemptCostMinor(db, job.id) / 100;
      db.prepare(`UPDATE jobs
        SET status = 'canceled', errorMessage = 'Canceled by user',
          cancelRequestedAt = COALESCE(cancelRequestedAt, ?), finishedAt = COALESCE(finishedAt, ?),
          providerTaskId = NULL, providerStatus = NULL, remoteImageUrl = NULL, estimatedCost = ?
        WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'failed', 'needs_check', 'deferred')`)
        .run(at, at, estimatedCost, job.id);
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

    const failureReason = unifiedChannelFailureReasonFromEvidence(evidence);
    if (failureReason) {
      recordUnifiedChannelFailure(db, {
        unifiedModel: task.unifiedModel,
        channelKey: channel.channelKey,
        providerId: channel.providerId,
        reasonCode: failureReason,
        now: new Date(at),
      });
    } else {
      releaseUnifiedChannelRecoveryProbe(db, {
        unifiedModel: task.unifiedModel,
        channelKey: channel.channelKey,
        providerId: channel.providerId,
      });
    }
    const frozen = readFrozenRequest(job);
    const selection = findNextChannel(
      db, task, frozen, job.executionRevision, channel.channelKey,
    );
    if ('reason' in selection) {
      const estimatedCost = unifiedImageAttemptCostMinor(db, job.id) / 100;
      const message = selection.reason === 'channel_limit'
        ? 'Image 2 的两条可用通道均已明确失败，任务已停止，不会发起第三次生成。'
        : selection.message;
      db.prepare(`UPDATE jobs SET status = 'failed', finishedAt = ?, errorMessage = ?, estimatedCost = ?
        WHERE id = ? AND status IN ('pending', 'retrying', 'running', 'failed', 'needs_check', 'deferred')`)
        .run(at, message, estimatedCost, job.id);
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

    const revision = selection.executionRevision;
    const estimatedCost = unifiedImageAttemptCostMinor(db, job.id) / 100;
    const changed = db.prepare(`UPDATE jobs SET
        status = 'pending', executionRevision = ?, errorMessage = NULL, finishedAt = NULL,
        providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL,
        remoteImageUrl = NULL, submittedAt = NULL, lastPolledAt = NULL, pollCount = 0,
        startedAt = NULL, latencyMs = NULL, usageSnapshotJson = NULL, estimatedCost = ?
      WHERE id = ? AND cancelRequestedAt IS NULL
        AND status IN ('pending', 'retrying', 'running', 'failed', 'needs_check', 'deferred')`)
      .run(revision, estimatedCost, job.id);
    if (changed.changes !== 1) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    markUnifiedImageChannelSelected(db, task.id, selection.definition, revision);
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
  now = new Date(),
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
      && !hasAcceptedEvidence(db, job, current.channel)) {
      const persistedFailure = persistedExplicitFailureInput(db, job, task, current.channel);
      if (persistedFailure) {
        const decision = handleUnifiedImageExplicitFailure(db, jobId, persistedFailure);
        if (decision.outcome === 'next_channel') throw new UnifiedImageRecoveryPendingError();
        if (decision.outcome === 'canceled') throw new UnifiedImageCanceledError();
        if (decision.outcome === 'exhausted') {
          throw new UnifiedImageExecutionError(
            'channel_exhausted',
            'Image 2 已记录明确失败，且没有剩余可提交通道。',
          );
        }
        throw new UnifiedImageExecutionError(
          'channel_exhausted',
          'Image 2 已记录明确失败，当前通道不会再次提交。',
        );
      }
    }
    if (['selected', 'waiting_capacity'].includes(current.channel.state)
      && !hasAcceptedEvidence(db, job, current.channel)
      && !providerUsable(current.provider)) {
      throw new UnifiedImageChannelUnavailableError();
    }
    if (current.channel.state === 'waiting_capacity') {
      const storedDetail = safeJsonObject(current.channel.evidenceJson)
        ?? safeJsonObject(task.waitDetailJson)
        ?? {};
      let nextEligibleAt = current.channel.nextEligibleAt;
      if (typeof storedDetail.pausedRemainingMs === 'number') {
        nextEligibleAt = new Date(
          now.getTime() + Math.max(0, storedDetail.pausedRemainingMs),
        ).toISOString();
        const resumed = {
          ...storedDetail,
          pausedAt: undefined,
          pausedRemainingMs: undefined,
          nextEligibleAt,
          resumedAt: now.toISOString(),
        };
        db.transaction(() => {
          db.prepare(`UPDATE execution_media_channels
            SET nextEligibleAt = ?, evidenceJson = ?, updatedAt = ? WHERE id = ?`)
            .run(nextEligibleAt, JSON.stringify(resumed), now.toISOString(), current.channel.id);
          db.prepare(`UPDATE execution_media_tasks
            SET nextEligibleAt = ?, waitDetailJson = ?, updatedAt = ? WHERE id = ?`)
            .run(nextEligibleAt, JSON.stringify(resumed), now.toISOString(), task.id);
        }).immediate();
      }
      if (nextEligibleAt && Number.isFinite(Date.parse(nextEligibleAt))
        && now.getTime() < Date.parse(nextEligibleAt)) {
        throw new UnifiedImageWaitingError({
          nextEligibleAt,
          waitReason: task.waitReason ?? 'pool_capacity',
          waitDetail: safeJsonObject(task.waitDetailJson),
        });
      }
    }
    if (['failed', 'not_created', 'canceled'].includes(current.channel.state)) {
      throw new UnifiedImageExecutionError(
        'channel_exhausted',
        current.channel.state === 'canceled'
          ? '任务已取消，未选择新通道。'
          : 'Image 2 当前通道已终止；未自动选择新通道，请核查任务记录。',
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
  if (job.status === 'deferred'
    && channel.state === 'waiting_capacity'
    && task.waitReason === 'pool_capacity'
    && task.nextEligibleAt) {
    // The congestion handler already persisted the precise deadline, evidence,
    // and operation detail. A generic queue projection must not erase them.
    return;
  }
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
  const lateSucceeded = job.status === 'canceled'
    && job.providerStatus === 'succeeded'
    && Boolean(job.outputImageId);
  const channelState = lateSucceeded ? 'succeeded'
    : downloadRecovery ? 'accepted'
    : job.status === 'succeeded' ? 'succeeded'
      : job.status === 'failed' ? 'failed'
        : job.status === 'canceled' ? 'canceled'
          : job.status === 'deferred' ? (operation?.waitReason === 'pool_capacity' ? 'waiting_capacity' : 'selected')
            : job.status === 'needs_check'
              ? (job.providerStatus === 'unknown' ? 'unknown' : 'accepted')
              : 'selected';
  const taskStatus = lateSucceeded ? 'canceled'
    : job.status === 'deferred' ? 'waiting'
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
  const result = lateSucceeded
    ? {
      jobId: job.id,
      channelKey: channel.channelKey,
      remoteId,
      outputImageId: job.outputImageId,
      lateResult: true,
    }
    : downloadRecovery ? null
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
