import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  resolveVideoProviderRuntimeConfig,
  type VideoProviderEnvConfig,
} from '../video-auth.ts';
import { requireAccessContext } from '../media-core/access-context.ts';
import { ensureMediaProviderPool } from '../media-core/execution/media-provider-pool.ts';
import {
  classifySubmissionOutcome,
  type SubmissionEvidence,
} from '../media-core/submission-evidence.ts';
import {
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  type UnifiedVideoChannelDefinition,
} from '../media-core/unified-media/catalog.ts';
import {
  freezeUnifiedKlingVideoRequest,
  unifiedKlingCompatibleChannels,
  UnifiedKlingRequestError,
  type FrozenUnifiedKlingVideoRequest,
} from '../media-core/unified-media/video-requests.ts';
import {
  claimUnifiedChannelHealthForSelection,
  recordUnifiedChannelFailure,
  recordUnifiedChannelSuccess,
  releaseUnifiedChannelRecoveryProbe,
  unifiedChannelFailureReasonFromEvidence,
} from '../media-core/unified-media/health.ts';
import {
  companyVideoCapsForModel,
  snapCompanyVideoAspectRatio,
} from '../company-gateway-size.ts';
import { registerCanvasCapability, type CanvasModelCapability } from './capabilities.ts';
import {
  COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY,
} from './adapters/company-capabilities.ts';
import type { CanvasTaskContext } from './adapters/types.ts';
import type { CanvasTaskRecord } from './tasks.ts';
import {
  CanvasUnifiedCanceledError,
  CanvasUnifiedRequeueError,
  CanvasUnifiedStaleError,
  CanvasUnifiedTerminalError,
  CanvasUnifiedWaitingError,
  type CanvasUnifiedCapacityDecision,
} from './unified-image.ts';

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
  resultJson: string | null;
  reconcileVersion: number;
  createdAt: string;
  updatedAt: string;
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

interface OperationRow {
  id: string;
  operationKey: string;
  inputRevision: string;
  status: string;
  waitReason: string | null;
  waitDetail: string | null;
  currentAttemptId: string | null;
  resultJson: string | null;
  updatedAt: string;
}

interface AttemptRow {
  id: string;
  operationId: string;
  businessAttemptNo: number;
  providerSnapshotJson: string;
  submissionState: string;
  terminalState: 'succeeded' | 'failed' | 'not_created' | null;
  remoteId: string | null;
  errorCode: string | null;
  intentJournalSeq: number | null;
}

type ProviderRow = VideoProviderEnvConfig & {
  id: string;
  name: string;
  type: string;
  defaultModel: string;
  enabled: number;
  baseUrl: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
};

type ProviderRuntime = ReturnType<typeof resolveVideoProviderRuntimeConfig>;

export interface CanvasUnifiedKlingContract {
  schemaVersion: 1;
  kind: 'canvas-unified-kling';
  unifiedModel: typeof UNIFIED_KLING3_MODEL_KEY;
  unifiedRuleVersion: typeof UNIFIED_MEDIA_RULE_VERSION;
  canvasId: string;
  taskId: string;
  nodeId: string;
  nodeEpoch: number;
  variantIndex: number;
  mediaKind: 'video';
  generationMode: 'image-to-video';
  prompt: string;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  multiShot: boolean;
  sourceImageId: string;
  tailImageId: string | null;
  inputs: Array<{
    refId: string;
    orderIndex: number;
    role: string;
    kind: 'image' | 'text';
    assetId: string | null;
    upstreamTaskId: string | null;
    textContent: string | null;
  }>;
}

export interface CanvasUnifiedKlingExecution {
  mediaKind: 'video';
  parent: MediaTaskRow;
  channel: MediaChannelRow;
  definition: UnifiedVideoChannelDefinition;
  provider: ProviderRow;
  capability: CanvasModelCapability;
  providerSnapshotJson: string;
  effectiveTask: CanvasTaskRecord;
  effectiveContext: CanvasTaskContext;
}

export type CanvasUnifiedKlingFailureDecision =
  | {
    outcome: 'next_channel';
    previousChannelKey: string;
    nextChannelKey: string;
  }
  | {
    outcome: 'exhausted' | 'canceled' | 'ignored';
    reason?: string;
  };

type ChannelSelection = {
  definition: UnifiedVideoChannelDefinition;
  provider: ProviderRow;
  runtime: ProviderRuntime;
  executionRevision: number;
};

type ChannelSelectionFailure = {
  reason: string;
  message: string;
};

function parseObject<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
  } catch {
    return fallback;
  }
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

function taskKey(taskId: string): string {
  return `canvas:${taskId}`;
}

export function isCanvasUnifiedKlingTask(task: CanvasTaskRecord): boolean {
  const snapshot = parseObject<Record<string, unknown>>(task.providerSnapshot, {});
  return task.mediaKind === 'video'
    && snapshot.unifiedModel === UNIFIED_KLING3_MODEL_KEY
    && snapshot.unifiedRuleVersion === UNIFIED_MEDIA_RULE_VERSION;
}

function readParent(db: Database.Database, taskId: string): MediaTaskRow | null {
  return (db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?').get(taskKey(taskId)) as
    | MediaTaskRow
    | undefined) ?? null;
}

function readChannel(db: Database.Database, parentId: string, channelKey: string): MediaChannelRow | null {
  return (db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(parentId, channelKey) as
    | MediaChannelRow
    | undefined) ?? null;
}

function currentChannel(db: Database.Database, parent: MediaTaskRow): MediaChannelRow | null {
  return parent.currentChannelKey ? readChannel(db, parent.id, parent.currentChannelKey) : null;
}

function operationForChannel(
  db: Database.Database,
  parentId: string,
  channelKey: string,
): OperationRow | null {
  return (db.prepare(`SELECT id, operationKey, inputRevision, status, waitReason, waitDetail,
      currentAttemptId, resultJson, updatedAt
    FROM execution_operations WHERE mediaTaskId = ? AND channelKey = ?`).get(parentId, channelKey) as
    | OperationRow
    | undefined) ?? null;
}

function latestTerminalAttempt(db: Database.Database, operationId: string): AttemptRow | null {
  return (db.prepare(`SELECT id, operationId, businessAttemptNo, providerSnapshotJson,
      submissionState, terminalState, remoteId, errorCode, intentJournalSeq
    FROM execution_attempts WHERE operationId = ?
    ORDER BY createdAt DESC, transportSeq DESC, id DESC LIMIT 1`).get(operationId) as
    | AttemptRow
    | undefined) ?? null;
}

function imageAssetDimensions(
  db: Database.Database,
  canvasId: string,
  assetId: string,
): { width: number; height: number } | null {
  const row = db.prepare(`SELECT width, height FROM creative_canvas_assets
    WHERE id = ? AND canvasId = ? AND mediaKind = 'image'`).get(assetId, canvasId) as
    | { width: number | null; height: number | null }
    | undefined;
  return row?.width && row.height ? { width: Number(row.width), height: Number(row.height) } : null;
}

function freezeContract(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
): CanvasUnifiedKlingContract {
  if (task.mediaKind !== 'video') {
    throw new CanvasUnifiedTerminalError('invalid_contract', '统一可灵 3.0 只能用于画布视频节点。');
  }
  if (context.generationMode !== 'image-to-video') {
    throw new CanvasUnifiedTerminalError(
      'unsupported_kling_mode',
      '当前画布可灵 3.0 只开放图生视频（首帧＋可选尾帧），任务未提交。',
    );
  }
  const imageInputs = context.inputs.filter((input) => input.kind === 'image');
  const unsupported = context.inputs.find((input) => input.kind !== 'image' && input.kind !== 'text');
  if (unsupported) {
    throw new CanvasUnifiedTerminalError(
      'invalid_input',
      '可灵 3.0 不接受视频或音频输入；请使用首帧/尾帧图片或选择其他模型。',
    );
  }
  const source = imageInputs.find((input) => input.role === 'first-frame');
  const tail = imageInputs.find((input) => input.role === 'last-frame') ?? null;
  if (!source?.assetId) {
    throw new CanvasUnifiedTerminalError('invalid_input', '可灵 3.0 图生视频需要一张固定首帧图片。');
  }
  if (imageInputs.length > 2) {
    throw new CanvasUnifiedTerminalError('invalid_input', '可灵 3.0 最多接受首帧和尾帧两张图片。');
  }
  const dimensions = imageAssetDimensions(db, task.canvasId, source.assetId);
  if (!dimensions) {
    throw new CanvasUnifiedTerminalError('invalid_input', '无法读取可灵 3.0 首帧尺寸，任务未提交。');
  }
  const durationSec = Number(context.parameters.durationSec ?? 5);
  const aspectRatio = String(context.parameters.aspectRatio ?? '');
  const resolution = String(context.parameters.resolution ?? '').toUpperCase();
  const multiShot = context.parameters.multiShot === true;
  const caps = companyVideoCapsForModel(UNIFIED_KLING3_MODEL_KEY)!;
  const sourceRatio = snapCompanyVideoAspectRatio(dimensions.width, dimensions.height, caps);
  if (!aspectRatio || !sourceRatio || aspectRatio !== sourceRatio) {
    throw new CanvasUnifiedTerminalError(
      'output_ratio_mismatch',
      `输出比例 ${aspectRatio || '未设置'} 与首帧比例 ${sourceRatio ?? '无法识别'} 不一致，任务未提交。`,
    );
  }
  let frozen: FrozenUnifiedKlingVideoRequest;
  try {
    frozen = freezeUnifiedKlingVideoRequest({
      sourceImageId: source.assetId,
      tailImageId: tail?.assetId ?? null,
      referenceAssetIds: [],
      prompt: context.prompt,
      durationSec,
      generationMode: context.generationMode,
      multiShot,
      aspectRatio,
      resolution,
    });
  } catch (error) {
    if (error instanceof UnifiedKlingRequestError) {
      throw new CanvasUnifiedTerminalError(error.code, error.message);
    }
    throw error;
  }
  return {
    schemaVersion: 1,
    kind: 'canvas-unified-kling',
    unifiedModel: UNIFIED_KLING3_MODEL_KEY,
    unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
    canvasId: task.canvasId,
    taskId: task.id,
    nodeId: task.nodeId,
    nodeEpoch: task.nodeEpoch,
    variantIndex: task.variantIndex,
    mediaKind: 'video',
    generationMode: 'image-to-video',
    prompt: frozen.prompt,
    durationSec: frozen.durationSec,
    aspectRatio: frozen.aspectRatio!,
    resolution: frozen.resolution!,
    multiShot: frozen.multiShot === true,
    sourceImageId: frozen.sourceImageId,
    tailImageId: frozen.tailImageId,
    inputs: context.inputs.map((input, index) => ({
      refId: input.refId,
      orderIndex: input.orderIndex ?? index,
      role: input.role,
      kind: input.kind as 'image' | 'text',
      assetId: input.assetId,
      upstreamTaskId: input.upstreamTaskId,
      textContent: input.textContent,
    })),
  };
}

function ensureParent(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  now: Date,
): { parent: MediaTaskRow; contract: CanvasUnifiedKlingContract } {
  const contract = freezeContract(db, task, context);
  const inputHash = hash(contract);
  const access = requireAccessContext();
  if (access.kind !== 'team') {
    throw new CanvasUnifiedTerminalError('team_only', '统一可灵 3.0 仅在团队模式可用。');
  }
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO execution_media_tasks (
        id, taskKey, actorId, scopeType, scopeId, module, taskId, unifiedModel, ruleVersion,
        inputHash, inputSnapshotJson, outputContractJson, sourceType, sourceId, sourceMetaJson,
        status, cancelRequestedAt, currentChannelKey, nextEligibleAt, waitReason, waitDetailJson,
        resultJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, 'canvas', ?, 'canvas', ?, ?, ?, ?, ?, ?, 'canvas_node', ?,
        ?, 'routing', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      randomUUID(), taskKey(task.id), access.actor.userId, task.canvasId, task.id,
      UNIFIED_KLING3_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, inputHash,
      JSON.stringify(contract),
      JSON.stringify({
        durationSec: contract.durationSec,
        aspectRatio: contract.aspectRatio,
        resolution: contract.resolution,
        multiShot: contract.multiShot,
        tailImageId: contract.tailImageId,
      }),
      task.canvasId,
      JSON.stringify({
        nodeId: task.nodeId,
        nodeEpoch: task.nodeEpoch,
        variantIndex: task.variantIndex,
        nodeKind: 'video-generation',
        taskId: task.id,
      }),
      at, at,
    );
    const parent = db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?')
      .get(taskKey(task.id)) as MediaTaskRow | undefined;
    if (!parent) throw new CanvasUnifiedTerminalError('contract_conflict', '统一可灵逻辑任务创建失败。');
    if (parent.actorId !== access.actor.userId
      || parent.scopeType !== 'canvas' || parent.scopeId !== task.canvasId
      || parent.module !== 'canvas' || parent.taskId !== task.id
      || parent.unifiedModel !== UNIFIED_KLING3_MODEL_KEY
      || parent.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION
      || parent.inputHash !== inputHash) {
      throw new CanvasUnifiedTerminalError('contract_conflict', '统一可灵冻结合同与逻辑任务不一致。');
    }
    for (const definition of unifiedKlingCompatibleChannels({
      ...contract,
      unifiedModel: UNIFIED_KLING3_MODEL_KEY,
      ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
      referenceAssetIds: [],
      multiShot: contract.multiShot,
    })) {
      db.prepare(`
        INSERT OR IGNORE INTO execution_media_channels (
          id, mediaTaskId, channelKey, providerTable, providerId, providerModel, priority,
          state, executionRevision, operationId, remoteId, evidenceJson, nextEligibleAt, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', 0, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        randomUUID(), parent.id, definition.channelKey, definition.providerTable,
        definition.providerId, definition.model, definition.priority, at, at,
      );
    }
  }).immediate();
  return {
    parent: db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?')
      .get(taskKey(task.id)) as MediaTaskRow,
    contract,
  };
}

type ProviderInspection =
  | { provider: ProviderRow; runtime: ProviderRuntime; problem: null }
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

function providerUsable(provider: ProviderRow, runtime: ProviderRuntime): boolean {
  return provider.enabled === 1 && runtime.enabled && runtime.configured
    && Boolean(runtime.baseUrl.trim()) && Boolean(runtime.apiKey.trim());
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

function findNextChannel(
  db: Database.Database,
  task: MediaTaskRow,
  contract: CanvasUnifiedKlingContract,
  executionRevision: number,
  excludeChannelKey?: string,
): ChannelSelection | ChannelSelectionFailure {
  if (submittedChannelCount(db, task.id) >= 2) {
    return {
      reason: 'channel_limit',
      message: '可灵 3.0 的两条通道都已真实提交过，不会再发起第三次生成。',
    };
  }
  const frozen = {
    ...contract,
    unifiedModel: UNIFIED_KLING3_MODEL_KEY,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
    referenceAssetIds: [],
  } satisfies FrozenUnifiedKlingVideoRequest;
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
    })) continue;
    return {
      definition,
      provider: inspected.provider,
      runtime: inspected.runtime,
      executionRevision: reusable?.revision ?? Math.max(1, executionRevision + 1),
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

function actualCapability(
  provider: ProviderRow,
  definition: UnifiedVideoChannelDefinition,
): CanvasModelCapability {
  const caps = companyVideoCapsForModel(definition.model);
  if (!caps) throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一可灵通道缺少视频能力表。');
  const capability: CanvasModelCapability = {
    ...COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY,
    key: `${COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.key}:channel:${definition.channelKey}`,
    displayName: provider.name || COMPANY_CANVAS_UNIFIED_KLING3_CAPABILITY.displayName,
    providerIdentity: provider.id,
    modelAlias: definition.model,
    parameters: [
      { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 3, max: 15, default: 5 },
      {
        key: 'aspectRatio', label: '比例', type: 'enum',
        options: caps.ratios, default: caps.ratios.includes('3:4') ? '3:4' : caps.ratios[0],
      },
      {
        key: 'resolution', label: '清晰度', type: 'enum',
        options: caps.tiers.filter((tier) => tier === '1K' || tier === '4K'),
        default: caps.tiers.includes('1K') ? '1K' : caps.tiers[0],
      },
      { key: 'multiShot', label: '智能分镜', type: 'boolean', default: false },
    ],
    evidence: 'mapped',
    evidenceNote: '由统一可灵 3.0 路由冻结并选择精确七牛/腾讯通道；真实通道只出现在执行记录。',
  };
  registerCanvasCapability(capability);
  return capability;
}

function effectiveExecution(
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  parent: MediaTaskRow,
  channel: MediaChannelRow,
  definition: UnifiedVideoChannelDefinition,
  provider: ProviderRow,
): CanvasUnifiedKlingExecution {
  const capability = actualCapability(provider, definition);
  const providerSnapshotJson = JSON.stringify({
    capabilityKey: capability.key,
    providerIdentity: provider.id,
    providerName: provider.name,
    modelAlias: definition.model,
    unifiedModel: UNIFIED_KLING3_MODEL_KEY,
    unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
    mediaTaskId: parent.id,
    channelKey: definition.channelKey,
    executionRevision: channel.executionRevision,
  });
  return {
    mediaKind: 'video',
    parent,
    channel,
    definition,
    provider,
    capability,
    providerSnapshotJson,
    effectiveTask: { ...task, providerSnapshot: providerSnapshotJson },
    effectiveContext: {
      ...context,
      capabilityKey: capability.key,
      providerIdentity: provider.id,
      modelAlias: definition.model,
    },
  };
}

function channelExecutionRevision(db: Database.Database, parentId: string): number {
  return Number((db.prepare(`SELECT COALESCE(MAX(executionRevision), 0) AS revision
    FROM execution_media_channels WHERE mediaTaskId = ?`).get(parentId) as { revision: number }).revision);
}

function selectionFailure(
  db: Database.Database,
  parent: MediaTaskRow,
  selection: ChannelSelectionFailure,
): never {
  db.prepare(`UPDATE execution_media_tasks
    SET status = 'failed', waitReason = ?, waitDetailJson = ?, resultJson = ?, updatedAt = ?
    WHERE id = ?`).run(
    selection.reason,
    JSON.stringify({ reason: selection.reason, message: selection.message }),
    JSON.stringify({ errorCode: selection.reason, message: selection.message }),
    new Date().toISOString(),
    parent.id,
  );
  throw new CanvasUnifiedTerminalError(selection.reason, selection.message);
}

function selectNext(
  db: Database.Database,
  parent: MediaTaskRow,
  contract: CanvasUnifiedKlingContract,
  excludeChannelKey?: string,
): ChannelSelection {
  const selection = findNextChannel(
    db,
    parent,
    contract,
    channelExecutionRevision(db, parent.id),
    excludeChannelKey,
  );
  if ('reason' in selection) return selectionFailure(db, parent, selection);
  markSelectedChannel(db, parent.id, selection.definition, selection.executionRevision);
  return selection;
}

function currentAccepted(task: CanvasTaskRecord, channel: MediaChannelRow): boolean {
  if (task.providerTaskId?.trim() || channel.remoteId?.trim()) return true;
  return ['accepted', 'unknown', 'succeeded'].includes(channel.state);
}

function explicitFailureFromAttempt(
  db: Database.Database,
  task: CanvasTaskRecord,
  operation: OperationRow,
): { evidence: SubmissionEvidence; attempt: AttemptRow } | null {
  const attempt = latestTerminalAttempt(db, operation.id);
  if (!attempt || !attempt.intentJournalSeq
    || !['not_created', 'failed'].includes(attempt.terminalState ?? '')) return null;
  const providerSnapshot = parseObject<Record<string, unknown>>(attempt.providerSnapshotJson, {});
  return {
    evidence: classifySubmissionOutcome({
      entry: 'canvas',
      taskId: task.id,
      businessAttemptNo: attempt.businessAttemptNo,
      adapterId: typeof providerSnapshot.type === 'string'
        ? providerSnapshot.type
        : 'canvas-unified-kling',
      stage: 'submit',
      source: 'persisted',
      outcome: attempt.terminalState === 'not_created' ? 'confirmed_not_created' : 'terminal_failed',
      remoteId: attempt.remoteId,
      errorCode: attempt.errorCode,
    }),
    attempt,
  };
}

function releaseProbe(
  db: Database.Database,
  parent: MediaTaskRow,
  channel: MediaChannelRow,
  providerId: string,
): void {
  releaseUnifiedChannelRecoveryProbe(db, {
    unifiedModel: parent.unifiedModel,
    channelKey: channel.channelKey,
    providerId,
  });
}

function executionForChannel(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  parent: MediaTaskRow,
  channel: MediaChannelRow,
): CanvasUnifiedKlingExecution {
  const contract = parseObject<CanvasUnifiedKlingContract | null>(parent.inputSnapshotJson, null);
  if (!contract) {
    throw new CanvasUnifiedTerminalError('contract_conflict', '统一可灵父任务冻结合同不可读取。');
  }
  const definition = unifiedKlingCompatibleChannels({
    ...contract,
    unifiedModel: UNIFIED_KLING3_MODEL_KEY,
    ruleVersion: UNIFIED_MEDIA_RULE_VERSION,
    referenceAssetIds: [],
  }).find((candidate) => candidate.channelKey === channel.channelKey);
  if (!definition) {
    throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一可灵通道与冻结能力不一致。');
  }
  const inspected = inspectExactProvider(db, definition);
  if (inspected.problem || !inspected.provider || !inspected.runtime) {
    throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一可灵真实通道身份发生漂移。');
  }
  return effectiveExecution(task, context, parent, channel, definition, inspected.provider);
}

function cancelParent(
  db: Database.Database,
  parent: MediaTaskRow,
  channel: MediaChannelRow | null,
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'canceled', cancelRequestedAt = COALESCE(cancelRequestedAt, ?),
        currentChannelKey = NULL, waitReason = NULL, waitDetailJson = NULL,
        nextEligibleAt = NULL, updatedAt = ? WHERE id = ?`).run(at, at, parent.id);
    db.prepare(`UPDATE execution_media_channels SET state = 'canceled', updatedAt = ?
      WHERE mediaTaskId = ? AND state IN ('candidate', 'selected', 'waiting_capacity', 'skipped', 'overflowed')`)
      .run(at, parent.id);
    db.prepare(`UPDATE execution_operations SET status = 'failed', waitReason = 'stage_canceled',
      waitDetail = NULL, updatedAt = ? WHERE mediaTaskId = ? AND status IN ('pending', 'deferred', 'admitted')`)
      .run(at, parent.id);
  }).immediate();
  if (channel) releaseProbe(db, parent, channel, channel.providerId);
}

export function prepareCanvasUnifiedKlingExecution(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  options: { resuming: boolean; now?: Date },
): CanvasUnifiedKlingExecution {
  const now = options.now ?? new Date();
  const { parent, contract } = ensureParent(db, task, context, now);
  if (parent.status === 'succeeded') {
    throw new CanvasUnifiedTerminalError('already_succeeded', '统一可灵任务已经完成。');
  }
  const channel = currentChannel(db, parent);
  const canceled = Boolean(task.cancelRequestedAt || parent.cancelRequestedAt);
  if (options.resuming && !channel) {
    throw new CanvasUnifiedTerminalError(
      'resume_channel_missing',
      '画布任务已有远端身份，但父任务缺少原通道身份；已停止自动处理，不会重新提交。',
    );
  }
  if (channel && options.resuming) {
    if (canceled && !currentAccepted(task, channel)) {
      cancelParent(db, parent, channel);
      throw new CanvasUnifiedCanceledError();
    }
    return executionForChannel(db, task, context, parent, channel);
  }
  if (channel) {
    const operation = operationForChannel(db, parent.id, channel.channelKey);
    const terminal = operation ? explicitFailureFromAttempt(db, task, operation) : null;
    if (terminal && ['selected', 'waiting_capacity'].includes(channel.state)) {
      const decision = handleCanvasUnifiedKlingExplicitFailure(db, task, {
        evidence: terminal.evidence,
        attemptId: terminal.attempt.id,
        operationId: operation?.id,
        channelKey: channel.channelKey,
      });
      if (decision.outcome === 'next_channel') {
        throw new CanvasUnifiedRequeueError('可灵 3.0 已记录明确失败，正在使用备用通道。');
      }
      if (decision.outcome === 'canceled') throw new CanvasUnifiedCanceledError();
      throw new CanvasUnifiedTerminalError(
        'channel_exhausted',
        '可灵 3.0 当前通道已明确失败，且没有剩余可提交通道。',
      );
    }
    if (canceled && !currentAccepted(task, channel)) {
      cancelParent(db, parent, channel);
      throw new CanvasUnifiedCanceledError();
    }
    if (channel.state === 'waiting_capacity') {
      const deadline = channel.nextEligibleAt ?? parent.nextEligibleAt;
      const detail = parseObject<Record<string, unknown>>(channel.evidenceJson, {});
      if (deadline && Number.isFinite(Date.parse(deadline)) && now.getTime() < Date.parse(deadline)) {
        throw new CanvasUnifiedWaitingError({
          nextEligibleAt: deadline,
          waitReason: parent.waitReason ?? 'pool_capacity',
          waitDetail: detail,
        });
      }
      return executionForChannel(db, task, context, parent, channel);
    }
    if (['selected', 'accepted', 'unknown'].includes(channel.state)) {
      return executionForChannel(db, task, context, parent, channel);
    }
    if (['failed', 'not_created'].includes(channel.state)) {
      throw new CanvasUnifiedTerminalError(
        'channel_exhausted',
        '可灵 3.0 当前通道已明确失败，且没有剩余可提交通道。',
      );
    }
    if (channel.state === 'canceled') throw new CanvasUnifiedCanceledError();
  }
  if (canceled) {
    cancelParent(db, parent, channel);
    throw new CanvasUnifiedCanceledError();
  }
  const selection = selectNext(db, parent, contract, channel?.channelKey);
  const selected = readChannel(db, parent.id, selection.definition.channelKey);
  if (!selected) throw new CanvasUnifiedTerminalError('channel_missing', '统一可灵通道状态缺失。');
  const freshParent = readParent(db, task.id) ?? parent;
  return effectiveExecution(
    task,
    context,
    freshParent,
    selected,
    selection.definition,
    selection.provider,
  );
}

export function requestCanvasUnifiedKlingCancellation(
  db: Database.Database,
  task: CanvasTaskRecord,
  now = new Date(),
): void {
  const parent = readParent(db, task.id);
  if (!parent) return;
  const channel = currentChannel(db, parent);
  const at = now.toISOString();
  db.prepare(`UPDATE execution_media_tasks
    SET cancelRequestedAt = COALESCE(cancelRequestedAt, ?), updatedAt = ? WHERE id = ?`)
    .run(at, at, parent.id);
  if (!channel || !currentAccepted(task, channel)) {
    cancelParent(db, { ...parent, cancelRequestedAt: at }, channel);
  }
}

export function recordCanvasUnifiedKlingOperation(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  operationId: string,
): void {
  db.prepare(`UPDATE execution_media_channels SET operationId = ?, updatedAt = ?
    WHERE id = ?`).run(operationId, new Date().toISOString(), execution.channel.id);
}

export function activateCanvasUnifiedKlingChannel(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
): void {
  markSelectedChannel(db, execution.parent.id, execution.definition, execution.channel.executionRevision);
}

export function releaseCanvasUnifiedKlingPreparation(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
): void {
  releaseProbe(db, execution.parent, execution.channel, execution.channel.providerId);
}

export function assertCanvasUnifiedKlingSubmissionStillCurrent(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
): void {
  const task = db.prepare(`SELECT phase, cancelRequestedAt FROM creative_canvas_tasks WHERE id = ?`)
    .get(execution.effectiveTask.id) as { phase: string; cancelRequestedAt: string | null } | undefined;
  if (!task || task.cancelRequestedAt) throw new CanvasUnifiedCanceledError();
  const parent = readParent(db, execution.effectiveTask.id);
  if (!parent || parent.cancelRequestedAt) throw new CanvasUnifiedCanceledError();
  const channel = currentChannel(db, parent);
  if (!channel || channel.channelKey !== execution.channel.channelKey
    || channel.executionRevision !== execution.channel.executionRevision
    || !['selected', 'waiting_capacity'].includes(channel.state)
    || !['preparing', 'submitting'].includes(task.phase)) {
    throw new CanvasUnifiedStaleError();
  }
  const inspected = inspectExactProvider(db, execution.definition);
  if (inspected.problem || !inspected.provider || !inspected.runtime
    || !providerUsable(inspected.provider, inspected.runtime)) {
    throw new CanvasUnifiedStaleError('可灵 3.0 当前通道已停用或凭据不可用，本轮未发送请求。');
  }
}

export function handleCanvasUnifiedKlingCapacityDeferred(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  input: { reasons: string[]; operationId: string | null; now?: Date },
): CanvasUnifiedCapacityDecision {
  if (input.reasons.length !== 1 || input.reasons[0] !== 'pool_capacity') {
    return { outcome: 'not_capacity', reason: input.reasons[0] ?? 'execution_deferred' };
  }
  const now = input.now ?? new Date();
  const parent = readParent(db, execution.effectiveTask.id);
  const channel = parent ? currentChannel(db, parent) : null;
  if (!parent || !channel) return { outcome: 'ignored', reason: 'channel_changed' };
  if (parent.cancelRequestedAt || execution.effectiveTask.cancelRequestedAt) {
    return { outcome: 'canceled', reason: 'canceled' };
  }
  const contract = parseObject<CanvasUnifiedKlingContract | null>(parent.inputSnapshotJson, null);
  if (!contract) return { outcome: 'ignored', reason: 'contract_missing' };

  if (channel.channelKey === 'qiniu') {
    const selection = findNextChannel(
      db,
      parent,
      contract,
      channelExecutionRevision(db, parent.id),
      channel.channelKey,
    );
    if (!('reason' in selection)) {
      db.transaction(() => {
        db.prepare(`UPDATE execution_media_channels SET state = 'overflowed', evidenceJson = ?,
          updatedAt = ? WHERE id = ?`).run(JSON.stringify({
          kind: 'capacity_overflow',
          at: now.toISOString(),
          previousChannelKey: channel.channelKey,
          nextChannelKey: selection.definition.channelKey,
        }), now.toISOString(), channel.id);
        markSelectedChannel(db, parent.id, selection.definition, selection.executionRevision);
      }).immediate();
      if (input.operationId) {
        db.prepare(`UPDATE execution_operations SET status = 'deferred', waitReason = 'channel_overflow',
          waitDetail = ?, updatedAt = ? WHERE id = ?`).run(
          JSON.stringify({ reason: 'channel_overflow', nextChannelKey: selection.definition.channelKey }),
          now.toISOString(),
          input.operationId,
        );
      }
      releaseProbe(db, parent, channel, channel.providerId);
      return {
        outcome: 'overflowed',
        previousChannelKey: channel.channelKey,
        nextChannelKey: selection.definition.channelKey,
      };
    }
  }

  const nextEligibleAt = new Date(now.getTime() + 1_000).toISOString();
  const detail = {
    reason: 'pool_capacity',
    channelKey: channel.channelKey,
    operationId: input.operationId,
    nextEligibleAt,
    startedAt: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'waiting_capacity', nextEligibleAt = ?, evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(nextEligibleAt, JSON.stringify(detail), now.toISOString(), channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'waiting', currentChannelKey = ?, waitReason = 'pool_capacity',
        waitDetailJson = ?, nextEligibleAt = ?, updatedAt = ? WHERE id = ?`)
      .run(channel.channelKey, JSON.stringify(detail), nextEligibleAt, now.toISOString(), parent.id);
  }).immediate();
  releaseProbe(db, parent, channel, channel.providerId);
  return { outcome: 'waiting', nextEligibleAt, waitDetail: detail };
}

export function handleCanvasUnifiedKlingExplicitFailure(
  db: Database.Database,
  task: CanvasTaskRecord,
  input: {
    evidence: SubmissionEvidence;
    attemptId?: string;
    operationId?: string;
    channelKey?: string | null;
  },
): CanvasUnifiedKlingFailureDecision {
  const evidence = input.evidence;
  if (evidence.identity.entry !== 'canvas'
    || evidence.identity.taskId !== task.id
    || !['submit', 'poll'].includes(evidence.identity.stage)
    || !['confirmed_not_created', 'terminal_failed'].includes(evidence.state)) {
    throw new CanvasUnifiedTerminalError(
      'invalid_failure_evidence',
      '统一可灵任务只接受明确未创建或远端明确失败证据。',
    );
  }
  const kind = evidence.state === 'confirmed_not_created' ? 'not_created' : 'failed';
  return db.transaction((): CanvasUnifiedKlingFailureDecision => {
    const parent = readParent(db, task.id);
    if (!parent?.currentChannelKey) {
      return { outcome: 'ignored', reason: 'task_not_ready' };
    }
    const channel = currentChannel(db, parent);
    if (!channel) return { outcome: 'ignored', reason: 'channel_missing' };
    const operation = (input.operationId
      ? db.prepare('SELECT * FROM execution_operations WHERE id = ?').get(input.operationId)
      : operationForChannel(db, parent.id, channel.channelKey)) as
      | (OperationRow & { mediaTaskId: string | null; channelKey: string | null })
      | undefined;
    if ((input.channelKey && input.channelKey !== channel.channelKey)
      || (operation?.channelKey && operation.channelKey !== channel.channelKey)
      || !operation || operation.mediaTaskId !== parent.id) {
      throw new CanvasUnifiedTerminalError(
        'invalid_failure_evidence',
        '显式失败证据没有关联到当前通道的真实执行操作。',
      );
    }
    const attempt = (input.attemptId
      ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(input.attemptId)
      : operation.currentAttemptId
        ? db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(operation.currentAttemptId)
        : null) as AttemptRow | null;
    const expectedTerminal = kind === 'not_created' ? 'not_created' : 'failed';
    if (!attempt || attempt.operationId !== operation.id || attempt.terminalState !== expectedTerminal) {
      throw new CanvasUnifiedTerminalError(
        'invalid_failure_evidence',
        '显式失败证据对应的执行尝试尚未完成同终态结算。',
      );
    }
    if (['failed', 'not_created', 'succeeded', 'canceled'].includes(channel.state)) {
      return { outcome: 'ignored', reason: 'already_terminal' };
    }
    const at = new Date().toISOString();
    const remoteId = channel.remoteId?.trim()
      || attempt.remoteId?.trim()
      || evidence.remoteId?.trim()
      || task.providerTaskId?.trim()
      || null;
    db.prepare(`UPDATE execution_media_channels
      SET state = ?, operationId = COALESCE(?, operationId), remoteId = COALESCE(remoteId, ?, ?),
        evidenceJson = ?, updatedAt = ? WHERE id = ?`).run(
      kind,
      operation.id,
      remoteId,
      evidence.remoteId,
      JSON.stringify({
        kind,
        at,
        attemptId: attempt.id,
        operationId: operation.id,
        remoteId,
        submissionState: attempt.submissionState,
        terminalState: attempt.terminalState,
        intentJournalSeq: attempt.intentJournalSeq,
        errorCode: attempt.errorCode ?? evidence.error?.code ?? null,
        submissionEvidence: evidence,
      }),
      at,
      channel.id,
    );
    db.prepare(`UPDATE execution_operations
      SET status = 'failed', waitReason = NULL, waitDetail = NULL, updatedAt = ? WHERE id = ?`)
      .run(at, operation.id);
    if (task.cancelRequestedAt || parent.cancelRequestedAt) {
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'canceled', currentChannelKey = NULL,
          cancelRequestedAt = COALESCE(cancelRequestedAt, ?), resultJson = ?, updatedAt = ?
        WHERE id = ?`).run(at, JSON.stringify({
        errorCode: 'canceled',
        previousChannelKey: channel.channelKey,
        reason: kind,
      }), at, parent.id);
      return { outcome: 'canceled', reason: kind };
    }
    const failureReason = unifiedChannelFailureReasonFromEvidence(evidence);
    if (failureReason) {
      recordUnifiedChannelFailure(db, {
        unifiedModel: parent.unifiedModel,
        channelKey: channel.channelKey,
        providerId: channel.providerId,
        reasonCode: failureReason,
        now: new Date(at),
      });
    }
    const contract = parseObject<CanvasUnifiedKlingContract | null>(parent.inputSnapshotJson, null);
    if (!contract) {
      throw new CanvasUnifiedTerminalError('contract_conflict', '统一可灵父任务冻结合同不可读取。');
    }
    const selection = findNextChannel(
      db,
      parent,
      contract,
      channelExecutionRevision(db, parent.id),
      channel.channelKey,
    );
    if ('reason' in selection) {
      const message = selection.reason === 'channel_limit'
        ? '可灵 3.0 的两条可用通道均已明确失败，任务已停止，不会发起第三次生成。'
        : selection.message;
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'failed', currentChannelKey = ?, resultJson = ?, updatedAt = ?
        WHERE id = ?`).run(channel.channelKey, JSON.stringify({
        errorCode: selection.reason,
        message,
        previousChannelKey: channel.channelKey,
        submittedChannelCount: submittedChannelCount(db, parent.id),
      }), at, parent.id);
      return { outcome: 'exhausted', reason: selection.reason };
    }
    markSelectedChannel(db, parent.id, selection.definition, selection.executionRevision);
    return {
      outcome: 'next_channel',
      previousChannelKey: channel.channelKey,
      nextChannelKey: selection.definition.channelKey,
    };
  }).immediate();
}

export function recordCanvasUnifiedKlingAccepted(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  remoteId: string,
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'accepted', remoteId = ?, updatedAt = ? WHERE id = ?`)
      .run(remoteId, at, execution.channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'accepted', currentChannelKey = ?, updatedAt = ? WHERE id = ?`)
      .run(execution.channel.channelKey, at, execution.parent.id);
  }).immediate();
}

export function recordCanvasUnifiedKlingRemoteId(
  db: Database.Database,
  task: CanvasTaskRecord,
  remoteId: string,
): void {
  const parent = readParent(db, task.id);
  if (!parent) return;
  const channel = currentChannel(db, parent);
  if (!channel) return;
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'accepted', remoteId = ?, updatedAt = ? WHERE id = ?`)
      .run(remoteId, at, channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'accepted', currentChannelKey = ?, updatedAt = ? WHERE id = ?`)
      .run(channel.channelKey, at, parent.id);
  }).immediate();
}

export function recordCanvasUnifiedKlingConfirmedNotCreated(
  db: Database.Database,
  task: CanvasTaskRecord,
): void {
  const parent = readParent(db, task.id);
  if (!parent) return;
  const channel = currentChannel(db, parent);
  const at = new Date().toISOString();
  db.transaction(() => {
    if (channel) {
      db.prepare(`UPDATE execution_media_channels
        SET state = 'not_created', evidenceJson = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify({ kind: 'confirmed_not_created', at }), at, channel.id);
    }
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'failed', resultJson = ?, updatedAt = ? WHERE id = ?`)
      .run(JSON.stringify({ taskId: task.id, errorCode: 'confirmed_not_created' }), at, parent.id);
  }).immediate();
}

export function recordCanvasUnifiedKlingUnknown(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  evidence: SubmissionEvidence,
  remoteId: string | null,
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'unknown', remoteId = COALESCE(?, remoteId), evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(remoteId, JSON.stringify({ submissionEvidence: evidence, at }), at, execution.channel.id);
    db.prepare(`UPDATE execution_media_tasks SET status = 'unknown', currentChannelKey = ?,
      resultJson = ?, updatedAt = ? WHERE id = ?`).run(
      execution.channel.channelKey,
      JSON.stringify({ taskId: execution.effectiveTask.id, errorCode: evidence.error?.code ?? 'unknown' }),
      at,
      execution.parent.id,
    );
  }).immediate();
  const reason = unifiedChannelFailureReasonFromEvidence(evidence);
  if (reason) {
    recordUnifiedChannelFailure(db, {
      unifiedModel: execution.parent.unifiedModel,
      channelKey: execution.channel.channelKey,
      providerId: execution.channel.providerId,
      reasonCode: reason,
      now: new Date(at),
    });
  }
}

export function recordCanvasUnifiedKlingDownloadFailure(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  evidence: SubmissionEvidence,
): void {
  const at = new Date().toISOString();
  db.prepare(`UPDATE execution_media_channels
    SET state = 'accepted', evidenceJson = ?, updatedAt = ? WHERE id = ?`)
    .run(JSON.stringify({ submissionEvidence: evidence, downloadFailedAt: at }), at, execution.channel.id);
  db.prepare(`UPDATE execution_media_tasks SET status = 'accepted', currentChannelKey = ?,
    resultJson = ?, updatedAt = ? WHERE id = ?`).run(
    execution.channel.channelKey,
    JSON.stringify({ taskId: execution.effectiveTask.id, errorCode: evidence.error?.code ?? 'download_failed' }),
    at,
    execution.parent.id,
  );
  recordUnifiedChannelSuccess(db, {
    unifiedModel: execution.parent.unifiedModel,
    channelKey: execution.channel.channelKey,
    providerId: execution.channel.providerId,
    now: new Date(at),
  });
}

export function recordCanvasUnifiedKlingSucceeded(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  result: { outputAssetId: string; remoteId?: string | null },
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = 'succeeded', remoteId = COALESCE(?, remoteId), updatedAt = ? WHERE id = ?`)
      .run(result.remoteId ?? null, at, execution.channel.id);
    db.prepare(`UPDATE execution_media_tasks
      SET status = 'succeeded', currentChannelKey = ?, waitReason = NULL, waitDetailJson = NULL,
        nextEligibleAt = NULL, resultJson = ?, updatedAt = ? WHERE id = ?`).run(
      execution.channel.channelKey,
      JSON.stringify({
        taskId: execution.effectiveTask.id,
        outputAssetId: result.outputAssetId,
        remoteId: result.remoteId ?? null,
        channelKey: execution.channel.channelKey,
      }),
      at,
      execution.parent.id,
    );
  }).immediate();
  recordUnifiedChannelSuccess(db, {
    unifiedModel: execution.parent.unifiedModel,
    channelKey: execution.channel.channelKey,
    providerId: execution.channel.providerId,
    now: new Date(at),
  });
}

export function recordCanvasUnifiedKlingFinalFailure(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution,
  input: { code: string; message: string },
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels SET state = 'failed', evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify({
      kind: 'task_failed',
      code: input.code,
      message: input.message,
      at,
    }), at, execution.channel.id);
    db.prepare(`UPDATE execution_media_tasks SET status = 'failed', currentChannelKey = ?,
      resultJson = ?, updatedAt = ? WHERE id = ?`).run(
      execution.channel.channelKey,
      JSON.stringify({ taskId: execution.effectiveTask.id, errorCode: input.code, message: input.message }),
      at,
      execution.parent.id,
    );
  }).immediate();
  releaseProbe(db, execution.parent, execution.channel, execution.channel.providerId);
}

export function recordCanvasUnifiedKlingCanceled(
  db: Database.Database,
  execution: CanvasUnifiedKlingExecution | null,
): void {
  if (!execution) return;
  cancelParent(db, execution.parent, execution.channel);
}

export function readCanvasUnifiedKlingParent(
  db: Database.Database,
  taskId: string,
): { parent: MediaTaskRow; channel: MediaChannelRow | null } | null {
  const parent = readParent(db, taskId);
  return parent ? { parent, channel: currentChannel(db, parent) } : null;
}
