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
import { recordCanvasTaskUsage } from './usage.ts';
import { isTerminalTaskPhase, type CanvasGenerationMode, type CanvasTaskPhase } from './types.ts';

export interface RunCanvasTaskOptions {
  db: Database.Database;
  taskId: string;
  adapter: CanvasTaskAdapter;
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

export async function runCanvasTask(options: RunCanvasTaskOptions): Promise<CanvasRunTaskOutcome> {
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
  // （调度器只会把「已提交」的任务交回执行器，这里不依赖 submissionState 的具体取值。）
  const resuming = task.providerTaskId !== null;

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
  } else {
  const submittedIntent = updateCanvasTaskGuarded(db, {
    taskId,
    patch: { phase: 'submitting', submissionState: 'maybe_sent' },
    guard,
    now,
  });
  if (!submittedIntent) {
    return finish(getCanvasTask(db, taskId)?.phase ?? 'queued');
  }

  // 3. 单次生成 POST
  try {
    const submitted = await adapter.submit(context, signal);
    providerTaskId = submitted.providerTaskId;
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: { providerTaskId, submissionState: 'accepted', phase: 'polling', errorCode: null, errorMessage: null },
      guard,
      now,
    });
    // 提交被接受后才记账：eventKey 按任务稳定，重试／补下载不会重复计生成费用
    recordCanvasTaskUsage(db, { taskId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain = error instanceof CanvasAdapterError && error.uncertain;
    const phase: CanvasTaskPhase = uncertain ? 'uncertain' : 'failed';
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase,
        submissionState: uncertain ? 'maybe_sent' : 'terminal',
        errorCode: error instanceof CanvasAdapterError ? error.code : 'submit_failed',
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
  let pollState: 'succeeded' | 'failed' | 'aborted' | 'cancelled' = 'aborted';
  while (attempts < maxPollAttempts) {
    if (signal?.aborted) {
      pollState = 'aborted';
      break;
    }
    const current = getCanvasTask(db, taskId);
    if (current?.cancelRequestedAt) {
      pollState = 'cancelled';
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
          pollCount: attempts,
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
      patch: { lastPolledAt: now().toISOString(), pollCount: attempts },
      guard,
      now,
    });
    if (outcome.status === 'succeeded') {
      pollState = 'succeeded';
      break;
    }
    if (outcome.status === 'failed') {
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

  if (pollState === 'cancelled') {
    let remoteCancelled = false;
    if (adapter.cancel) {
      try {
        const cancelled = await adapter.cancel({ ...context, providerTaskId }, signal);
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
    updateCanvasTaskGuarded(db, {
      taskId,
      patch: {
        phase: 'succeeded',
        submissionState: 'terminal',
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseUntil: null,
      },
      guard,
      now,
    });
    const republished = publishCanvasNodeResult({
      db,
      canvasId: task.canvasId,
      nodeId: task.nodeId,
      taskId,
      nodeEpoch: task.nodeEpoch,
      assetId: recordedOutput,
      now,
    });
    return {
      taskId,
      phase: 'succeeded',
      outputAssetId: recordedOutput,
      published: republished.published,
      errorCode: null,
    };
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

  let assetId: string;
  try {
    const asset = await registerCanvasResultAsset({
      db,
      canvasId: task.canvasId,
      storageRoot,
      taskId,
      mediaKind: task.mediaKind,
      mimeType: downloaded.mimeType,
      data: downloaded.bytes,
      now,
    });
    assetId = asset.id;
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

  // 6. 登记输出 + 发布当前结果：只在节点仍存在、epoch 匹配且 activeTaskId 指向本任务时生效
  updateCanvasTaskGuarded(db, {
    taskId,
    patch: {
      phase: 'succeeded',
      submissionState: 'terminal',
      outputAssetId: assetId,
      errorCode: null,
      errorMessage: null,
      leaseOwner: null,
      leaseUntil: null,
    },
    guard,
    now,
  });
  const published = publishCanvasNodeResult({
    db,
    canvasId: task.canvasId,
    nodeId: task.nodeId,
    taskId,
    nodeEpoch: task.nodeEpoch,
    assetId,
    now,
  });
  return {
    taskId,
    phase: 'succeeded',
    outputAssetId: assetId,
    published: published.published,
    errorCode: null,
  };
}
