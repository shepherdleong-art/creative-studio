import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isPlaceholderValue } from '../video-auth.ts';
import { requireAccessContext } from '../media-core/access-context.ts';
import { readAttempt, readOperation } from '../media-core/execution/records.ts';
import {
  classifySubmissionOutcome,
  type SubmissionEvidence,
} from '../media-core/submission-evidence.ts';
import {
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  unifiedImageCompatibleChannels,
  type UnifiedImageChannelDefinition,
} from '../media-core/unified-media/catalog.ts';
import {
  markUnifiedImageChannelSelected,
  selectUnifiedImageChannelForTask,
  type UnifiedImageRouteProvider,
  type UnifiedImageRouteSelection,
  type UnifiedImageRouteSelectionFailure,
} from '../media-core/unified-media/execution.ts';
import {
  imageCongestionDeadline,
  readUnifiedImageCongestionSettings,
} from '../media-core/unified-media/settings.ts';
import {
  recordUnifiedChannelFailure,
  recordUnifiedChannelSuccess,
  releaseUnifiedChannelRecoveryProbe,
  unifiedChannelFailureReasonFromEvidence,
} from '../media-core/unified-media/health.ts';
import {
  resolveUnifiedImageOutput,
  UnifiedImageRequestError,
} from '../media-core/unified-media/requests.ts';
import { companyImageCapsForModel } from '../company-gateway-size.ts';
import { registerCanvasCapability, type CanvasModelCapability } from './capabilities.ts';
import {
  COMPANY_CANVAS_IMAGE2_CAPABILITY,
  COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY,
  COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY,
} from './adapters/company-capabilities.ts';
import type { CanvasTaskContext } from './adapters/types.ts';
import type { CanvasTaskRecord } from './tasks.ts';

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

export interface CanvasUnifiedImageContract {
  schemaVersion: 1;
  kind: 'canvas-unified-image';
  unifiedModel: typeof UNIFIED_IMAGE_MODEL_KEY;
  unifiedRuleVersion: typeof UNIFIED_MEDIA_RULE_VERSION;
  canvasId: string;
  taskId: string;
  nodeId: string;
  nodeEpoch: number;
  variantIndex: number;
  mediaKind: 'image';
  generationMode: 'text-to-image' | 'image-to-image';
  prompt: string;
  tier: '1k' | '2k' | '4k';
  ratio: string;
  size: string;
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

export interface CanvasUnifiedExecution {
  mediaKind: 'image';
  parent: MediaTaskRow;
  channel: MediaChannelRow;
  definition: UnifiedImageChannelDefinition;
  provider: UnifiedImageRouteProvider;
  capability: CanvasModelCapability;
  providerSnapshotJson: string;
  effectiveTask: CanvasTaskRecord;
  effectiveContext: CanvasTaskContext;
}

export type CanvasUnifiedFailureDecision =
  | { outcome: 'next_channel'; previousChannelKey: string; nextChannelKey: string }
  | { outcome: 'exhausted' | 'canceled' | 'ignored'; reason?: string };

export type CanvasUnifiedCapacityDecision =
  | { outcome: 'waiting'; nextEligibleAt: string; waitDetail: Record<string, unknown> }
  | { outcome: 'overflowed'; previousChannelKey: string; nextChannelKey: string }
  | { outcome: 'not_capacity' | 'ignored' | 'canceled'; reason: string };

export class CanvasUnifiedWaitingError extends Error {
  readonly nextEligibleAt: string;
  readonly waitReason: string;
  readonly waitDetail: Record<string, unknown> | null;

  constructor(input: {
    nextEligibleAt: string;
    waitReason?: string;
    waitDetail?: Record<string, unknown> | null;
  }) {
    super('Image 2 正在等待云端名额，达到拥堵阈值后会重新准入。');
    this.name = 'CanvasUnifiedWaitingError';
    this.nextEligibleAt = input.nextEligibleAt;
    this.waitReason = input.waitReason ?? 'pool_capacity';
    this.waitDetail = input.waitDetail ?? null;
  }
}

export class CanvasUnifiedCanceledError extends Error {
  constructor() {
    super('任务已记录取消意图，不再选择新通道或提交。');
    this.name = 'CanvasUnifiedCanceledError';
  }
}

export class CanvasUnifiedRequeueError extends Error {
  readonly reason: string;

  constructor(message: string, reason = 'fallback_pending') {
    super(message);
    this.name = 'CanvasUnifiedRequeueError';
    this.reason = reason;
  }
}

export class CanvasUnifiedTerminalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CanvasUnifiedTerminalError';
    this.code = code;
  }
}

export class CanvasUnifiedStaleError extends Error {
  constructor(message = '统一图片任务已切换通道或被取消，本轮未发送请求。') {
    super(message);
    this.name = 'CanvasUnifiedStaleError';
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function parseObject<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function taskKey(taskId: string): string {
  return `canvas:${taskId}`;
}

export function isCanvasUnifiedImageTask(task: CanvasTaskRecord): boolean {
  const snapshot = parseObject<Record<string, unknown>>(task.providerSnapshot, {});
  return task.mediaKind === 'image'
    && snapshot.unifiedModel === UNIFIED_IMAGE_MODEL_KEY
    && snapshot.unifiedRuleVersion === UNIFIED_MEDIA_RULE_VERSION;
}

function readParent(db: Database.Database, taskId: string): MediaTaskRow | null {
  return (db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?').get(taskKey(taskId)) as
    | MediaTaskRow
    | undefined) ?? null;
}

function readChannel(
  db: Database.Database,
  parentId: string,
  channelKey: string,
): MediaChannelRow | null {
  return (db.prepare(`SELECT * FROM execution_media_channels
    WHERE mediaTaskId = ? AND channelKey = ?`).get(parentId, channelKey) as
    | MediaChannelRow
    | undefined) ?? null;
}

function currentChannel(
  db: Database.Database,
  parent: MediaTaskRow,
): MediaChannelRow | null {
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

function latestTerminalAttempt(
  db: Database.Database,
  operationId: string,
): AttemptRow | null {
  return (db.prepare(`SELECT id, operationId, businessAttemptNo, providerSnapshotJson,
      submissionState, terminalState, remoteId, errorCode, intentJournalSeq
    FROM execution_attempts WHERE operationId = ?
    ORDER BY createdAt DESC, transportSeq DESC, id DESC LIMIT 1`).get(operationId) as
    | AttemptRow
    | undefined) ?? null;
}

function freezeContract(
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
): CanvasUnifiedImageContract {
  if (task.mediaKind !== 'image') {
    throw new CanvasUnifiedTerminalError('invalid_contract', '统一 Image 2 只能用于画布图片节点。');
  }
  if (!['text-to-image', 'image-to-image'].includes(context.generationMode)) {
    throw new CanvasUnifiedTerminalError('invalid_mode', '统一 Image 2 不支持当前画布生成模式。');
  }
  let output: ReturnType<typeof resolveUnifiedImageOutput>;
  try {
    output = resolveUnifiedImageOutput(
      context.parameters.resolution,
      context.parameters.aspectRatio,
    );
  } catch (error) {
    if (error instanceof UnifiedImageRequestError) {
      throw new CanvasUnifiedTerminalError(error.code, error.message);
    }
    throw error;
  }
  const inputs = context.inputs.map((input, index) => {
    if (!['image', 'text'].includes(input.kind)) {
      throw new CanvasUnifiedTerminalError('invalid_input', '统一 Image 2 不接受视频或音频输入。');
    }
    if (input.kind === 'image' && !input.assetId) {
      throw new CanvasUnifiedTerminalError('invalid_input', '统一 Image 2 的图片输入缺少固定素材身份。');
    }
    return {
      refId: input.refId,
      orderIndex: input.orderIndex ?? index,
      role: input.role,
      kind: input.kind as 'image' | 'text',
      assetId: input.assetId,
      upstreamTaskId: input.upstreamTaskId,
      textContent: input.textContent,
    };
  });
  if (inputs.filter((input) => input.kind === 'image').length > 6) {
    throw new CanvasUnifiedTerminalError('invalid_input', '统一 Image 2 最多接受 6 张图片输入。');
  }
  return {
    schemaVersion: 1,
    kind: 'canvas-unified-image',
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
    canvasId: task.canvasId,
    taskId: task.id,
    nodeId: task.nodeId,
    nodeEpoch: task.nodeEpoch,
    variantIndex: task.variantIndex,
    mediaKind: 'image',
    generationMode: context.generationMode as 'text-to-image' | 'image-to-image',
    prompt: context.prompt,
    tier: output.tier,
    ratio: output.ratio,
    size: output.size,
    inputs,
  };
}

function ensureParent(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  now: Date,
): { parent: MediaTaskRow; contract: CanvasUnifiedImageContract } {
  const contract = freezeContract(task, context);
  const inputHash = hash(contract);
  const access = requireAccessContext();
  if (access.kind !== 'team') {
    throw new CanvasUnifiedTerminalError('team_only', '统一 Image 2 仅在团队模式可用。');
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
      UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, inputHash,
      JSON.stringify(contract), JSON.stringify({
        tier: contract.tier, ratio: contract.ratio, size: contract.size,
      }), task.canvasId,
      JSON.stringify({
        nodeId: task.nodeId, nodeEpoch: task.nodeEpoch, variantIndex: task.variantIndex,
        nodeKind: 'image-generation', taskId: task.id,
      }), at, at,
    );
    const parent = db.prepare('SELECT * FROM execution_media_tasks WHERE taskKey = ?')
      .get(taskKey(task.id)) as MediaTaskRow | undefined;
    if (!parent) throw new CanvasUnifiedTerminalError('contract_conflict', '统一图片逻辑任务创建失败。');
    if (parent.actorId !== access.actor.userId
      || parent.scopeType !== 'canvas' || parent.scopeId !== task.canvasId
      || parent.module !== 'canvas' || parent.taskId !== task.id
      || parent.unifiedModel !== UNIFIED_IMAGE_MODEL_KEY
      || parent.ruleVersion !== UNIFIED_MEDIA_RULE_VERSION
      || parent.inputHash !== inputHash) {
      throw new CanvasUnifiedTerminalError('contract_conflict', '统一图片任务冻结合同与逻辑任务不一致。');
    }
    for (const definition of unifiedImageCompatibleChannels(contract.tier, contract.ratio)) {
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

function actualCapability(
  provider: UnifiedImageRouteProvider,
  definition: UnifiedImageChannelDefinition,
): CanvasModelCapability {
  const caps = companyImageCapsForModel(definition.model);
  if (!caps) throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一通道缺少图片能力表。');
  const template = definition.channelKey === 'qiniu'
    ? COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY
    : COMPANY_CANVAS_IMAGE2_CAPABILITY;
  const capability: CanvasModelCapability = {
    ...template,
    key: `${COMPANY_CANVAS_UNIFIED_IMAGE2_CAPABILITY.key}:channel:${definition.channelKey}`,
    displayName: provider.name || template.displayName,
    providerIdentity: provider.id,
    modelAlias: definition.model,
    parameters: [
      { key: 'aspectRatio', label: '比例', type: 'enum', options: caps.ratios, default: '1:1' },
      {
        key: 'resolution', label: '清晰度', type: 'enum',
        options: caps.tiers, default: caps.tiers.includes('2K') ? '2K' : caps.tiers[0],
      },
    ],
    evidence: 'mapped',
    evidenceNote: '由统一 Image 2 路由冻结并选择精确七牛/腾讯通道；真实通道只出现在执行记录。',
  };
  registerCanvasCapability(capability);
  return capability;
}

function effectiveExecution(
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  parent: MediaTaskRow,
  channel: MediaChannelRow,
  definition: UnifiedImageChannelDefinition,
  provider: UnifiedImageRouteProvider,
): CanvasUnifiedExecution {
  const capability = actualCapability(provider, definition);
  const providerSnapshotJson = JSON.stringify({
    capabilityKey: capability.key,
    providerIdentity: provider.id,
    providerName: provider.name,
    modelAlias: definition.model,
    unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
    unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
    mediaTaskId: parent.id,
    channelKey: definition.channelKey,
    executionRevision: channel.executionRevision,
  });
  return {
    mediaKind: 'image',
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

function selectionFailure(
  db: Database.Database,
  parent: MediaTaskRow,
  selection: UnifiedImageRouteSelectionFailure,
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
  contract: CanvasUnifiedImageContract,
  excludeChannelKey?: string,
): UnifiedImageRouteSelection {
  const row = db.prepare(`SELECT COALESCE(MAX(executionRevision), 0) AS revision
    FROM execution_media_channels WHERE mediaTaskId = ?`).get(parent.id) as { revision: number };
  const selection = selectUnifiedImageChannelForTask(db, {
    mediaTaskId: parent.id,
    tier: contract.tier,
    ratio: contract.ratio,
    executionRevision: Number(row.revision ?? 0),
    ...(excludeChannelKey ? { excludeChannelKey } : {}),
  });
  if ('reason' in selection) return selectionFailure(db, parent, selection);
  markUnifiedImageChannelSelected(
    db,
    parent.id,
    selection.definition,
    selection.executionRevision,
  );
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
        : 'canvas-unified-image',
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

export function handleCanvasUnifiedExplicitFailure(
  db: Database.Database,
  task: CanvasTaskRecord,
  input: {
    evidence: SubmissionEvidence;
    attemptId?: string;
    operationId?: string;
    channelKey?: string | null;
  },
): CanvasUnifiedFailureDecision {
  if (!['confirmed_not_created', 'terminal_failed'].includes(input.evidence.state)) {
    throw new CanvasUnifiedTerminalError('invalid_evidence', '只有明确未创建或远端明确失败才允许切换通道。');
  }
  const parent = readParent(db, task.id);
  if (!parent) throw new CanvasUnifiedTerminalError('task_missing', '统一图片逻辑任务不存在。');
  const channel = currentChannel(db, parent);
  if (!channel || (input.channelKey && input.channelKey !== channel.channelKey)) {
    return { outcome: 'ignored', reason: 'channel_changed' };
  }
  if (['failed', 'not_created', 'succeeded', 'canceled'].includes(channel.state)) {
    return { outcome: 'ignored', reason: 'already_terminal' };
  }
  const operation = operationForChannel(db, parent.id, channel.channelKey);
  if (input.operationId && operation?.id !== input.operationId) {
    throw new CanvasUnifiedTerminalError('invalid_evidence', '失败证据未关联到当前通道的执行操作。');
  }
  const attempt = input.attemptId
    ? (db.prepare(`SELECT id, operationId, businessAttemptNo, providerSnapshotJson,
        submissionState, terminalState, remoteId, errorCode, intentJournalSeq
        FROM execution_attempts WHERE id = ?`).get(input.attemptId) as AttemptRow | undefined)
    : operation ? latestTerminalAttempt(db, operation.id) : undefined;
  if (!attempt || !operation || attempt.operationId !== operation.id || !attempt.intentJournalSeq
    || attempt.terminalState !== (input.evidence.state === 'confirmed_not_created' ? 'not_created' : 'failed')) {
    throw new CanvasUnifiedTerminalError('invalid_evidence', '失败证据尚未完成同终态结算。');
  }
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels
      SET state = ?, operationId = COALESCE(?, operationId),
        remoteId = COALESCE(remoteId, ?), evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(
      input.evidence.state === 'confirmed_not_created' ? 'not_created' : 'failed',
      operation?.id ?? null,
      input.evidence.remoteId ?? attempt.remoteId,
      JSON.stringify({
        kind: input.evidence.state,
        at,
        attemptId: attempt.id,
        operationId: operation?.id ?? null,
        submissionEvidence: input.evidence,
      }),
      at,
      channel.id,
    );
    if (operation) {
      db.prepare(`UPDATE execution_operations
        SET status = 'failed', waitReason = ?, waitDetail = NULL, updatedAt = ?
        WHERE id = ?`).run(
        input.evidence.state === 'confirmed_not_created'
          ? 'channel_not_created'
          : 'channel_terminal_failed',
        at,
        operation.id,
      );
    }
  }).immediate();

  const failureReason = unifiedChannelFailureReasonFromEvidence(input.evidence);
  if (failureReason) {
    recordUnifiedChannelFailure(db, {
      unifiedModel: parent.unifiedModel,
      channelKey: channel.channelKey,
      providerId: channel.providerId,
      reasonCode: failureReason,
      now: new Date(at),
    });
  } else {
    recordUnifiedChannelSuccess(db, {
      unifiedModel: parent.unifiedModel,
      channelKey: channel.channelKey,
      providerId: channel.providerId,
      now: new Date(at),
    });
  }

  if (task.cancelRequestedAt || parent.cancelRequestedAt) {
    cancelParent(db, parent, channel);
    db.prepare(`UPDATE execution_media_tasks SET resultJson = ?, updatedAt = ? WHERE id = ?`).run(
      JSON.stringify({ taskId: task.id, errorCode: 'canceled', previousChannelKey: channel.channelKey }),
      new Date().toISOString(),
      parent.id,
    );
    return { outcome: 'canceled' };
  }

  const contract = parseObject<CanvasUnifiedImageContract>(
    parent.inputSnapshotJson,
    JSON.parse(parent.inputSnapshotJson) as CanvasUnifiedImageContract,
  );
  const selection = selectUnifiedImageChannelForTask(db, {
    mediaTaskId: parent.id,
    tier: contract.tier,
    ratio: contract.ratio,
    executionRevision: Math.max(channel.executionRevision, ...channelRevisions(db, parent.id)),
    excludeChannelKey: channel.channelKey,
  });
  if ('reason' in selection) {
    const message = selection.reason === 'channel_limit'
      ? 'Image 2 的两条可用通道均已明确失败，任务已停止，不会发起第三次生成。'
      : selection.message;
    markParent(db, parent, {
      status: 'failed', currentChannelKey: channel.channelKey,
      result: { taskId: task.id, errorCode: selection.reason, message },
    });
    return { outcome: 'exhausted', reason: selection.reason };
  }
  markUnifiedImageChannelSelected(db, parent.id, selection.definition, selection.executionRevision);
  return {
    outcome: 'next_channel',
    previousChannelKey: channel.channelKey,
    nextChannelKey: selection.definition.channelKey,
  };
}

function channelRevisions(db: Database.Database, parentId: string): number[] {
  return (db.prepare(`SELECT executionRevision FROM execution_media_channels WHERE mediaTaskId = ?`)
    .all(parentId) as Array<{ executionRevision: number }>)
    .map((row) => Number(row.executionRevision ?? 0));
}

function markParent(
  db: Database.Database,
  parent: MediaTaskRow,
  input: {
    status: string;
    currentChannelKey?: string | null;
    result?: unknown;
    waitReason?: string | null;
    waitDetail?: unknown;
    nextEligibleAt?: string | null;
  },
): void {
  db.prepare(`UPDATE execution_media_tasks
    SET status = ?, currentChannelKey = ?, resultJson = COALESCE(?, resultJson),
      waitReason = ?, waitDetailJson = ?, nextEligibleAt = ?, updatedAt = ?
    WHERE id = ?`).run(
    input.status,
    input.currentChannelKey === undefined ? parent.currentChannelKey : input.currentChannelKey,
    input.result === undefined ? null : JSON.stringify(input.result),
    input.waitReason === undefined ? null : input.waitReason,
    input.waitDetail === undefined ? null : JSON.stringify(input.waitDetail),
    input.nextEligibleAt === undefined ? null : input.nextEligibleAt,
    new Date().toISOString(),
    parent.id,
  );
}

export function prepareCanvasUnifiedImageExecution(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  options: { resuming: boolean; now?: Date },
): CanvasUnifiedExecution {
  const now = options.now ?? new Date();
  const { parent, contract } = ensureParent(db, task, context, now);
  if (parent.status === 'succeeded') {
    throw new CanvasUnifiedTerminalError('already_succeeded', '统一图片任务已经完成。');
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
      const decision = handleCanvasUnifiedExplicitFailure(db, task, {
        evidence: terminal.evidence,
        attemptId: terminal.attempt.id,
        operationId: operation?.id,
        channelKey: channel.channelKey,
      });
      if (decision.outcome === 'next_channel') {
        throw new CanvasUnifiedRequeueError('Image 2 已记录明确失败，正在使用备用通道。');
      }
      if (decision.outcome === 'canceled') throw new CanvasUnifiedCanceledError();
      throw new CanvasUnifiedTerminalError(
        'channel_exhausted',
        'Image 2 当前通道已明确失败，且没有剩余可提交通道。',
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
        'Image 2 当前通道已明确失败，且没有剩余可提交通道。',
      );
    }
    if (channel.state === 'canceled') {
      throw new CanvasUnifiedCanceledError();
    }
  }

  if (canceled) {
    cancelParent(db, parent, channel);
    throw new CanvasUnifiedCanceledError();
  }

  const selection = selectNext(db, parent, contract, channel?.channelKey);
  const selected = readChannel(db, parent.id, selection.definition.channelKey);
  if (!selected) throw new CanvasUnifiedTerminalError('channel_missing', '统一图片通道状态缺失。');
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

function executionForChannel(
  db: Database.Database,
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  parent: MediaTaskRow,
  channel: MediaChannelRow,
): CanvasUnifiedExecution {
  const contract = parseObject<CanvasUnifiedImageContract | null>(parent.inputSnapshotJson, null);
  if (!contract) {
    throw new CanvasUnifiedTerminalError('contract_conflict', '统一图片父任务冻结合同不可读取。');
  }
  const definition = unifiedImageCompatibleChannels(contract.tier, contract.ratio)
    .find((candidate) => candidate.channelKey === channel.channelKey);
  if (!definition) {
    throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一图片通道与冻结能力不一致。');
  }
  const provider = db.prepare(`SELECT id, name, baseUrl, apiKey, model, type, enabled, defaultCostPerImage
    FROM providers WHERE id = ?`).get(definition.providerId) as UnifiedImageRouteProvider | undefined;
  if (!provider || provider.model !== definition.model || provider.type !== 'gateway-task-image') {
    throw new CanvasUnifiedTerminalError('channel_identity_mismatch', '统一图片真实通道身份发生漂移。');
  }
  return effectiveExecution(task, context, parent, channel, definition, provider);
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

export function requestCanvasUnifiedImageCancellation(
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

export function recordCanvasUnifiedOperation(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
  operationId: string,
): void {
  db.prepare(`UPDATE execution_media_channels SET operationId = ?, updatedAt = ?
    WHERE id = ?`).run(operationId, new Date().toISOString(), execution.channel.id);
}

export function activateCanvasUnifiedChannel(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
): void {
  markUnifiedImageChannelSelected(
    db,
    execution.parent.id,
    execution.definition,
    execution.channel.executionRevision,
  );
}

export function releaseCanvasUnifiedPreparation(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
): void {
  releaseProbe(db, execution.parent, execution.channel, execution.channel.providerId);
}

export function assertCanvasUnifiedSubmissionStillCurrent(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
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
  const provider = db.prepare('SELECT enabled, baseUrl, apiKey FROM providers WHERE id = ?')
    .get(channel.providerId) as { enabled: number; baseUrl: string; apiKey: string } | undefined;
  if (!provider || provider.enabled !== 1 || !provider.baseUrl.trim() || !provider.apiKey.trim()
    || isPlaceholderValue(provider.apiKey)) {
    throw new CanvasUnifiedStaleError('统一图片当前通道已停用或凭据不可用，本轮未发送请求。');
  }
}

export function handleCanvasUnifiedCapacityDeferred(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
  input: {
    reasons: string[];
    operationId: string | null;
    now?: Date;
  },
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
  const settings = readUnifiedImageCongestionSettings(db);
  const existingDeadline = channel.nextEligibleAt ?? parent.nextEligibleAt;
  const alreadyWaiting = channel.state === 'waiting_capacity' && Boolean(existingDeadline);

  const persistWait = (deadline: Date): CanvasUnifiedCapacityDecision => {
    const detail = {
      reason: 'pool_capacity',
      channelKey: channel.channelKey,
      operationId: input.operationId,
      thresholdSec: settings.imageCongestionThresholdSec,
      nextEligibleAt: deadline.toISOString(),
      startedAt: alreadyWaiting ? parseObject<Record<string, unknown>>(channel.evidenceJson, {}).startedAt : now.toISOString(),
    };
    db.transaction(() => {
      db.prepare(`UPDATE execution_media_channels
        SET state = 'waiting_capacity', nextEligibleAt = ?, evidenceJson = ?, updatedAt = ?
        WHERE id = ?`).run(deadline.toISOString(), JSON.stringify(detail), now.toISOString(), channel.id);
      db.prepare(`UPDATE execution_media_tasks
        SET status = 'waiting', currentChannelKey = ?, nextEligibleAt = ?,
          waitReason = 'pool_capacity', waitDetailJson = ?, updatedAt = ?
        WHERE id = ?`).run(
        channel.channelKey, deadline.toISOString(), JSON.stringify(detail), now.toISOString(), parent.id,
      );
    }).immediate();
    releaseProbe(db, parent, channel, channel.providerId);
    return { outcome: 'waiting', nextEligibleAt: deadline.toISOString(), waitDetail: detail };
  };

  if (!alreadyWaiting) {
    const deadline = channel.channelKey === 'qiniu'
      ? imageCongestionDeadline(now, settings.imageCongestionThresholdSec)
      : now;
    return persistWait(deadline);
  }

  const deadlineMs = Date.parse(existingDeadline!);
  if (!Number.isFinite(deadlineMs) || now.getTime() < deadlineMs) {
    return {
      outcome: 'waiting',
      nextEligibleAt: existingDeadline!,
      waitDetail: parseObject<Record<string, unknown>>(channel.evidenceJson, {}),
    };
  }

  if (channel.channelKey !== 'qiniu') {
    return persistWait(now);
  }

  const contract = parseObject<CanvasUnifiedImageContract>(parent.inputSnapshotJson, {} as CanvasUnifiedImageContract);
  const selection = selectUnifiedImageChannelForTask(db, {
    mediaTaskId: parent.id,
    tier: contract.tier,
    ratio: contract.ratio,
    executionRevision: Math.max(channel.executionRevision, ...channelRevisions(db, parent.id)),
    excludeChannelKey: channel.channelKey,
  });
  if ('reason' in selection) {
    return persistWait(imageCongestionDeadline(now, settings.imageCongestionThresholdSec));
  }
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels SET state = 'overflowed', evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify({
      kind: 'capacity_overflow', at: now.toISOString(), thresholdSec: settings.imageCongestionThresholdSec,
    }), now.toISOString(), channel.id);
    markUnifiedImageChannelSelected(
      db,
      parent.id,
      selection.definition,
      selection.executionRevision,
    );
  }).immediate();
  return {
    outcome: 'overflowed',
    previousChannelKey: channel.channelKey,
    nextChannelKey: selection.definition.channelKey,
  };
}

export function currentCanvasUnifiedOperation(
  db: Database.Database,
  taskId: string,
): { operation: ReturnType<typeof readOperation>; attempt: ReturnType<typeof readAttempt> | null } | null {
  const parent = readParent(db, taskId);
  if (!parent?.currentChannelKey) return null;
  const channel = readChannel(db, parent.id, parent.currentChannelKey);
  if (!channel?.operationId) return null;
  const operation = readOperation(db, channel.operationId);
  return {
    operation,
    attempt: operation.currentAttemptId ? readAttempt(db, operation.currentAttemptId) : null,
  };
}

export function recordCanvasUnifiedAccepted(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
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

export function recordCanvasUnifiedRemoteId(
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

export function recordCanvasUnifiedConfirmedNotCreated(
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

export function recordCanvasUnifiedUnknown(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
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

export function recordCanvasUnifiedDownloadFailure(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
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

export function recordCanvasUnifiedSucceeded(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
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

export function recordCanvasUnifiedFinalFailure(
  db: Database.Database,
  execution: CanvasUnifiedExecution,
  input: { code: string; message: string },
): void {
  const at = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE execution_media_channels SET state = 'failed', evidenceJson = ?, updatedAt = ?
      WHERE id = ?`).run(JSON.stringify({
      kind: 'task_failed', code: input.code, message: input.message, at,
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

export function recordCanvasUnifiedCanceled(
  db: Database.Database,
  execution: CanvasUnifiedExecution | null,
): void {
  if (!execution) return;
  cancelParent(db, execution.parent, execution.channel);
}

export function readCanvasUnifiedParent(
  db: Database.Database,
  taskId: string,
): { parent: MediaTaskRow; channel: MediaChannelRow | null } | null {
  const parent = readParent(db, taskId);
  return parent ? { parent, channel: currentChannel(db, parent) } : null;
}
