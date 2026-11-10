import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isPlaceholderValue } from '../../video-auth.ts';
import { requireAccessContext } from '../access-context.ts';
import { ensureMediaProviderPool } from '../execution/media-provider-pool.ts';
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
}

interface ChannelOperationRow {
  id: string;
  status: string;
  waitReason: string | null;
  currentAttemptId: string | null;
  updatedAt: string;
}

export class UnifiedImageExecutionError extends Error {
  readonly code: 'no_available_channel' | 'channel_identity_mismatch' | 'invalid_frozen_contract' | 'channel_exhausted';

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

export interface PreparedUnifiedImageExecution {
  taskId: string;
  channel: {
    channelKey: string;
    executionRevision: number;
    definition: UnifiedImageChannelDefinition;
    provider: ProviderRow;
  };
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
    WHERE mediaTaskId = ? AND channelKey = ? AND state = 'candidate'`)
    .run(JSON.stringify({ reason }), new Date().toISOString(), taskId, channelKey);
}

function chooseInitialChannel(
  db: Database.Database,
  job: UnifiedJobRow,
  task: MediaTaskRow,
  frozen: FrozenUnifiedImageRequest,
): PreparedUnifiedImageExecution {
  const candidates = unifiedImageCompatibleChannels(frozen.tier, frozen.ratio);
  for (const definition of candidates) {
    const inspected = inspectExactProvider(db, definition);
    if (inspected.problem === 'missing') {
      // Missing canonical rows are skips. A tencent-only request must still run
      // when qiniu was never configured.
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_missing');
      continue;
    }
    if (inspected.problem === 'identity_mismatch') {
      // A present canonical ID with a different exact model/type is config
      // drift. Fail the whole unified request rather than silently switching.
      throw new UnifiedImageExecutionError(
        'channel_identity_mismatch',
        `Image 2 ${definition.channelKey} 通道的供应商身份与冻结映射不一致，已拒绝提交。`,
      );
    }
    if (!inspected.provider) continue;
    const provider = inspected.provider;
    if (!providerUsable(provider)) {
      setChannelSkipped(db, task.id, definition.channelKey, 'provider_unavailable');
      continue;
    }
    ensureMediaProviderPool(db, provider.baseUrl, provider.apiKey);
    const revision = Math.max(1, job.executionRevision + 1);
    const at = new Date().toISOString();
    const selected = db.transaction(() => {
      const changed = db.prepare(`UPDATE jobs SET executionRevision = ?
        WHERE id = ? AND cancelRequestedAt IS NULL AND status = 'running'`).run(revision, job.id);
      if (changed.changes !== 1) return false;
      db.prepare(`UPDATE execution_media_channels
        SET state = 'selected', executionRevision = ?, evidenceJson = NULL, updatedAt = ?
        WHERE mediaTaskId = ? AND channelKey = ?`)
        .run(revision, at, task.id, definition.channelKey);
      db.prepare(`UPDATE execution_media_tasks
        SET currentChannelKey = ?, status = 'routing', waitReason = NULL, waitDetailJson = NULL, updatedAt = ?
        WHERE id = ?`).run(definition.channelKey, at, task.id);
      return true;
    }).immediate();
    if (!selected) throw new UnifiedImageCanceledError();
    return {
      taskId: task.id,
      channel: { channelKey: definition.channelKey, executionRevision: revision, definition, provider },
    };
  }
  db.prepare(`UPDATE execution_media_tasks SET status = 'failed', resultJson = ?, updatedAt = ? WHERE id = ?`)
    .run(JSON.stringify({ errorCode: 'no_available_channel' }), new Date().toISOString(), task.id);
  throw new UnifiedImageExecutionError(
    'no_available_channel',
    '当前没有已启用且凭据可用的 Image 2 通道，任务未提交。',
  );
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
  const operation = db.prepare(`SELECT id, status, waitReason, currentAttemptId, updatedAt
    FROM execution_operations WHERE mediaTaskId = ? AND channelKey = ?`)
    .get(task.id, channel.channelKey) as ChannelOperationRow | undefined;
  const attempt = operation?.currentAttemptId
    ? db.prepare('SELECT remoteId, submissionState, terminalState FROM execution_attempts WHERE id = ?')
      .get(operation.currentAttemptId) as {
        remoteId: string | null; submissionState: string; terminalState: string | null;
      } | undefined
    : undefined;
  const remoteId = job.providerTaskId?.trim() || channel.remoteId?.trim() || attempt?.remoteId?.trim() || null;
  const channelState = job.status === 'succeeded' ? 'succeeded'
    : job.status === 'failed' ? 'failed'
      : job.status === 'canceled' ? 'canceled'
        : job.status === 'deferred' ? (operation?.waitReason === 'pool_capacity' ? 'waiting_capacity' : 'selected')
          : job.status === 'needs_check'
            ? (job.providerStatus === 'unknown' ? 'unknown' : 'accepted')
            : 'selected';
  const taskStatus = channelState === 'succeeded' ? 'succeeded'
    : channelState === 'failed' ? 'failed'
      : channelState === 'canceled' ? 'canceled'
        : channelState === 'waiting_capacity' ? 'waiting'
          : channelState === 'unknown' ? 'unknown'
            : channelState === 'accepted' ? 'accepted'
              : 'routing';
  const at = new Date().toISOString();
  const evidence = {
    jobStatus: job.status,
    providerStatus: job.providerStatus,
    operationStatus: operation?.status ?? null,
    attemptSubmissionState: attempt?.submissionState ?? null,
    attemptTerminalState: attempt?.terminalState ?? null,
    errorMessage: job.errorMessage,
  };
  const result = job.status === 'succeeded'
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
        job.status === 'deferred' ? JSON.stringify({ reason: operation?.waitReason ?? 'waiting' }) : null,
        result === null ? null : JSON.stringify(result), at, task.id,
      );
  }).immediate();
}
