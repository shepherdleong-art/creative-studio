import { createHash } from 'node:crypto';
import { requireAccessContext, runWithTaskAccessContext } from '../media-core/access-context.ts';
import type {
  AttemptRecord,
  ExecutionFacade,
  InstanceFence,
  OperationRecord,
} from '../media-core/execution/context.ts';
import { readAttempt, readOperation } from '../media-core/execution/records.ts';
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

function canvasOperationInput(task: CanvasTaskRecord, context: CanvasTaskContext) {
  const generationStage = typeof context.parameters.generationStage === 'string'
    ? context.parameters.generationStage
    : 'direct';
  const inputRevision = `epoch-${task.nodeEpoch}-variant-${task.variantIndex}-stage-${generationStage}`;
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

  // 恢复路径：只要已经有远端身份，就绝不重新 prepare／POST，只续查原任务。
  const resuming = task.providerTaskId !== null;
  let executionAttempt = options.execution
    ? currentCanvasExecution(db, taskId)?.attempt ?? null
    : null;

  const deferExecution = (reason: string): CanvasRunTaskOutcome => {
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'queued', submissionState: 'not_sent', errorCode: reason,
        errorMessage: executionWaitMessage(reason), leaseOwner: null, leaseUntil: null,
      },
      guard,
      now,
    });
    return finish('queued');
  };
  const cancelBeforeSubmit = (): CanvasRunTaskOutcome => {
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

  // 1. 素材交付：失败说明还没提交，按普通失败结束
  try {
    if (!resuming) await adapter.prepare(context, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    const operationInput = canvasOperationInput(task, context);
    let admission;
    try {
      const enqueued = execution.facade.enqueue({
        operationKey: `canvas/${task.id}/submit/${operationInput.inputRevision}`,
        actor: { userId: requireAccessContext().actor.userId },
        scope: { resourceType: 'canvas', resourceId: task.canvasId },
        module: 'canvas', taskId: task.id, step: 'submit', inputRevision: operationInput.inputRevision,
        businessAttempt: { id: task.id, number: 1 },
        inputSnapshot: operationInput.inputSnapshot,
        inputHash: operationInput.inputHash,
        continuationKey: 'canvas.submit',
        providerSnapshot: JSON.parse(task.providerSnapshot) as unknown,
        configVersion: createHash('sha256').update(task.providerSnapshot).digest('hex'),
        credentialVersionRef: context.providerIdentity,
        requiredPools: [`${context.providerIdentity}:remote`],
        quote: canvasTaskCostQuote(db, task),
      });
      admission = execution.facade.admit({ ...execution.instance, operationId: enqueued.operation.id });
    } catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'execution_not_ready';
      return deferExecution(reason);
    }
    if (admission.kind !== 'admitted') {
      return deferExecution(admission.kind === 'deferred' ? admission.reasons[0] ?? 'execution_deferred' : 'execution_deferred');
    }
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
      const reason = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'execution_not_ready';
      return deferExecution(reason);
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
        try {
          const submitted = await adapter.submit(context, signal);
          submittedProviderTaskId = submitted.providerTaskId;
          return {
            remoteId: submitted.providerTaskId,
            ...(submitted.terminalState ? { terminalState: submitted.terminalState } : {}),
          };
        } catch (error) {
          const uncertain = (error instanceof CanvasAdapterError && error.uncertain) || error instanceof TypeError;
          if (uncertain) throw error;
          const code = error instanceof CanvasAdapterError ? error.code : 'submit_failed';
          submitFailure = { code, message: error instanceof Error ? error.message : String(error) };
          return { terminalState: 'not_created', errorCode: code.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 200) };
        }
      });
    } catch (error) {
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'uncertain', submissionState: 'maybe_sent',
          errorCode: error instanceof CanvasAdapterError ? error.code : 'submit_uncertain',
          errorMessage: error instanceof Error ? error.message : String(error),
          leaseOwner: null, leaseUntil: null,
        },
        guard,
        now,
      });
      return finish('uncertain');
    }
    if (executionAttempt.terminalState === 'not_created') {
      const failure = submitFailure as { code: string; message: string } | null;
      await execution.facade.settle({
        attemptId: executionAttempt.id, outcome: 'not_created', actualCost: null, remoteTerminal: true,
        errorCode: failure?.code,
      });
      if (failure?.code === 'cancelled') return cancelBeforeSubmit();
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
        outcome: 'succeeded', actualCost: canvasTaskActualCost(db, task), remoteTerminal: true,
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
    recordCanvasTaskUsage(db, { taskId, executionAttemptId: executionAttempt?.id });
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
      const submitted = await adapter.submit(context, signal);
      providerTaskId = submitted.providerTaskId;
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: { providerTaskId, submissionState: 'accepted', phase: 'polling', errorCode: null, errorMessage: null },
        guard,
        now,
      });
      recordCanvasTaskUsage(db, { taskId, executionAttemptId: executionAttempt?.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = (error instanceof CanvasAdapterError && error.uncertain) || error instanceof TypeError;
      const phase: CanvasTaskPhase = uncertain ? 'uncertain' : 'failed';
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase,
          submissionState: uncertain ? 'maybe_sent' : 'terminal',
          errorCode: error instanceof CanvasAdapterError ? error.code : (uncertain ? 'submit_uncertain' : 'submit_failed'),
          errorMessage: message,
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
  let pollState: 'succeeded' | 'failed' | 'aborted' = 'aborted';
  while (attempts < maxPollAttempts) {
    if (signal?.aborted) {
      pollState = 'aborted';
      break;
    }
    await sleep(pollIntervalMs);
    attempts += 1;
    let outcome;
    try {
      outcome = await adapter.poll({ ...context, providerTaskId }, signal);
    } catch (error) {
      // 查询失败不改写远端身份，继续按下一次轮询重试
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          lastPolledAt: now().toISOString(),
          pollCount: previousPollCount + attempts,
          errorCode: error instanceof CanvasAdapterError ? error.code : 'poll_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
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
          evidence: { kind: 'terminal', outcome: 'succeeded', actualCost: canvasTaskActualCost(db, task) },
          source: 'provider',
        });
      }
      pollState = 'succeeded';
      break;
    }
    if (outcome.status === 'failed') {
      if (options.execution && executionAttempt) {
        executionAttempt = await options.execution.facade.reconcile({
          attemptId: executionAttempt.id,
          evidence: { kind: 'terminal', outcome: 'failed', actualCost: null, errorCode: outcome.code },
          source: 'provider',
        });
      }
      updateCanvasTaskGuarded(db, {
        taskId,
        patch: {
          phase: 'failed',
          submissionState: 'terminal',
          errorCode: outcome.code ?? 'provider_failed',
          errorMessage: outcome.message,
          leaseOwner: null,
          leaseUntil: null,
        },
        guard,
        now,
      });
      return finish('failed');
    }
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
    downloaded = await adapter.download({ ...context, providerTaskId }, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'download_failed',
        errorCode: error instanceof CanvasAdapterError ? error.code : 'download_failed',
        errorMessage: message,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
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
    recordCanvasTaskUsage(db, { taskId, executionAttemptId: executionAttempt?.id });
    if (options.execution && executionAttempt?.actualMinor === null) {
      const latest = getCanvasTask(db, taskId);
      const actualCost = latest ? canvasTaskActualCost(db, latest) : null;
      if (actualCost) {
        executionAttempt = await options.execution.facade.settle({
          attemptId: executionAttempt.id,
          outcome: 'succeeded', actualCost, remoteTerminal: true,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'download_failed',
        errorCode: 'output_validation_failed',
        errorMessage: message,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    return finish('download_failed');
  }
  // registerCanvasResultAsset atomically checked the guard, inserted the asset,
  // completed the task, and attempted node publication. A stale worker only
  // leaves its private file cleanup and cannot touch any database row.
  if (!asset) {
    const latest = getCanvasTask(db, taskId);
    return finish(latest?.phase ?? 'polling');
  }
  return {
    taskId,
    phase: 'succeeded',
    outputAssetId: asset.id,
    published,
    errorCode: null,
  };
}
