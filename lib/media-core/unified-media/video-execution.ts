import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requireAccessContext } from '../access-context.ts';
import { ensureMediaProviderPool } from '../execution/media-provider-pool.ts';
import { classifySubmissionOutcome, type SubmissionEvidence } from '../submission-evidence.ts';
import {
  resolveVideoProviderRuntimeConfig,
  type VideoProviderEnvConfig,
} from '../../video-auth.ts';
import {
  UNIFIED_KLING3_ANCHOR_ID,
  UNIFIED_KLING3_CHANNELS,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  type UnifiedVideoChannelDefinition,
} from './catalog.ts';
import {
  freezeUnifiedKlingVideoRequest,
  unifiedKlingCompatibleChannels,
  unifiedKlingFrozenRequestMatchesJob,
  UnifiedKlingRequestError,
  type FrozenUnifiedKlingVideoRequest,
} from './video-requests.ts';
import { unifiedTaskSourceForJob } from './task-source.ts';
import {
  claimUnifiedChannelHealthForSelection,
  recordUnifiedChannelFailure,
  releaseUnifiedChannelRecoveryProbe,
  unifiedChannelFailureReasonFromEvidence,
} from './health.ts';
import { unifiedCapacityOnlyOperation } from './execution.ts';

interface UnifiedVideoJobRow {
  id: string;
  projectId: string;
  shotSetId: string | null;
  shotId: string | null;
  sourceImageId: string;
  tailImageId: string | null;
  providerId: string;
  model: string;
  prompt: string;
  durationSec: number;
  generationMode: string;
  aspectRatio: string | null;
  resolution: string | null;
  multiShot: number | null;
  status: string;
  attempt: number;
  maxAttempts: number;
  executionRevision: number;
  providerTaskId: string | null;
  providerStatus: string | null;
  remoteVideoUrl: string | null;
  localVideoPath: string | null;
  filename: string | null;
  errorMessage: string | null;
  unifiedModel: string | null;
  unifiedRuleVersion: string | null;
  unifiedTaskId: string | null;
  unifiedRequestJson: string | null;
  cancelRequestedAt: string | null;
}

interface ProviderRow extends VideoProviderEnvConfig {
  id: string;
  name: string;
  type: string;
  defaultModel: string;
  enabled: number;
  baseUrl: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
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
  sourceType: string;
  sourceId: string | null;
  sourceMetaJson: string;
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
  status: string;
  waitReason: string | null;
  waitDetail: string | null;
  currentAttemptId: string | null;
  updatedAt: string;
}

export class UnifiedKlingExecutionError extends Error {
  readonly code:
    | 'no_available_channel'
    | 'channel_identity_mismatch'
    | 'invalid_frozen_contract'
    | 'invalid_failure_evidence'
    | 'channel_exhausted';

  constructor(code: UnifiedKlingExecutionError['code'], message: string) {
    super(message);
    this.name = 'UnifiedKlingExecutionError';
    this.code = code;
  }
}

export class UnifiedKlingCanceledError extends Error {
  constructor() {
    super('任务已记录取消意图，不再选择新通道或提交。');
    this.name = 'UnifiedKlingCanceledError';
  }
}

export class UnifiedKlingWaitingError extends Error {
  readonly nextEligibleAt: string;
  readonly waitReason: string;
  readonly waitDetail: Record<string, unknown> | null;

  constructor(input: {
    nextEligibleAt: string;
    waitReason?: string;
    waitDetail?: Record<string, unknown> | null;
  }) {
    super('可灵 3.0 正在等待云端名额。');
    this.name = 'UnifiedKlingWaitingError';
    this.nextEligibleAt = input.nextEligibleAt;
    this.waitReason = input.waitReason ?? 'pool_capacity';
    this.waitDetail = input.waitDetail ?? null;
  }
}

export class UnifiedKlingRecoveryPendingError extends Error {
  constructor() {
    super('已从持久失败记录恢复可灵 3.0 备用通道，等待下一次领取。');
    this.name = 'UnifiedKlingRecoveryPendingError';
  }
}

export class UnifiedKlingStaleSubmissionError extends Error {
  constructor() {
    super('统一可灵任务已切换通道或被取消，本次未发送请求。');
    this.name = 'UnifiedKlingStaleSubmissionError';
  }
}

export interface PreparedUnifiedKlingExecution {
  taskId: string;
  channel: {
    channelKey: string;
    executionRevision: number;
    definition: UnifiedVideoChannelDefinition;
    provider: ProviderRow;
    runtimeBaseUrl: string;
    runtimeApiKey: string;
  };
}

export type UnifiedKlingFailureDecision =
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

export type UnifiedKlingCapacityDecision =
  | {
    outcome: 'overflowed';
    previousChannelKey: string;
    nextChannelKey: string;
    nextExecutionRevision: number;
  }
  | {
    outcome: 'waiting';
    channelKey: string;
    nextEligibleAt: string;
  }
  | {
    outcome: 'not_capacity' | 'ignored' | 'canceled';
    reason: string;
  };

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

function readJob(db: Database.Database, jobId: string): UnifiedVideoJobRow {
  const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as
    | UnifiedVideoJobRow
    | undefined;
  if (!job) throw new Error(`统一可灵任务 ${jobId} 不存在。`);
  if (!job.unifiedModel) throw new Error(`视频任务 ${jobId} 不是统一模型任务。`);
  if (job.providerId !== UNIFIED_KLING3_ANCHOR_ID || job.model !== UNIFIED_KLING3_MODEL_KEY) {
    throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵任务没有冻结统一模型锚点身份。');
  }
  return job;
}

function readFrozenRequest(job: UnifiedVideoJobRow): FrozenUnifiedKlingVideoRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(job.unifiedRequestJson ?? '');
  } catch {
    throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵任务的冻结输入无法读取。');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵任务的冻结输入结构无效。');
  }
  const source = raw as Record<string, unknown>;
  let frozen: FrozenUnifiedKlingVideoRequest;
  try {
    frozen = freezeUnifiedKlingVideoRequest({
      sourceImageId: String(source.sourceImageId ?? ''),
      tailImageId: typeof source.tailImageId === 'string' ? source.tailImageId : null,
      referenceAssetIds: Array.isArray(source.referenceAssetIds)
        ? source.referenceAssetIds.map((item) => String(item ?? '')) : [],
      prompt: String(source.prompt ?? ''),
      durationSec: Number(source.durationSec),
      generationMode: String(source.generationMode ?? ''),
      multiShot: source.multiShot,
      aspectRatio: typeof source.aspectRatio === 'string' ? source.aspectRatio : null,
      resolution: typeof source.resolution === 'string' ? source.resolution : null,
    });
  } catch (error) {
    if (error instanceof UnifiedKlingRequestError) {
      throw new UnifiedKlingExecutionError('invalid_frozen_contract', error.message);
    }
    throw error;
  }
  if (frozen.unifiedModel !== job.unifiedModel
    || frozen.ruleVersion !== job.unifiedRuleVersion
    || frozen.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION
    || !unifiedKlingFrozenRequestMatchesJob(frozen, job)) {
    throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵任务冻结输入与业务行不一致。');
  }
  return frozen;
}

function ensureLogicalTask(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  frozen: FrozenUnifiedKlingVideoRequest,
): MediaTaskRow {
  const access = requireAccessContext();
  if (access.kind !== 'team') throw new Error('统一可灵任务缺少团队发起人。');
  const taskKey = `video:${job.id}`;
  const inputHash = hash(frozen);
  const at = new Date().toISOString();
  const source = unifiedTaskSourceForJob(db, {
    module: 'video',
    jobId: job.id,
    fallbackType: 'project_video',
    fallbackId: job.shotId ?? job.projectId,
    fallbackMeta: {
      projectId: job.projectId,
      shotSetId: job.shotSetId,
      shotId: job.shotId,
    },
  });
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO execution_media_tasks (
        id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
        inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
        status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
        resultJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'project', ?, 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'routing',
        NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      randomUUID(), taskKey, access.actor.userId, job.projectId, job.id,
      UNIFIED_KLING3_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, inputHash,
      JSON.stringify(frozen),
      JSON.stringify({
        durationSec: frozen.durationSec,
        generationMode: frozen.generationMode,
        multiShot: frozen.multiShot,
        aspectRatio: frozen.aspectRatio,
        resolution: frozen.resolution,
        tailImageId: frozen.tailImageId,
      }),
      source.sourceType, source.sourceId, JSON.stringify(source.sourceMeta),
      at, at,
    );
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?')
      .get(taskKey) as MediaTaskRow | undefined;
    if (!task) throw new Error('统一可灵逻辑任务创建失败。');
    if (job.unifiedTaskId && job.unifiedTaskId !== task.id) {
      throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵任务关联的逻辑任务身份已漂移。');
    }
    if (task.actorId !== access.actor.userId || task.scopeType !== 'project'
      || task.scopeId !== job.projectId || task.module !== 'video' || task.taskId !== job.id
      || task.unifiedModel !== UNIFIED_KLING3_MODEL_KEY
      || task.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION || task.inputHash !== inputHash) {
      throw new UnifiedKlingExecutionError('invalid_frozen_contract', '统一可灵逻辑任务身份与冻结合同不一致。');
    }
    db.prepare('UPDATE video_jobs SET unifiedTaskId = ? WHERE id = ?').run(task.id, job.id);
    for (const definition of unifiedKlingCompatibleChannels(frozen)) {
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

type ProviderInspection =
  | { provider: ProviderRow; runtime: ReturnType<typeof resolveVideoProviderRuntimeConfig>; problem: null }
  | { provider: null; runtime: null; problem: 'missing' | 'identity_mismatch' };

function inspectExactProvider(
  db: Database.Database,
  definition: UnifiedVideoChannelDefinition,
): ProviderInspection {
  const provider = db.prepare('SELECT * FROM video_providers WHERE id = ?').get(definition.providerId) as
    | ProviderRow
    | undefined;
  if (!provider) return { provider: null, runtime: null, problem: 'missing' };
  if (provider.type !== 'openai-video' || provider.defaultModel !== definition.model) {
    return { provider: null, runtime: null, problem: 'identity_mismatch' };
  }
  return { provider, runtime: resolveVideoProviderRuntimeConfig(provider), problem: null };
}

function providerUsable(
  provider: ProviderRow,
  runtime: ReturnType<typeof resolveVideoProviderRuntimeConfig>,
): boolean {
  return provider.enabled === 1 && runtime.enabled && runtime.configured
    && Boolean(runtime.baseUrl.trim()) && Boolean(runtime.apiKey.trim());
}

export function unifiedKlingProviderAvailability(db: Database.Database): Array<{
  channelKey: string;
  providerId: string;
  model: string;
  configured: boolean;
  identityValid: boolean;
}> {
  return UNIFIED_KLING3_CHANNELS.map((definition) => {
    const inspected = inspectExactProvider(db, definition);
    return {
      channelKey: definition.channelKey,
      providerId: definition.providerId,
      model: definition.model,
      configured: Boolean(inspected.provider && inspected.runtime
        && providerUsable(inspected.provider, inspected.runtime)),
      identityValid: inspected.problem === null,
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

function channelHasSubmission(db: Database.Database, taskId: string, channelKey: string): boolean {
  const attempts = db.prepare(`
    SELECT COUNT(*) FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ? AND o.channelKey = ? AND a.intentJournalSeq IS NOT NULL
  `).pluck().get(taskId, channelKey) as number;
  if (attempts > 0) return true;
  const operation = db.prepare(`SELECT status FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(taskId, channelKey) as
    | { status: string }
    | undefined;
  return Boolean(operation && ['maybe_sent', 'accepted', 'reconciling', 'unknown', 'succeeded']
    .includes(operation.status));
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
    SELECT COUNT(DISTINCT o.channelKey)
    FROM execution_attempts a
    JOIN execution_operations o ON o.id = a.operationId
    WHERE o.mediaTaskId = ? AND o.channelKey IS NOT NULL AND a.intentJournalSeq IS NOT NULL
  `).pluck().get(taskId) as number;
}

interface ChannelSelection {
  definition: UnifiedVideoChannelDefinition;
  provider: ProviderRow;
  runtime: ReturnType<typeof resolveVideoProviderRuntimeConfig>;
  executionRevision: number;
}

interface ChannelSelectionFailure {
  reason: 'channel_limit' | 'no_available_channel' | 'channel_identity_mismatch' | 'pool_configuration_invalid';
  message: string;
}

function findNextChannel(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  task: MediaTaskRow,
  frozen: FrozenUnifiedKlingVideoRequest,
  excludeChannelKey?: string,
): ChannelSelection | ChannelSelectionFailure {
  if (submittedChannelCount(db, task.id) >= 2) {
    return {
      reason: 'channel_limit',
      message: '可灵 3.0 的两条通道都已真实提交过，不会再发起第三次生成。',
    };
  }
  for (const definition of unifiedKlingCompatibleChannels(frozen)) {
    if (definition.channelKey === excludeChannelKey) continue;
    if (channelHasSubmission(db, task.id, definition.channelKey)) continue;
    const channel = db.prepare(`SELECT state, executionRevision FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, definition.channelKey) as
      | { state: string; executionRevision: number }
      | undefined;
    if (!channel || !['candidate', 'skipped', 'overflowed'].includes(channel.state)) continue;
    const reusable = reusableChannelOperation(db, task.id, definition.channelKey);
    if (!reusable && channel.state === 'overflowed') continue;

    const inspected = inspectExactProvider(db, definition);
    if (inspected.problem === 'missing') {
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_missing');
      continue;
    }
    if (inspected.problem === 'identity_mismatch') {
      return {
        reason: 'channel_identity_mismatch',
        message: `可灵 3.0 ${definition.channelKey} 通道的供应商身份与冻结映射不一致，已拒绝提交。`,
      };
    }
    if (!inspected.provider || !inspected.runtime) continue;
    if (!providerUsable(inspected.provider, inspected.runtime)) {
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_unavailable');
      continue;
    }
    try {
      ensureMediaProviderPool(db, inspected.runtime.baseUrl, inspected.runtime.apiKey);
    } catch (error) {
      return {
        reason: 'pool_configuration_invalid',
        message: error instanceof Error
          ? error.message
          : `可灵 3.0 ${definition.channelKey} 通道资源池未通过核验。`,
      };
    }
    if (!claimUnifiedChannelHealthForSelection(db, {
      unifiedModel: task.unifiedModel,
      channelKey: definition.channelKey,
      providerId: definition.providerId,
    })) {
      continue;
    }
    return {
      definition,
      provider: inspected.provider,
      runtime: inspected.runtime,
      executionRevision: reusable?.revision ?? Math.max(1, job.executionRevision + 1),
    };
  }
  return {
    reason: 'no_available_channel',
    message: '当前没有另一条已启用、凭据可用且未提交过的可灵 3.0 通道，任务未继续提交。',
  };
}

function markSelectedChannel(
  db: Database.Database,
  taskId: string,
  definition: UnifiedVideoChannelDefinition,
  revision: number,
): void {
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
}

function chooseInitialChannel(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  task: MediaTaskRow,
  frozen: FrozenUnifiedKlingVideoRequest,
): PreparedUnifiedKlingExecution {
  let failureMessage = '当前没有已启用且凭据可用的可灵 3.0 通道，任务未提交。';
  let identityError: UnifiedKlingExecutionError | null = null;
  const selected = db.transaction((): PreparedUnifiedKlingExecution | null => {
    const selection = findNextChannel(db, job, task, frozen);
    if ('reason' in selection) {
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'failed', resultJson = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify({ errorCode: selection.reason, message: selection.message }),
          new Date().toISOString(), task.id);
      if (selection.reason === 'channel_identity_mismatch') {
        identityError = new UnifiedKlingExecutionError('channel_identity_mismatch', selection.message);
        return null;
      }
      failureMessage = selection.message;
      return null;
    }
    const changed = db.prepare(`UPDATE video_jobs SET executionRevision = ?
      WHERE id = ? AND cancelRequestedAt IS NULL AND status = 'running'`)
      .run(selection.executionRevision, job.id);
    if (changed.changes !== 1) throw new UnifiedKlingCanceledError();
    markSelectedChannel(db, task.id, selection.definition, selection.executionRevision);
    return {
      taskId: task.id,
      channel: {
        channelKey: selection.definition.channelKey,
        executionRevision: selection.executionRevision,
        definition: selection.definition,
        provider: selection.provider,
        runtimeBaseUrl: selection.runtime.baseUrl,
        runtimeApiKey: selection.runtime.apiKey,
      },
    };
  }).immediate();
  if (selected) return selected;
  if (identityError) throw identityError;
  throw new UnifiedKlingExecutionError('no_available_channel', failureMessage);
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

function hasAcceptedEvidence(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  channel: MediaChannelRow,
): boolean {
  if (job.providerTaskId?.trim() || job.remoteVideoUrl?.trim() || channel.remoteId?.trim()) return true;
  const operation = db.prepare(`SELECT status FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(channel.mediaTaskId, channel.channelKey) as
    | { status: string }
    | undefined;
  return Boolean(operation && ['maybe_sent', 'accepted', 'reconciling', 'unknown', 'succeeded']
    .includes(operation.status));
}

function persistedExplicitFailureInput(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  task: MediaTaskRow,
  channel: MediaChannelRow,
): { evidence: SubmissionEvidence; attemptId: string; operationId: string; channelKey: string } | null {
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
  `).get(task.id, channel.channelKey) as {
    attemptId: string;
    operationId: string;
    businessAttemptNo: number;
    remoteId: string | null;
    terminalState: 'not_created' | 'failed';
    errorCode: string | null;
    providerSnapshotJson: string;
    operationProviderSnapshotJson: string;
  } | undefined;
  if (!row) return null;
  const provider = safeJsonObject(row.providerSnapshotJson)
    ?? safeJsonObject(row.operationProviderSnapshotJson);
  return {
    evidence: classifySubmissionOutcome({
      entry: 'video',
      taskId: job.id,
      businessAttemptNo: row.businessAttemptNo,
      adapterId: typeof provider?.type === 'string' ? provider.type : 'unified-kling',
      stage: 'submit',
      source: 'persisted',
      outcome: row.terminalState === 'not_created' ? 'confirmed_not_created' : 'terminal_failed',
      remoteId: row.remoteId,
      errorCode: row.errorCode ?? undefined,
    }),
    attemptId: row.attemptId,
    operationId: row.operationId,
    channelKey: channel.channelKey,
  };
}

function readCurrentChannel(
  db: Database.Database,
  task: MediaTaskRow,
): {
  channel: MediaChannelRow;
  definition: UnifiedVideoChannelDefinition;
  provider: ProviderRow;
  runtime: ReturnType<typeof resolveVideoProviderRuntimeConfig>;
} | null {
  if (!task.currentChannelKey) return null;
  const channel = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
    | MediaChannelRow
    | undefined;
  if (!channel) return null;
  const definition = UNIFIED_KLING3_CHANNELS.find((item) => item.channelKey === channel.channelKey);
  if (!definition || definition.providerId !== channel.providerId
    || definition.model !== channel.providerModel || channel.providerTable !== definition.providerTable) {
    throw new UnifiedKlingExecutionError('channel_identity_mismatch', '统一可灵通道快照与精确目录不一致。');
  }
  const inspected = inspectExactProvider(db, definition);
  if (inspected.problem === 'identity_mismatch') {
    throw new UnifiedKlingExecutionError('channel_identity_mismatch', '统一可灵通道供应商身份已漂移。');
  }
  if (!inspected.provider || !inspected.runtime) {
    throw new Error('可灵 3.0 原通道供应商行不存在，已停止续查。');
  }
  return {
    channel,
    definition,
    provider: inspected.provider,
    runtime: inspected.runtime,
  };
}

function cancelUnsubmittedTask(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  task: MediaTaskRow,
  current: ReturnType<typeof readCurrentChannel>,
): never {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE video_jobs SET status = 'canceled', errorMessage = 'Canceled by user',
      cancelRequestedAt = COALESCE(cancelRequestedAt, ?), finishedAt = COALESCE(finishedAt, ?)
      WHERE id = ? AND status IN ('pending', 'running', 'deferred')`).run(at, at, job.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'canceled', cancelRequestedAt = COALESCE(cancelRequestedAt, ?), updatedAt = ?
      WHERE id = ?`).run(at, at, task.id);
    if (current) {
      db.prepare(`UPDATE execution_media_channels SET state = 'canceled', updatedAt = ? WHERE id = ?`)
        .run(at, current.channel.id);
      db.prepare(`UPDATE execution_operations
        SET status = 'failed', waitReason = 'stage_canceled', waitDetail = NULL, updatedAt = ?
        WHERE mediaTaskId = ? AND channelKey = ? AND status IN ('pending', 'deferred')`)
        .run(at, task.id, current.channel.channelKey);
    }
  }).immediate();
  throw new UnifiedKlingCanceledError();
}

export function prepareUnifiedKlingExecution(
  db: Database.Database,
  jobId: string,
  now = new Date(),
): PreparedUnifiedKlingExecution {
  const job = readJob(db, jobId);
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
        const decision = handleUnifiedKlingExplicitFailure(db, jobId, persistedFailure);
        if (decision.outcome === 'next_channel') throw new UnifiedKlingRecoveryPendingError();
        if (decision.outcome === 'canceled') throw new UnifiedKlingCanceledError();
        throw new UnifiedKlingExecutionError(
          'channel_exhausted',
          decision.outcome === 'exhausted'
            ? '可灵 3.0 已记录明确失败，且没有剩余可提交通道。'
            : '可灵 3.0 当前通道已终止，不会再次提交。',
        );
      }
    }
    if (current.channel.state === 'waiting_capacity') {
      const nextEligibleAt = current.channel.nextEligibleAt
        ?? task.nextEligibleAt;
      if (nextEligibleAt && Number.isFinite(Date.parse(nextEligibleAt))
        && now.getTime() < Date.parse(nextEligibleAt)) {
        throw new UnifiedKlingWaitingError({
          nextEligibleAt,
          waitReason: task.waitReason ?? 'pool_capacity',
          waitDetail: safeJsonObject(task.waitDetailJson),
        });
      }
    }
    if (['failed', 'not_created', 'canceled'].includes(current.channel.state)) {
      throw new UnifiedKlingExecutionError(
        'channel_exhausted',
        current.channel.state === 'canceled'
          ? '任务已取消，未选择新通道。'
          : '可灵 3.0 当前通道已终止，未自动选择新通道。',
      );
    }
    return {
      taskId: task.id,
      channel: {
        channelKey: current.channel.channelKey,
        executionRevision: current.channel.executionRevision,
        definition: current.definition,
        provider: current.provider,
        runtimeBaseUrl: current.runtime.baseUrl,
        runtimeApiKey: current.runtime.apiKey,
      },
    };
  }
  if (canceled) cancelUnsubmittedTask(db, job, task, null);
  return chooseInitialChannel(db, job, task, frozen);
}

export function requestUnifiedKlingCancellation(db: Database.Database, jobId: string): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE video_jobs SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?) WHERE id = ?')
      .run(at, jobId);
    db.prepare(`UPDATE execution_media_tasks
      SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?), updatedAt = ?
      WHERE taskId = ? AND module = 'video'`).run(at, at, jobId);
  }).immediate();
}

function clearVideoForNextChannel(
  db: Database.Database,
  job: UnifiedVideoJobRow,
  revision: number,
): boolean {
  const changed = db.prepare(`UPDATE video_jobs SET
      status = 'pending', executionRevision = ?, errorMessage = NULL, finishedAt = NULL,
      providerTaskId = NULL, providerStatus = NULL, providerRawResponse = NULL,
      remoteVideoUrl = NULL, lastPolledAt = NULL, pollCount = 0,
      startedAt = NULL, localVideoPath = NULL, filename = NULL, usageSnapshotJson = NULL
    WHERE id = ? AND cancelRequestedAt IS NULL
      AND status IN ('pending', 'running', 'failed', 'needs_check', 'deferred')`)
    .run(revision, job.id);
  return changed.changes === 1;
}

export function handleUnifiedKlingExplicitFailure(
  db: Database.Database,
  jobId: string,
  input: {
    evidence: SubmissionEvidence;
    attemptId?: string;
    operationId?: string;
    channelKey?: string | null;
  },
): UnifiedKlingFailureDecision {
  const evidence = input.evidence;
  if (evidence.identity.entry !== 'video'
    || evidence.identity.taskId !== jobId
    || !['submit', 'poll'].includes(evidence.identity.stage)
    || !['confirmed_not_created', 'terminal_failed'].includes(evidence.state)) {
    throw new UnifiedKlingExecutionError(
      'invalid_failure_evidence',
      '统一可灵任务只接受明确未创建或远端明确失败证据。',
    );
  }
  const kind = evidence.state === 'confirmed_not_created' ? 'not_created' : 'failed';
  return db.transaction((): UnifiedKlingFailureDecision => {
    const job = readJob(db, jobId);
    if (!job.unifiedTaskId || job.status === 'succeeded') {
      return {
        outcome: 'ignored', previousChannelKey: null,
        submissionCount: 0, usedChannelCount: 0,
      };
    }
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
      | MediaTaskRow
      | undefined;
    if (!task?.currentChannelKey) {
      return {
        outcome: 'ignored', previousChannelKey: null,
        submissionCount: submittedChannelCount(db, task?.id ?? ''),
        usedChannelCount: submittedChannelCount(db, task?.id ?? ''),
      };
    }
    const channel = db.prepare(`SELECT * FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
      | MediaChannelRow
      | undefined;
    if (!channel) {
      return {
        outcome: 'ignored', previousChannelKey: null,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    const operation = (input.operationId
      ? db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(input.operationId)
      : db.prepare(`SELECT * FROM execution_operations
          WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, channel.channelKey)) as
      | (ChannelOperationRow & { mediaTaskId: string | null; channelKey: string | null })
      | undefined;
    if ((input.channelKey && input.channelKey !== channel.channelKey)
      || (operation?.channelKey && operation.channelKey !== channel.channelKey)
      || !operation || operation.mediaTaskId !== task.id) {
      throw new UnifiedKlingExecutionError(
        'invalid_failure_evidence',
        '显式失败证据没有关联到当前通道的真实执行操作。',
      );
    }
    const attempt = (input.attemptId
      ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(input.attemptId)
      : operation.currentAttemptId
        ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(operation.currentAttemptId)
        : undefined) as {
          id: string;
          operationId: string;
          remoteId: string | null;
          submissionState: string;
          terminalState: string | null;
          reservedMinor: number;
          actualMinor: number | null;
          costState: string;
          errorCode: string | null;
        } | undefined;
    const expectedTerminal = kind === 'not_created' ? 'not_created' : 'failed';
    if (!attempt || attempt.operationId !== operation.id || attempt.terminalState !== expectedTerminal) {
      throw new UnifiedKlingExecutionError(
        'invalid_failure_evidence',
        '显式失败证据对应的执行尝试尚未完成同终态结算。',
      );
    }
    if (['failed', 'not_created', 'succeeded', 'canceled'].includes(channel.state)) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    const at = new Date().toISOString();
    const remoteId = channel.remoteId?.trim()
      || attempt.remoteId?.trim()
      || evidence.remoteId?.trim()
      || job.providerTaskId?.trim()
      || null;
    const channelEvidence = {
      kind,
      at,
      attemptId: attempt.id,
      operationId: operation.id,
      remoteId,
      submissionState: attempt.submissionState,
      terminalState: attempt.terminalState,
      costState: attempt.costState,
      reservedMinor: attempt.reservedMinor,
      actualMinor: attempt.actualMinor,
      errorCode: attempt.errorCode ?? evidence.error?.code ?? null,
      submissionEvidence: evidence,
    };
    db.prepare(`UPDATE execution_media_channels
      SET state = ?, operationId = COALESCE(?, operationId), remoteId = COALESCE(remoteId, ?, ?),
        evidenceJson = ?, updatedAt = ? WHERE id = ?`)
      .run(kind, operation.id, remoteId, evidence.remoteId, JSON.stringify(channelEvidence), at, channel.id);
    db.prepare(`UPDATE execution_operations
      SET status = 'failed', waitReason = NULL, waitDetail = NULL, updatedAt = ? WHERE id = ?`)
      .run(at, operation.id);

    if (job.cancelRequestedAt || task.cancelRequestedAt) {
      db.prepare(`UPDATE video_jobs SET status = 'canceled', errorMessage = 'Canceled by user',
        cancelRequestedAt = COALESCE(cancelRequestedAt, ?), finishedAt = COALESCE(finishedAt, ?),
        providerTaskId = NULL, providerStatus = NULL, remoteVideoUrl = NULL
        WHERE id = ? AND status IN ('pending', 'running', 'failed', 'needs_check', 'deferred')`)
        .run(at, at, job.id);
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
        now: new Date(at),
      });
    }
    const frozen = readFrozenRequest(job);
    const selection = findNextChannel(db, job, task, frozen, channel.channelKey);
    if ('reason' in selection) {
      const message = selection.reason === 'channel_limit'
        ? '可灵 3.0 的两条可用通道均已明确失败，任务已停止，不会发起第三次生成。'
        : selection.message;
      db.prepare(`UPDATE video_jobs SET status = 'failed', finishedAt = ?, errorMessage = ?
        WHERE id = ? AND status IN ('pending', 'running', 'failed', 'needs_check', 'deferred')`)
        .run(at, message, job.id);
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

    if (!clearVideoForNextChannel(db, job, selection.executionRevision)) {
      return {
        outcome: 'ignored', previousChannelKey: channel.channelKey,
        submissionCount: submittedChannelCount(db, task.id),
        usedChannelCount: submittedChannelCount(db, task.id),
      };
    }
    markSelectedChannel(db, task.id, selection.definition, selection.executionRevision);
    return {
      outcome: 'next_channel',
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
      nextExecutionRevision: selection.executionRevision,
      submissionCount: submittedChannelCount(db, task.id),
      usedChannelCount: submittedChannelCount(db, task.id),
    };
  }).immediate();
}

export function handleUnifiedKlingCapacityDeferral(
  db: Database.Database,
  jobId: string,
  reasons: readonly string[],
  now = new Date(),
): UnifiedKlingCapacityDecision {
  return db.transaction((): UnifiedKlingCapacityDecision => {
    const job = readJob(db, jobId);
    if (!job.unifiedTaskId) return { outcome: 'ignored', reason: 'task_not_ready' };
    const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
      | MediaTaskRow
      | undefined;
    if (!task?.currentChannelKey) return { outcome: 'ignored', reason: 'channel_not_ready' };
    const channel = db.prepare(`SELECT * FROM execution_media_channels
      WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
      | MediaChannelRow
      | undefined;
    if (!channel) return { outcome: 'ignored', reason: 'channel_not_found' };
    if (job.cancelRequestedAt || task.cancelRequestedAt) return { outcome: 'canceled', reason: 'canceled' };
    if (!reasons.includes('pool_capacity')) return { outcome: 'not_capacity', reason: reasons[0] ?? 'deferred' };
      const operation = db.prepare(`
        SELECT id FROM execution_operations WHERE mediaTaskId = ? AND channelKey = ?
      `).get(task.id, channel.channelKey) as { id: string } | undefined;
      if (!operation) return { outcome: 'not_capacity', reason: 'operation_missing' };
      const capacityOnly = unifiedCapacityOnlyOperation(db, operation.id, now);
      if (!capacityOnly.ok) {
        const detail = {
          ...(capacityOnly.detail ?? {}),
          reason: capacityOnly.reason,
          capacityBlockedReason: 'pool_capacity',
          channelKey: channel.channelKey,
        };
        const at = now.toISOString();
        db.prepare(`UPDATE execution_operations
          SET waitReason = ?, waitDetail = ?, updatedAt = ? WHERE id = ?`)
          .run(capacityOnly.reason, JSON.stringify(detail), at, operation.id);
        db.prepare(`UPDATE execution_media_tasks
          SET status = 'waiting', waitReason = ?, waitDetailJson = ?, updatedAt = ?
          WHERE id = ?`).run(capacityOnly.reason, JSON.stringify(detail), at, task.id);
        db.prepare(`UPDATE execution_media_channels
          SET state = 'selected', evidenceJson = ?, updatedAt = ? WHERE id = ?`)
          .run(JSON.stringify(detail), at, channel.id);
        return { outcome: 'not_capacity', reason: capacityOnly.reason };
      }

    const persistWaiting = (): UnifiedKlingCapacityDecision => {
      const nextEligibleAt = new Date(now.getTime() + 1_000).toISOString();
      const detail = {
        reason: 'pool_capacity',
        channelKey: channel.channelKey,
        waitingSinceAt: now.toISOString(),
        nextEligibleAt,
      };
      const at = now.toISOString();
      db.prepare(`UPDATE execution_media_channels
        SET state = 'waiting_capacity', nextEligibleAt = ?, evidenceJson = ?, updatedAt = ?
        WHERE id = ?`).run(nextEligibleAt, JSON.stringify(detail), at, channel.id);
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'waiting', waitReason = 'pool_capacity', waitDetailJson = ?,
          nextEligibleAt = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify(detail), nextEligibleAt, at, task.id);
      db.prepare(`UPDATE video_jobs
        SET status = 'deferred', errorMessage = '等待可用资源（供应商名额已满，释放后自动继续）',
          startedAt = NULL, finishedAt = NULL
        WHERE id = ? AND status IN ('pending', 'running', 'retrying', 'deferred')`).run(job.id);
      return { outcome: 'waiting', channelKey: channel.channelKey, nextEligibleAt };
    };

    if (channel.channelKey !== 'qiniu') return persistWaiting();
    const frozen = readFrozenRequest(job);
    const selection = findNextChannel(db, job, task, frozen, channel.channelKey);
    if ('reason' in selection) return persistWaiting();

    const at = now.toISOString();
    db.prepare(`UPDATE execution_media_channels
      SET state = 'overflowed', nextEligibleAt = NULL, evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify({
        reason: 'pool_capacity',
        overflowedAt: at,
        previousChannelKey: channel.channelKey,
        nextChannelKey: selection.definition.channelKey,
      }), at, channel.id);
    if (!clearVideoForNextChannel(db, job, selection.executionRevision)) {
      return { outcome: 'ignored', reason: 'job_changed' };
    }
    markSelectedChannel(db, task.id, selection.definition, selection.executionRevision);
    return {
      outcome: 'overflowed',
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
      nextExecutionRevision: selection.executionRevision,
    };
  }).immediate();
}

export function assertUnifiedKlingSubmissionStillCurrent(
  db: Database.Database,
  input: {
    jobId: string;
    mediaTaskId: string;
    channelKey: string;
    executionRevision: number;
  },
): void {
  const job = db.prepare(`SELECT status, unifiedTaskId, executionRevision, cancelRequestedAt
    FROM video_jobs WHERE id = ?`).get(input.jobId) as {
      status: string;
      unifiedTaskId: string | null;
      executionRevision: number;
      cancelRequestedAt: string | null;
    } | undefined;
  if (!job || job.unifiedTaskId !== input.mediaTaskId) throw new UnifiedKlingStaleSubmissionError();
  if (job.cancelRequestedAt) throw new UnifiedKlingCanceledError();
  const task = db.prepare(`SELECT status, currentChannelKey, cancelRequestedAt
    FROM execution_media_tasks WHERE id = ?`).get(input.mediaTaskId) as {
      status: string;
      currentChannelKey: string | null;
      cancelRequestedAt: string | null;
    } | undefined;
  if (!task || task.cancelRequestedAt) {
    if (task?.cancelRequestedAt) throw new UnifiedKlingCanceledError();
    throw new UnifiedKlingStaleSubmissionError();
  }
  const channel = db.prepare(`SELECT state, executionRevision, providerId
    FROM execution_media_channels WHERE mediaTaskId = ? AND channelKey = ?`)
    .get(input.mediaTaskId, input.channelKey) as
    | { state: string; executionRevision: number; providerId: string }
    | undefined;
  if (job.status !== 'running'
    || job.executionRevision !== input.executionRevision
    || task.currentChannelKey !== input.channelKey
    || !channel
    || channel.executionRevision !== input.executionRevision
    || !['selected', 'waiting_capacity'].includes(channel.state)) {
    throw new UnifiedKlingStaleSubmissionError();
  }
  const definition = UNIFIED_KLING3_CHANNELS.find((item) => item.channelKey === input.channelKey);
  if (!definition) throw new UnifiedKlingStaleSubmissionError();
  const inspected = inspectExactProvider(db, definition);
  if (inspected.problem || !inspected.provider || !inspected.runtime
    || !providerUsable(inspected.provider, inspected.runtime)) {
    throw new UnifiedKlingStaleSubmissionError();
  }
}

export function synchronizeUnifiedKlingExecution(db: Database.Database, jobId: string): void {
  const job = db.prepare('SELECT * FROM video_jobs WHERE id = ?').get(jobId) as
    | UnifiedVideoJobRow
    | undefined;
  if (!job?.unifiedModel || !job.unifiedTaskId) return;
  const task = db.prepare('SELECT * FROM execution_media_tasks WHERE id = ?').get(job.unifiedTaskId) as
    | MediaTaskRow
    | undefined;
  if (!task?.currentChannelKey) return;
  const channel = db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, task.currentChannelKey) as
    | MediaChannelRow
    | undefined;
  if (!channel) return;
  if (job.status === 'deferred' && channel.state === 'waiting_capacity') return;
  if (['failed', 'not_created'].includes(channel.state)
    && ['failed', 'canceled'].includes(job.status)) return;
  const operation = db.prepare(`SELECT * FROM execution_operations
    WHERE mediaTaskId = ? AND channelKey = ?`).get(task.id, channel.channelKey) as
    | ChannelOperationRow
    | undefined;
  const attempt = operation?.currentAttemptId
    ? db.prepare('SELECT remoteId, submissionState, terminalState FROM execution_attempts WHERE id = ?')
      .get(operation.currentAttemptId) as {
        remoteId: string | null;
        submissionState: string;
        terminalState: string | null;
      } | undefined
    : undefined;
  const remoteId = job.providerTaskId?.trim() || channel.remoteId?.trim() || attempt?.remoteId?.trim() || null;
  const downloadRecovery = job.providerStatus === 'download_failed' && Boolean(job.remoteVideoUrl);
  const lateSucceeded = job.status === 'canceled'
    && job.providerStatus === 'succeeded'
    && Boolean(job.localVideoPath || job.filename);
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
      localVideoPath: job.localVideoPath,
      filename: job.filename,
      lateResult: true,
    }
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
        taskStatus,
        channel.channelKey,
        job.status === 'deferred' ? operation?.waitReason ?? 'waiting' : null,
        job.status === 'deferred'
          ? JSON.stringify(safeJsonObject(operation?.waitDetail ?? null) ?? {
            reason: operation?.waitReason ?? 'waiting',
          })
          : null,
        result === null ? null : JSON.stringify(result),
        at,
        task.id,
      );
  }).immediate();
}
