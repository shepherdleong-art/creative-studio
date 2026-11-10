import { createHash } from 'node:crypto';
import { requireAccessContext, runWithTaskAccessContext } from '../media-core/access-context.ts';
import type {
  AttemptRecord,
  ExecutionFacade,
  InstanceFence,
  OperationRecord,
} from '../media-core/execution/context.ts';
import { readAttempt, readOperation } from '../media-core/execution/records.ts';
import { configuredProviderPool } from '../media-core/execution/configured-provider-pool.ts';
import { recordCanvasTaskLog } from './logs.ts';
import { recordCanvasVideoMetadata } from './video-metadata.ts';
/**
 * 任务执行器（技术约定 C4／C5）。
 *
 * 一次提交的顺序（红线）：
 * 1. 领取任务与名额、固定本地 lease／fence，校验素材；
 * 2. 在任何生成 POST 之前，以当前 fence、leaseOwner、取消状态为条件持久化 submitting + maybe_sent，
 *    条件更新失败就**不发送**；
 * 3. 拿到远端任务 ID 立即保存，之后才查询／下载；
 * 4. 响应不明保守记 uncertain（保留可能占用的名额），只有明确未发送才算普通失败；
 * 5. 输出先落任务专属临时文件、校验，再登记为不可变资产，最后按 epoch／activeTaskId 发布到原节点。
 *
 * 执行器不依赖前端计时器：HTTP 启动的任务由后端调度器推进。
 */

import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import {
  canvasAssetAbsolutePath,
  canvasStorageRoot,
  registerCanvasResultAsset,
  importCanvasAsset,
  type CanvasAssetRecord,
} from './assets.ts';
import { CanvasAdapterError, type CanvasResolvedInput, type CanvasTaskAdapter, type CanvasTaskContext } from './adapters/types.ts';
import { findGraphNode } from './graph.ts';
import { publishCanvasNodeResult, requireCanvas } from './repository.ts';
import {
  getCanvasTask,
  listCanvasTaskInputs,
  updateCanvasTaskGuarded,
  type CanvasTaskRecord,
} from './tasks.ts';
import { canvasTaskActualCost, canvasTaskCostQuote, recordCanvasTaskUsage } from './usage.ts';
import { isTerminalTaskPhase, type CanvasGenerationMode, type CanvasTaskPhase } from './types.ts';
import {
  classifyCanvasSubmissionFailure,
  classifySubmissionOutcome,
  type SubmissionEvidence,
  type SubmissionStage,
} from '../media-core/submission-evidence.ts';
import { unifiedMediaDisplayName } from '../media-core/unified-media/catalog.ts';
import {
  activateCanvasUnifiedChannel,
  assertCanvasUnifiedSubmissionStillCurrent,
  CanvasUnifiedCanceledError,
  CanvasUnifiedRequeueError,
  CanvasUnifiedStaleError,
  CanvasUnifiedTerminalError,
  CanvasUnifiedWaitingError,
  currentCanvasUnifiedOperation,
  handleCanvasUnifiedCapacityDeferred,
  handleCanvasUnifiedExplicitFailure,
  isCanvasUnifiedMediaTask,
  prepareCanvasUnifiedMediaExecution,
  recordCanvasUnifiedAccepted,
  recordCanvasUnifiedCanceled,
  recordCanvasUnifiedDownloadFailure,
  recordCanvasUnifiedFinalFailure,
  recordCanvasUnifiedOperation,
  recordCanvasUnifiedUnknown,
  recordCanvasUnifiedSucceeded,
  releaseCanvasUnifiedPreparation,
  type CanvasUnifiedMediaExecution,
} from './unified-media.ts';

export interface CanvasTaskExecution {
  facade: ExecutionFacade;
  instance: InstanceFence;
}

export interface RunCanvasTaskOptions {
  db: Database.Database;
  taskId: string;
  adapter: CanvasTaskAdapter;
  execution?: CanvasTaskExecution;
  workerId: string;
  fence: number;
  storageRoot?: string;
  signal?: AbortSignal;
  now?: () => Date;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CanvasRunTaskOutcome {
  taskId: string;
  phase: CanvasTaskPhase;
  outputAssetId: string | null;
  published: boolean;
  errorCode: string | null;
}

function jsonObject<T>(raw: string, fallback: T): T {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as T : fallback;
  } catch {
    return fallback;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function resolveInputKind(
  db: Database.Database,
  canvasId: string,
  sourceNodeId: string | null,
  fallbackAssetId: string | null,
): CanvasResolvedInput['kind'] {
  if (fallbackAssetId) {
    const asset = db.prepare(`SELECT mediaKind FROM creative_canvas_assets WHERE id = ?`).get(fallbackAssetId) as
      | { mediaKind: string } | undefined;
    if (asset?.mediaKind) return asset.mediaKind as CanvasResolvedInput['kind'];
  }
  if (!sourceNodeId) {
    const asset = fallbackAssetId
      ? db.prepare(`SELECT mediaKind FROM creative_canvas_assets WHERE id = ?`).get(fallbackAssetId) as
        | { mediaKind: string }
        | undefined
      : undefined;
    return (asset?.mediaKind as CanvasResolvedInput['kind']) ?? 'image';
  }
  const graph = requireCanvas(db, canvasId).graph;
  const node = findGraphNode(graph, sourceNodeId);
  if (node?.kind === 'material') return node.data.mediaKind;
  if (node?.kind === 'image-generation') return 'image';
  if (node?.kind === 'video-generation') return 'video';
  return 'text';
}

/** 解析任务输入：等待上游的输入只认那一次绑定的产物，不读节点后来更新的当前结果。 */
export function buildCanvasTaskContext(
  db: Database.Database,
  task: CanvasTaskRecord,
): CanvasTaskContext & { unresolved: string[] } {
  const provider = jsonObject<{ capabilityKey?: string; providerIdentity?: string; modelAlias?: string }>(
    task.providerSnapshot,
    {},
  );
  const parameters = jsonObject<{
    generationMode?: CanvasGenerationMode;
    prompt?: string;
    parameters?: Record<string, string | number | boolean>;
  }>(task.parameterSnapshot, {});

  const unresolved: string[] = [];
  const inputs: CanvasResolvedInput[] = listCanvasTaskInputs(db, task.id).map((record) => {
    const fixedAssetId = record.assetId ?? record.resolvedAssetId;
    let mimeType: string | null = null;
    let byteSize: number | null = null;
    let durationSec: number | null = null;
    if (fixedAssetId) {
      const row = db.prepare(
        `SELECT mimeType, byteSize, durationSec FROM creative_canvas_assets WHERE id = ?`,
      ).get(fixedAssetId) as { mimeType: string; byteSize: number; durationSec: number | null } | undefined;
      mimeType = row ? row.mimeType : null;
      byteSize = row ? Number(row.byteSize) : null;
      durationSec = row && row.durationSec !== null ? Number(row.durationSec) : null;
    } else if (record.upstreamTaskId && !record.resolvedAssetId) {
      unresolved.push(record.refId);
    }
    return {
      refId: record.refId,
      orderIndex: record.orderIndex,
      role: record.role,
      note: record.note,
      kind: record.textContent !== null
        ? 'text'
        : resolveInputKind(db, task.canvasId, record.sourceNodeId, fixedAssetId),
      assetId: fixedAssetId,
      absolutePath: null,
      mimeType,
      byteSize,
      durationSec,
      textContent: record.textContent,
      upstreamTaskId: record.upstreamTaskId,
      record,
    };
  });

  return {
    task,
    mediaKind: task.mediaKind,
    generationMode: parameters.generationMode ?? (task.mediaKind === 'image' ? 'image-to-image' : 'image-to-video'),
    prompt: parameters.prompt ?? '',
    parameters: parameters.parameters ?? {},
    capabilityKey: provider.capabilityKey ?? task.quotaKey ?? '',
    providerIdentity: provider.providerIdentity ?? '',
    modelAlias: provider.modelAlias ?? '',
    inputs,
    unresolved,
  };
}

function currentCanvasExecution(db: Database.Database, taskId: string): {
  operation: OperationRecord;
  attempt: AttemptRecord | null;
} | null {
  const unified = currentCanvasUnifiedOperation(db, taskId);
  if (unified) return unified;
  const row = db.prepare(`
    SELECT id FROM execution_operations WHERE module = 'canvas' AND taskId = ?
    ORDER BY createdAt DESC LIMIT 1
  `).get(taskId) as { id: string } | undefined;
  if (!row) return null;
  const operation = readOperation(db, row.id);
  return {
    operation,
    attempt: operation.currentAttemptId ? readAttempt(db, operation.currentAttemptId) : null,
  };
}

function canvasOperationInput(
  task: CanvasTaskRecord,
  context: CanvasTaskContext,
  unifiedRoute?: {
    mediaTaskId: string;
    channelKey: string;
    executionRevision: number;
  },
) {
  const generationStage = typeof context.parameters.generationStage === 'string'
    ? context.parameters.generationStage
    : 'direct';
  const baseRevision = `epoch-${task.nodeEpoch}-variant-${task.variantIndex}-stage-${generationStage}`;
  const inputRevision = unifiedRoute
    ? `${baseRevision}-channel-${unifiedRoute.channelKey}-r${unifiedRoute.executionRevision}`
    : baseRevision;
  const inputSnapshot = {
    nodeId: task.nodeId,
    nodeEpoch: task.nodeEpoch,
    variantIndex: task.variantIndex,
    generationStage,
    providerSnapshot: JSON.parse(task.providerSnapshot) as unknown,
    parameterSnapshot: JSON.parse(task.parameterSnapshot) as unknown,
    inputs: context.inputs.map((input) => ({
      refId: input.refId,
      orderIndex: input.orderIndex,
      role: input.role,
      assetId: input.assetId,
      upstreamTaskId: input.upstreamTaskId,
      textContent: input.textContent,
    })),
    ...(unifiedRoute ? {
      route: {
        mediaTaskId: unifiedRoute.mediaTaskId,
        channelKey: unifiedRoute.channelKey,
        executionRevision: unifiedRoute.executionRevision,
      },
    } : {}),
  };
  return {
    inputRevision,
    inputSnapshot,
    inputHash: createHash('sha256').update(JSON.stringify(inputSnapshot)).digest('hex'),
  };
}

function executionWaitMessage(reason: string): string {
  const messages: Record<string, string> = {
    maintenance: '服务维护中，新付费生成已暂停；已受理结果会继续收取。',
    actor_disabled: '账号已停用，新付费生成已暂停；已受理结果会继续收取。',
    scope_forbidden: '当前资源已停止新的付费生成。',
    actor_paused: '成员已暂停新的付费生成；已受理结果会继续收取。',
    personal_concurrency: '等待个人云端生成名额，尚未提交。',
    pool_missing: '公共生成池尚未配置，尚未提交。',
    pool_disabled: '公共生成池已停用，尚未提交。',
    pool_capacity: '等待公共云端生成名额，尚未提交。',
    pricing_required: '缺少可信价格，等待管理员补齐后再提交。',
    monthly_budget: '本月费用额度不足，尚未提交。',
    cost_unknown: '上一笔费用仍待核查，暂不能开始新的付费生成。',
  };
  return messages[reason] ?? '等待统一执行准入，尚未提交。';
}

function canvasFailureEvidence(
  task: CanvasTaskRecord,
  adapter: CanvasTaskAdapter,
  stage: SubmissionStage,
  error: unknown,
  remoteId?: string | null,
): SubmissionEvidence {
  return classifyCanvasSubmissionFailure({
    taskId: task.id,
    businessAttemptNo: 1,
    adapterId: adapter.kind,
    stage,
    source: stage === 'download' ? 'persisted' : 'adapter',
    error,
    remoteId,
  });
}

function canvasTerminalEvidence(
  task: CanvasTaskRecord,
  adapter: CanvasTaskAdapter,
  outcome: 'terminal_failed' | 'terminal_succeeded',
  remoteId: string | null,
  errorCode?: string | null,
): SubmissionEvidence {
  return classifySubmissionOutcome({
    entry: 'canvas',
    taskId: task.id,
    businessAttemptNo: 1,
    adapterId: adapter.kind,
    stage: 'poll',
    source: 'provider',
    outcome,
    remoteId,
    errorCode,
  });
}

function assetAbsolutePath(db: Database.Database, assetId: string, storageRoot: string): string {
  const row = db.prepare(
    `SELECT id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, width, height, durationSec, sourceTaskId, ready, createdAt
       FROM creative_canvas_assets WHERE id = ?`,
  ).get(assetId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`素材不存在：${assetId}`);
  return canvasAssetAbsolutePath({
    id: String(row.id),
    canvasId: String(row.canvasId),
    mediaKind: row.mediaKind as 'image' | 'video' | 'audio',
    relativePath: String(row.relativePath),
    contentHash: String(row.contentHash),
    mimeType: String(row.mimeType),
    byteSize: Number(row.byteSize),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    durationSec: row.durationSec === null || row.durationSec === undefined ? null : Number(row.durationSec),
    sourceTaskId: row.sourceTaskId === null || row.sourceTaskId === undefined ? null : String(row.sourceTaskId),
    ready: Number(row.ready) === 1,
    createdAt: String(row.createdAt),
  }, storageRoot);
}

function publishCanvasNodeResultInTransaction(
  db: Database.Database,
  params: { canvasId: string; nodeId: string; taskId: string; nodeEpoch: number; assetId: string; at: string },
): boolean {
  return publishCanvasNodeResult({
    db,
    canvasId: params.canvasId,
    nodeId: params.nodeId,
    taskId: params.taskId,
    nodeEpoch: params.nodeEpoch,
    assetId: params.assetId,
    now: () => new Date(params.at),
  }).published;
}

interface OwnedOutputCommitResult {
  owned: boolean;
  valid: boolean;
  published: boolean;
}

/**
 * Re-publish an output already recorded by a previous worker. The task guard,
 * terminal task update, and node publication share one immediate transaction.
 */
function commitRecordedOutput(
  db: Database.Database,
  params: {
    task: CanvasTaskRecord;
    outputAssetId: string;
    guard: { fence: number; workerId: string };
    now: () => Date;
  },
): OwnedOutputCommitResult {
  const commit = db.transaction((): OwnedOutputCommitResult => {
    const owned = db.prepare(`
      SELECT 1
        FROM creative_canvas_tasks
       WHERE id = ? AND canvasId = ? AND fence = ? AND leaseOwner = ?
    `).get(params.task.id, params.task.canvasId, params.guard.fence, params.guard.workerId);
    if (!owned) return { owned: false, valid: false, published: false };

    const asset = db.prepare(`
      SELECT 1
        FROM creative_canvas_assets
       WHERE id = ? AND canvasId = ? AND sourceTaskId = ? AND ready = 1
    `).get(params.outputAssetId, params.task.canvasId, params.task.id);
    if (!asset) return { owned: true, valid: false, published: false };

    const at = params.now().toISOString();
    const updated = db.prepare(`
      UPDATE creative_canvas_tasks
         SET phase = 'succeeded', submissionState = 'terminal', outputAssetId = ?,
             errorCode = NULL, errorMessage = NULL, leaseOwner = NULL, leaseUntil = NULL,
             slotHeld = 0, updatedAt = ?
       WHERE id = ? AND canvasId = ? AND fence = ? AND leaseOwner = ?
    `).run(
      params.outputAssetId,
      at,
      params.task.id,
      params.task.canvasId,
      params.guard.fence,
      params.guard.workerId,
    );
    if (updated.changes !== 1) return { owned: false, valid: false, published: false };
    const published = publishCanvasNodeResultInTransaction(db, {
      canvasId: params.task.canvasId,
      nodeId: params.task.nodeId,
      taskId: params.task.id,
      nodeEpoch: params.task.nodeEpoch,
      assetId: params.outputAssetId,
      at,
    });
    recordCanvasTaskLog(db, getCanvasTask(db, params.task.id)!, params.task);
    return { owned: true, valid: true, published };
  });
  return commit.immediate();
}

export async function runCanvasTask(options: RunCanvasTaskOptions): Promise<CanvasRunTaskOutcome> {
  return runWithTaskAccessContext(options.db, 'canvas', options.taskId, () => runAuthorizedCanvasTask(options));
}

async function runAuthorizedCanvasTask(options: RunCanvasTaskOptions): Promise<CanvasRunTaskOutcome> {
  const {
    db,
    taskId,
    adapter,
    workerId,
    fence,
    signal,
    now = () => new Date(),
    pollIntervalMs = 1_000,
    maxPollAttempts = 600,
    sleep = defaultSleep,
  } = options;
  const storageRoot = options.storageRoot ?? canvasStorageRoot(dataRoot());
  const guard = { fence, workerId };

  const task = getCanvasTask(db, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (isTerminalTaskPhase(task.phase)) {
    return { taskId, phase: task.phase, outputAssetId: task.outputAssetId, published: false, errorCode: task.errorCode };
  }

  const context = buildCanvasTaskContext(db, task);
  if (context.unresolved.length > 0) {
    // 输入还没就绪：退回等待，不占名额、也不提交
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: { phase: 'waiting_input', leaseOwner: null, leaseUntil: null },
      guard,
      now,
    });
    return { taskId, phase: 'waiting_input', outputAssetId: null, published: false, errorCode: null };
  }
  // 补齐绝对路径（构建上下文时只带了资产身份，这里统一解析）
  context.inputs = context.inputs.map((input) => (
    input.assetId ? { ...input, absolutePath: assetAbsolutePath(db, input.assetId, storageRoot) } : input
  ));
  let unifiedExecution: CanvasUnifiedMediaExecution | null = null;
  let unifiedOperationId: string | null = null;
  let executionContext: CanvasTaskContext = context;
  let effectiveTask: CanvasTaskRecord = task;
  const unifiedTask = isCanvasUnifiedMediaTask(task);
  const unifiedTaskName = (() => {
    try {
      return unifiedMediaDisplayName(
        (JSON.parse(task.providerSnapshot) as { unifiedModel?: unknown }).unifiedModel,
      ) ?? '统一模型';
    } catch {
      return '统一模型';
    }
  })();
  const resuming = task.providerTaskId !== null;

  const finish = (phase: CanvasTaskPhase, extra: Partial<CanvasRunTaskOutcome> = {}): CanvasRunTaskOutcome => {
    const latest = getCanvasTask(db, taskId);
    return {
      taskId,
      phase,
      outputAssetId: latest?.outputAssetId ?? null,
      published: false,
      errorCode: latest?.errorCode ?? null,
      ...extra,
    };
  };

  let executionAttempt = options.execution
    ? currentCanvasExecution(db, taskId)?.attempt ?? null
    : null;
  const captureFailure = (stage: 'remote_submit' | 'remote_poll' | 'download' | 'storage', code: string): void => {
    if (!options.execution) return;
    void options.execution.facade.captureError({
      attemptId: executionAttempt?.id,
      taskId, module: 'canvas', actorUserId: requireAccessContext().actor.userId,
      scope: { resourceType: 'canvas', resourceId: task.canvasId },
      outcome: 'failed', errorCode: code, stage,
      eventKey: executionAttempt ? undefined : `canvas:${taskId}:${stage}:${code}`,
    });
  };

  const deferExecution = (reason: string, message?: string): CanvasRunTaskOutcome => {
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'queued', submissionState: 'not_sent', errorCode: reason,
        errorMessage: message ?? executionWaitMessage(reason), leaseOwner: null, leaseUntil: null,
      },
      guard,
      now,
    });
    return finish('queued');
  };
  const requeueUnified = (message: string, reason = 'fallback_pending'): CanvasRunTaskOutcome => {
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'queued', submissionState: 'not_sent', providerTaskId: null,
        errorCode: reason, errorMessage: message, leaseOwner: null, leaseUntil: null,
      },
      guard,
      now,
    });
    return finish('queued');
  };
  const cancelBeforeSubmit = (): CanvasRunTaskOutcome => {
    recordCanvasUnifiedCanceled(db, unifiedExecution);
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'cancelled', submissionState: 'terminal', errorCode: 'cancelled',
        errorMessage: '用户已停止该任务，未发起新的付费提交。', leaseOwner: null, leaseUntil: null,
      },
      guard,
      now,
    });
    db.prepare(`
      UPDATE creative_canvas_node_states SET activeTaskId = NULL, updatedAt = ?
      WHERE canvasId = ? AND nodeId = ? AND activeTaskId = ?
    `).run(now().toISOString(), task.canvasId, task.nodeId, task.id);
    return finish('cancelled');
  };

  if (unifiedTask) {
    try {
      unifiedExecution = prepareCanvasUnifiedMediaExecution(db, task, context, {
        resuming,
        now: now(),
      });
      executionContext = unifiedExecution.effectiveContext;
      effectiveTask = unifiedExecution.effectiveTask;
    } catch (error) {
      if (error instanceof CanvasUnifiedWaitingError) {
        const message = error.waitReason === 'pool_capacity'
          ? (unifiedExecution?.mediaKind === 'video'
            ? '等待可用资源（供应商名额已满，释放后自动继续）。'
            : '等待可用资源（供应商名额已满，达到拥堵阈值后自动继续）。')
          : executionWaitMessage(error.waitReason);
        return deferExecution(error.waitReason, message);
      }
      if (error instanceof CanvasUnifiedRequeueError) {
        return deferExecution(error.reason, error.message);
      }
      if (error instanceof CanvasUnifiedCanceledError) {
        return cancelBeforeSubmit();
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof CanvasUnifiedTerminalError ? error.code : 'unified_route_failed';
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'failed', submissionState: 'terminal',
          errorCode: code, errorMessage: message, leaseOwner: null, leaseUntil: null,
        },
        guard,
        now,
      });
      return finish('failed');
    }
  }

  // 1. 素材交付：失败说明还没提交，按普通失败结束
  try {
    if (!resuming) await adapter.prepare(executionContext, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (unifiedExecution) recordCanvasUnifiedFinalFailure(db, unifiedExecution, {
      code: error instanceof CanvasAdapterError ? error.code : 'prepare_failed',
      message,
    });
    captureFailure('storage', error instanceof CanvasAdapterError ? error.code : 'prepare_failed');
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'failed',
        submissionState: 'terminal',
        errorCode: error instanceof CanvasAdapterError ? error.code : 'prepare_failed',
        errorMessage: message,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    return finish('failed');
  }

  // 2. 提交意图落库：只有本次条件更新成功才发送
  let providerTaskId: string;
  if (resuming) {
    providerTaskId = task.providerTaskId as string;
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: { phase: 'polling' },
      guard,
      now,
    });
  } else if (options.execution) {
    const execution = options.execution;
    const operationInput = canvasOperationInput(effectiveTask, executionContext,
      unifiedExecution ? {
        mediaTaskId: unifiedExecution.parent.id,
        channelKey: unifiedExecution.channel.channelKey,
        executionRevision: unifiedExecution.channel.executionRevision,
      } : undefined);
    let admission;
    let enqueuedOperationId: string | null = null;
    try {
      const enqueued = execution.facade.enqueue({
        operationKey: `canvas/${effectiveTask.id}/submit/${operationInput.inputRevision}`,
        actor: { userId: requireAccessContext().actor.userId },
        scope: { resourceType: 'canvas', resourceId: effectiveTask.canvasId },
        module: 'canvas', taskId: effectiveTask.id, step: 'submit', inputRevision: operationInput.inputRevision,
        businessAttempt: {
          id: effectiveTask.id,
          number: unifiedExecution?.channel.executionRevision ?? 1,
        },
        inputSnapshot: operationInput.inputSnapshot,
        inputHash: operationInput.inputHash,
        continuationKey: 'canvas.submit',
        providerSnapshot: JSON.parse(effectiveTask.providerSnapshot) as unknown,
        configVersion: createHash('sha256').update(effectiveTask.providerSnapshot).digest('hex'),
        credentialVersionRef: executionContext.providerIdentity,
        requiredPools: [
          configuredProviderPool(db, executionContext.mediaKind, executionContext.providerIdentity)
            ?? `${executionContext.providerIdentity}:remote`,
        ],
        quote: canvasTaskCostQuote(db, effectiveTask),
        mediaTaskId: unifiedExecution?.parent.id ?? null,
        channelKey: unifiedExecution?.channel.channelKey ?? null,
      });
      enqueuedOperationId = enqueued.operation.id;
      if (unifiedExecution) {
        unifiedOperationId = enqueued.operation.id;
        recordCanvasUnifiedOperation(db, unifiedExecution, enqueued.operation.id);
      }
      admission = execution.facade.admit({ ...execution.instance, operationId: enqueued.operation.id });
    } catch (error) {
      if (unifiedExecution) releaseCanvasUnifiedPreparation(db, unifiedExecution);
      const reason = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'execution_not_ready';
      return deferExecution(reason);
    }
    if (admission.kind !== 'admitted') {
      if (unifiedExecution && admission.kind === 'deferred') {
        const capacity = handleCanvasUnifiedCapacityDeferred(db, unifiedExecution, {
          reasons: admission.reasons,
          operationId: enqueuedOperationId,
          now: now(),
        });
        if (capacity.outcome === 'waiting') {
          return deferExecution(
            'pool_capacity',
            unifiedExecution.mediaKind === 'video'
              ? '等待可用资源（供应商名额已满，释放后自动继续）。'
              : '等待可用资源（供应商名额已满，达到拥堵阈值后自动继续）。',
          );
        }
        if (capacity.outcome === 'overflowed') {
          return requeueUnified(
            unifiedExecution.mediaKind === 'video'
              ? '七牛名额已满，已立即使用腾讯备用通道。'
              : '七牛名额持续拥堵，已允许使用腾讯备用通道。',
          );
        }
        if (capacity.outcome === 'canceled') return cancelBeforeSubmit();
        if (capacity.outcome === 'not_capacity') {
          releaseCanvasUnifiedPreparation(db, unifiedExecution);
        }
      } else if (unifiedExecution) {
        releaseCanvasUnifiedPreparation(db, unifiedExecution);
      }
      if (unifiedExecution && admission.kind === 'idle') {
        releaseCanvasUnifiedPreparation(db, unifiedExecution);
      }
      return deferExecution(
        admission.kind === 'deferred' ? admission.reasons[0] ?? 'execution_deferred' : 'execution_deferred',
      );
    }
    if (unifiedExecution) activateCanvasUnifiedChannel(db, unifiedExecution);
    const submittedIntent = updateCanvasTaskGuarded(db, {
      taskId,
      patch: { phase: 'submitting', submissionState: 'not_sent' },
      guard,
      now,
    });
    if (!submittedIntent) {
      await execution.facade.settle({
        attemptId: admission.grant.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
      }).catch(() => undefined);
      const current = getCanvasTask(db, taskId);
      if (current?.phase === 'cancelled' || current?.cancelRequestedAt) return cancelBeforeSubmit();
      return finish(current?.phase ?? 'queued');
    }
    let intent;
    try {
      intent = await execution.facade.markSubmitting({
        grant: admission.grant,
        requestSnapshot: operationInput.inputSnapshot,
      });
    } catch (error) {
      await execution.facade.settle({
        attemptId: admission.grant.attempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
      }).catch(() => undefined);
      if (unifiedExecution) releaseCanvasUnifiedPreparation(db, unifiedExecution);
      const reason = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'execution_not_ready';
      return deferExecution(reason);
    }
    if (unifiedExecution) {
      try {
        assertCanvasUnifiedSubmissionStillCurrent(db, unifiedExecution);
      } catch (error) {
        await execution.facade.settle({
          attemptId: admission.grant.attempt.id,
          outcome: 'not_created',
          actualCost: null,
          remoteTerminal: true,
          errorCode: error instanceof CanvasUnifiedCanceledError ? 'cancelled' : 'route_changed',
        }).catch(() => undefined);
        if (error instanceof CanvasUnifiedCanceledError) return cancelBeforeSubmit();
        releaseCanvasUnifiedPreparation(db, unifiedExecution);
        return deferExecution(
          error instanceof CanvasUnifiedStaleError ? 'route_changed' : 'execution_not_ready',
          error instanceof Error ? error.message : undefined,
        );
      }
    }
    if (!updateCanvasTaskGuarded(db, {
      taskId,
      patch: { submissionState: 'maybe_sent' },
      guard,
      now,
    })) {
      return finish(getCanvasTask(db, taskId)?.phase ?? 'uncertain');
    }

    let submittedProviderTaskId: string | null = null;
    let submitFailure: { code: string; message: string } | null = null;
    try {
      executionAttempt = await execution.facade.transmit(intent, async () => {
        if (getCanvasTask(db, taskId)?.cancelRequestedAt) {
          submitFailure = { code: 'cancelled', message: '用户已停止该任务，未发起新的付费提交。' };
          return { terminalState: 'not_created', errorCode: 'cancelled' };
        }
        if (unifiedExecution) {
          try {
            assertCanvasUnifiedSubmissionStillCurrent(db, unifiedExecution);
          } catch (error) {
            submitFailure = {
              code: error instanceof CanvasUnifiedCanceledError ? 'cancelled' : 'route_changed',
              message: error instanceof Error ? error.message : String(error),
            };
            return { terminalState: 'not_created', errorCode: submitFailure.code };
          }
        }
        try {
          const submitted = await adapter.submit(executionContext, signal);
          if (!submitted.providerTaskId && !submitted.terminalState) {
            throw new CanvasAdapterError('submit', '供应商没有返回任务身份，提交结果不明。', {
              uncertain: true,
              code: 'submit_receipt_missing',
            });
          }
          submittedProviderTaskId = submitted.providerTaskId;
          return {
            remoteId: submitted.providerTaskId,
            ...(submitted.terminalState ? { terminalState: submitted.terminalState } : {}),
          };
        } catch (error) {
          const evidence = canvasFailureEvidence(task, adapter, 'submit', error);
          if (evidence.state !== 'confirmed_not_created') throw error;
          const code = evidence.error?.code ?? 'submit_rejected';
          submitFailure = { code, message: evidence.employee.detail };
          return { terminalState: 'not_created', errorCode: code };
        }
      });
    } catch (error) {
      const evidence = canvasFailureEvidence(task, adapter, 'submit', error);
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'uncertain', submissionState: 'maybe_sent',
          errorCode: evidence.error?.code ?? 'submit_uncertain',
          errorMessage: evidence.employee.detail,
          leaseOwner: null, leaseUntil: null,
        },
        guard,
        now,
      });
      if (unifiedExecution) {
        recordCanvasUnifiedUnknown(db, unifiedExecution, evidence, executionAttempt?.remoteId ?? null);
      }
      return finish('uncertain');
    }
    if (executionAttempt.terminalState === 'not_created') {
      const failure = submitFailure as { code: string; message: string } | null;
      await execution.facade.settle({
        attemptId: executionAttempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
        errorCode: failure?.code,
      });
      if (failure?.code === 'cancelled') return cancelBeforeSubmit();
      if (failure?.code === 'route_changed') {
        if (unifiedExecution) releaseCanvasUnifiedPreparation(db, unifiedExecution);
        return deferExecution('route_changed', failure.message);
      }
      if (unifiedExecution) {
        let decision;
        try {
          const evidence = classifySubmissionOutcome({
            entry: 'canvas',
            taskId: task.id,
            businessAttemptNo: executionAttempt.businessAttemptNo,
            adapterId: adapter.kind,
            stage: 'submit',
            source: 'adapter',
            outcome: 'confirmed_not_created',
            remoteId: executionAttempt.remoteId,
            errorCode: failure?.code ?? 'submit_rejected',
          });
          decision = handleCanvasUnifiedExplicitFailure(db, task, {
            evidence,
            attemptId: executionAttempt.id,
            operationId: enqueuedOperationId ?? undefined,
            channelKey: unifiedExecution.channel.channelKey,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCanvasUnifiedFinalFailure(db, unifiedExecution, {
            code: 'fallback_decision_failed', message,
          });
          updateCanvasTaskGuarded(db, {
            taskId,
            patch: {
              phase: 'failed', submissionState: 'terminal',
              errorCode: 'fallback_decision_failed', errorMessage: message,
              leaseOwner: null, leaseUntil: null,
            },
            guard,
            now,
          });
          return finish('failed');
        }
        if (decision.outcome === 'next_channel') {
          return requeueUnified(
            `${unifiedTaskName} ${decision.previousChannelKey} 通道明确未创建，已切换到 ${decision.nextChannelKey}。`,
          );
        }
        if (decision.outcome === 'canceled') return cancelBeforeSubmit();
      }
      captureFailure('remote_submit', failure?.code ?? 'submit_failed');
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'failed', submissionState: 'terminal',
          errorCode: failure?.code ?? 'submit_failed',
          errorMessage: failure?.message ?? '供应商未创建任务。',
          leaseOwner: null, leaseUntil: null,
        },
        guard,
        now,
      });
      return finish('failed');
    }
    if (executionAttempt.terminalState === 'succeeded') {
      executionAttempt = await execution.facade.settle({
        attemptId: executionAttempt.id,
        outcome: 'succeeded', actualCost: canvasTaskActualCost(db, effectiveTask), remoteTerminal: true,
      });
    }
    if (!submittedProviderTaskId) throw new Error('执行回执缺少远端任务身份。');
    providerTaskId = submittedProviderTaskId;
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: { providerTaskId, submissionState: 'accepted', phase: 'polling', errorCode: null, errorMessage: null },
      guard,
      now,
    });
    if (unifiedExecution) recordCanvasUnifiedAccepted(db, unifiedExecution, providerTaskId);
    recordCanvasTaskUsage(db, {
      taskId,
      executionAttemptId: executionAttempt?.id,
      ...(unifiedExecution ? { providerSnapshot: unifiedExecution.providerSnapshotJson } : {}),
    });
  } else {
    const submittedIntent = updateCanvasTaskGuarded(db, {
      taskId,
      patch: { phase: 'submitting', submissionState: 'maybe_sent' },
      guard,
      now,
    });
    if (!submittedIntent) {
      const current = getCanvasTask(db, taskId);
      if (current?.phase === 'cancelled' || current?.cancelRequestedAt) return cancelBeforeSubmit();
      return finish(current?.phase ?? 'queued');
    }
    if (getCanvasTask(db, taskId)?.cancelRequestedAt) return cancelBeforeSubmit();

    // 本地模式保留原有单次 POST 与恢复合同。
    try {
      const submitted = await adapter.submit(executionContext, signal);
      providerTaskId = submitted.providerTaskId;
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: { providerTaskId, submissionState: 'accepted', phase: 'polling', errorCode: null, errorMessage: null },
        guard,
        now,
      });
      recordCanvasTaskUsage(db, {
        taskId,
        executionAttemptId: executionAttempt?.id,
        ...(unifiedExecution ? { providerSnapshot: unifiedExecution.providerSnapshotJson } : {}),
      });
    } catch (error) {
      const evidence = canvasFailureEvidence(task, adapter, 'submit', error);
      const phase: CanvasTaskPhase = evidence.state === 'confirmed_not_created' ? 'failed' : 'uncertain';
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase,
          submissionState: phase === 'uncertain' ? 'maybe_sent' : 'terminal',
          errorCode: evidence.error?.code ?? (phase === 'uncertain' ? 'submit_uncertain' : 'submit_rejected'),
          errorMessage: evidence.employee.detail,
          leaseOwner: null,
          leaseUntil: null,
        },
        guard,
        now,
      });
      return finish(phase);
    }
  }

  // 4. 轮询远端（已保存远端 ID；本地超时不释放名额）
  let attempts = 0;
  const previousPollCount = getCanvasTask(db, taskId)?.pollCount ?? 0;
  let pollState: 'succeeded' | 'failed' | 'aborted' | 'cancelled' = 'aborted';
  let serverCancelAttempted = false;
  while (attempts < maxPollAttempts) {
    if (signal?.aborted) {
      pollState = 'aborted';
      break;
    }
    const current = getCanvasTask(db, taskId);
    if (current?.cancelRequestedAt && !options.execution) {
      pollState = 'cancelled';
      break;
    }
    if (current?.cancelRequestedAt && options.execution && adapter.cancel && !serverCancelAttempted) {
      serverCancelAttempted = true;
      let remoteCancelled = false;
      try {
        remoteCancelled = (await adapter.cancel({ ...executionContext, providerTaskId }, signal)).remoteCancelled;
      } catch {
        remoteCancelled = false;
      }
      if (remoteCancelled) {
        if (executionAttempt) {
          executionAttempt = await options.execution.facade.reconcile({
            attemptId: executionAttempt.id,
            evidence: { kind: 'terminal', outcome: 'failed', actualCost: null, errorCode: 'cancelled' },
            source: 'provider',
          });
        }
        updateCanvasTaskGuarded(db, {
          taskId,
          patch: {
            phase: 'cancelled', submissionState: 'terminal', errorCode: 'cancelled', errorMessage: null,
            leaseOwner: null, leaseUntil: null,
          },
          guard,
          now,
        });
        if (unifiedExecution) recordCanvasUnifiedCanceled(db, unifiedExecution);
        return finish('cancelled');
      }
      // server 上游未确认取消时继续收取已受理结果，permit 只能由终态结算释放。
    }
    await sleep(pollIntervalMs);
    attempts += 1;
    let outcome;
    try {
      outcome = await adapter.poll({ ...executionContext, providerTaskId }, signal);
    } catch (error) {
      // 查询失败不改写远端身份，继续按下一次轮询重试
      const evidence = canvasFailureEvidence(task, adapter, 'poll', error, providerTaskId);
      const pollErrorCode = evidence.error?.code ?? 'poll_failed';
      captureFailure('remote_poll', pollErrorCode);
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          lastPolledAt: now().toISOString(),
          pollCount: previousPollCount + attempts,
          errorCode: pollErrorCode,
          errorMessage: evidence.employee.detail,
        },
        guard,
        now,
      });
      continue;
    }
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: { lastPolledAt: now().toISOString(), pollCount: previousPollCount + attempts, errorCode: null, errorMessage: null },
      guard,
      now,
    });
    if (outcome.status === 'succeeded') {
      if (options.execution && executionAttempt) {
        executionAttempt = await options.execution.facade.reconcile({
          attemptId: executionAttempt.id,
          evidence: { kind: 'terminal', outcome: 'succeeded', actualCost: canvasTaskActualCost(db, effectiveTask) },
          source: 'provider',
        });
      }
      pollState = 'succeeded';
      break;
    }
    if (outcome.status === 'failed') {
      captureFailure('remote_poll', outcome.code ?? 'provider_failed');
      const evidence = canvasTerminalEvidence(task, adapter, 'terminal_failed', providerTaskId, outcome.code);
      if (options.execution && executionAttempt) {
        executionAttempt = await options.execution.facade.reconcile({
          attemptId: executionAttempt.id,
          evidence: { kind: 'terminal', outcome: 'failed', actualCost: null, errorCode: outcome.code },
          source: 'provider',
        });
      }
      if (unifiedExecution) {
        let decision;
        try {
          decision = handleCanvasUnifiedExplicitFailure(db, task, {
            evidence,
            attemptId: executionAttempt?.id,
            operationId: unifiedOperationId ?? undefined,
            channelKey: unifiedExecution.channel.channelKey,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordCanvasUnifiedFinalFailure(db, unifiedExecution, {
            code: 'fallback_decision_failed', message,
          });
          updateCanvasTaskGuarded(db, {
            taskId,
            patch: {
              phase: 'failed', submissionState: 'terminal',
              errorCode: 'fallback_decision_failed', errorMessage: message,
              leaseOwner: null, leaseUntil: null,
            },
            guard,
            now,
          });
          return finish('failed');
        }
        if (decision.outcome === 'next_channel') {
          return requeueUnified(
            `${unifiedTaskName} ${decision.previousChannelKey} 通道明确失败，已切换到 ${decision.nextChannelKey}。`,
          );
        }
        if (decision.outcome === 'canceled') {
          return cancelBeforeSubmit();
        }
      }
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'failed',
          submissionState: 'terminal',
          errorCode: evidence.error?.code ?? 'provider_failed',
          errorMessage: evidence.employee.detail,
          leaseOwner: null,
          leaseUntil: null,
        },
        guard,
        now,
      });
      return finish('failed');
    }
  }

  if (pollState === 'cancelled') {
    let remoteCancelled = false;
    if (adapter.cancel) {
      try {
        const cancelled = await adapter.cancel({ ...executionContext, providerTaskId }, signal);
        remoteCancelled = cancelled.remoteCancelled;
      } catch {
        remoteCancelled = false;
      }
    }
    const phase: CanvasTaskPhase = remoteCancelled ? 'cancelled' : 'uncertain';
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase,
        submissionState: remoteCancelled ? 'terminal' : 'accepted',
        errorCode: remoteCancelled ? 'cancelled' : 'cancel_unconfirmed',
        errorMessage: remoteCancelled ? null : '远端未确认取消，仍可能继续生成。',
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    return finish(phase);
  }

  if (pollState === 'aborted') {
    // 本地中止不改写远端身份；名额保留，交给恢复流程续查（P5）
    return finish(getCanvasTask(db, taskId)?.phase ?? 'polling');
  }

  // 输出文件已经落盘、只是发布事务没走完：接管同一份文件，绝不重新下载或生成。
  const recordedOutput = getCanvasTask(db, taskId)?.outputAssetId ?? null;
  if (recordedOutput) {
    const republished = commitRecordedOutput(db, { task, outputAssetId: recordedOutput, guard, now });
    if (!republished.owned) return finish(getCanvasTask(db, taskId)?.phase ?? 'polling');
    if (republished.valid) {
      if (unifiedExecution) {
        recordCanvasUnifiedSucceeded(db, unifiedExecution, {
          outputAssetId: recordedOutput,
          remoteId: providerTaskId,
        });
      }
      return {
        taskId,
        phase: 'succeeded',
        outputAssetId: recordedOutput,
        published: republished.published,
        errorCode: null,
      };
    }
  }

  updateCanvasTaskGuarded(db, {
    taskId,
    patch: { phase: 'downloading' },
    guard,
    now,
  });

  // 5. 下载 → 校验 → 登记不可变产物
  let downloaded;
  try {
    downloaded = await adapter.download({ ...executionContext, providerTaskId }, signal);
  } catch (error) {
    const evidence = canvasFailureEvidence(task, adapter, 'download', error, providerTaskId);
    captureFailure('download', evidence.error?.code ?? 'download_failed');
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'download_failed',
        errorCode: evidence.error?.code ?? 'download_failed',
        errorMessage: evidence.employee.detail,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    if (unifiedExecution) {
      recordCanvasUnifiedDownloadFailure(db, unifiedExecution, evidence);
    }
    return finish('download_failed');
  }

  let asset: CanvasAssetRecord | null;
  let published = false;
  try {
    if (downloaded.tailFrame && downloaded.videoMetadata) {
      const tail = await importCanvasAsset({ db, canvasId: task.canvasId, storageRoot, filename: `返回尾帧.${downloaded.tailFrame.mimeType === 'image/png' ? 'png' : downloaded.tailFrame.mimeType === 'image/webp' ? 'webp' : 'jpg'}`,
        mimeType: downloaded.tailFrame.mimeType, data: downloaded.tailFrame.bytes, now });
      downloaded.videoMetadata.tailAssetId = tail.id;
    }
    asset = await registerCanvasResultAsset({
      db,
      canvasId: task.canvasId,
      storageRoot,
      taskId,
      mediaKind: task.mediaKind,
      mimeType: downloaded.mimeType,
      data: downloaded.bytes,
      now,
      guard,
      commit: (transactionDb, registeredAsset) => {
        const at = now().toISOString();
        const recorded = transactionDb.prepare(`
          UPDATE creative_canvas_tasks
             SET phase = 'succeeded', submissionState = 'terminal', outputAssetId = ?,
                 errorCode = NULL, errorMessage = NULL, leaseOwner = NULL, leaseUntil = NULL,
                 slotHeld = 0, updatedAt = ?
           WHERE id = ? AND canvasId = ? AND fence = ? AND leaseOwner = ?
        `).run(
          registeredAsset.id,
          at,
          taskId,
          task.canvasId,
          guard.fence,
          guard.workerId,
        );
        if (recorded.changes !== 1) throw new Error('任务已失去租约，拒绝登记生成结果。');
        recordCanvasTaskLog(transactionDb, getCanvasTask(transactionDb, taskId)!, task);
        if (downloaded.videoMetadata) recordCanvasVideoMetadata(transactionDb, taskId, downloaded.videoMetadata);
        published = publishCanvasNodeResultInTransaction(transactionDb, {
          canvasId: task.canvasId,
          nodeId: task.nodeId,
          taskId,
          nodeEpoch: task.nodeEpoch,
          assetId: registeredAsset.id,
          at,
        });
      },
    });
    recordCanvasTaskUsage(db, {
      taskId,
      executionAttemptId: executionAttempt?.id,
      ...(unifiedExecution ? { providerSnapshot: unifiedExecution.providerSnapshotJson } : {}),
    });
    if (options.execution && executionAttempt?.actualMinor === null) {
      const actualCost = canvasTaskActualCost(db, effectiveTask);
      if (actualCost) {
        executionAttempt = await options.execution.facade.settle({
          attemptId: executionAttempt.id,
          outcome: 'succeeded', actualCost, remoteTerminal: true,
        });
      }
    }
  } catch (error) {
    if (getCanvasTask(db, taskId)?.cancelRequestedAt) {
      if (executionAttempt && options.execution) {
        await options.execution.facade.reconcile({
          attemptId: executionAttempt.id,
          evidence: { kind: 'terminal', outcome: 'failed', actualCost: null, errorCode: 'cancelled' },
          source: 'provider',
        }).catch(() => undefined);
      }
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'cancelled', submissionState: 'terminal', errorCode: 'cancelled',
          errorMessage: '用户已停止该任务，未保存后续结果。', leaseOwner: null, leaseUntil: null,
        }, guard, now,
      });
      return finish('cancelled');
    }
    const evidence = canvasFailureEvidence(task, adapter, 'download', error, providerTaskId);
    captureFailure('storage', 'output_validation_failed');
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'download_failed',
        errorCode: evidence.error?.code ?? 'output_validation_failed',
        errorMessage: evidence.employee.detail,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    if (unifiedExecution) {
      recordCanvasUnifiedDownloadFailure(db, unifiedExecution, evidence);
    }
    return finish('download_failed');
  }
  // registerCanvasResultAsset atomically checked the guard, inserted the asset,
  // completed the task, and attempted node publication. A stale worker only
  // leaves its private file cleanup and cannot touch any database row.
  if (!asset) {
    const latest = getCanvasTask(db, taskId);
    return finish(latest?.phase ?? 'polling');
  }
  if (unifiedExecution) {
    recordCanvasUnifiedSucceeded(db, unifiedExecution, {
      outputAssetId: asset.id,
      remoteId: providerTaskId,
    });
  }
  if (options.execution) {
    await options.execution.facade.captureRecovery({ taskId, module: 'canvas', stage: 'download' });
  }
  return {
    taskId,
    phase: 'succeeded',
    outputAssetId: asset.id,
    published,
    errorCode: null,
  };
}
