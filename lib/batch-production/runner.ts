import type Database from 'better-sqlite3';
import { runWithTaskAccessContext } from '../media-core/access-context.ts';
import { isExecutionDeferredError } from '../media-core/execution/waiting.ts';
import { writeLog } from '../logger.ts';
import { semanticFallbackMessage } from './semantic-score-policy.ts';
import { findExecutor, type BatchTaskExecutor, type BatchTaskProgress } from './executors.ts';
import {
  claimNextTask,
  completeTaskAttempt,
  deferTaskAttempt,
  expireStaleLeases,
  hasValidLease,
  recoverInterruptedWork,
  renewLease,
  setBatchSchedulerDraining,
  settleInterruptedTask,
} from './scheduler.ts';
import { resolveCoverContractHash, resolveFullRenderContractHash } from './cover-contract.ts';
import {
  buildCoverRenderTaskRequestKey,
  buildFullRenderTaskRequestKey,
  parseRenderTaskRequestKey,
} from './render-task-key.ts';

interface RenderTaskIdentity {
  workType: string;
  targetKind: string;
  targetId: string;
  requestKey: string | null;
}

function coverContractHashFromResult(resultJson: unknown): string | null {
  if (!resultJson || typeof resultJson !== 'object' || Array.isArray(resultJson)) return null;
  const value = (resultJson as Record<string, unknown>).coverContractHash;
  return typeof value === 'string' && /^cov_[0-9a-f]{32}$/u.test(value) ? value : null;
}

/**
 * 同版本范围内渲染任务的契约 identity。任务 requestKey 是新格式时返回
 * 当前应具有的契约 key,与任务所持有的 key 比对即可发现「渲染期间内容
 * 又变了」;只有旧格式任务返回 null。新格式任务的当前契约无法解析时必须
 * 抛错并由完成事务 fail closed，不能把无法证明身份的结果记成成功。
 */
function resolveCurrentRenderRequestKey(
  db: Database.Database,
  task: RenderTaskIdentity | undefined,
): string | null {
  if (!task || task.workType !== 'render' || !task.requestKey) return null;
  const parsed = parseRenderTaskRequestKey(task.requestKey);
  if (!parsed) return null;
  const expectedTargetKind = parsed.kind === 'cover' ? 'output_version_cover' : 'output_version';
  if (task.targetKind !== expectedTargetKind || parsed.outputVersionId !== task.targetId) {
    throw new Error('渲染任务契约身份与任务目标不一致');
  }
  return parsed.kind === 'cover'
    ? buildCoverRenderTaskRequestKey(task.targetId, resolveCoverContractHash(db, task.targetId))
    : buildFullRenderTaskRequestKey(task.targetId, resolveFullRenderContractHash(db, task.targetId));
}

export interface SchedulerRunOptions {
  db: Database.Database;
  workerId: string;
  executors: BatchTaskExecutor[];
  /** 默认写入项目日志；测试可捕获生命周期与降级日志。 */
  log?: typeof writeLog;
  /** 通用任务执行位；未配置 analysisConcurrency 时也负责素材分析。 */
  concurrency?: number;
  /** 大于 0 时独立运行素材分析，通用执行位不再领取 asset_prepare。 */
  analysisConcurrency?: number;
  leaseDurationMs?: number;
  /** 执行期间独立心跳与批次控制检查间隔 */
  heartbeatMs?: number;
  /** 进度落库节流间隔;高频进度(如 FFmpeg)默认 1 秒写一次 */
  progressThrottleMs?: number;
  now?: () => Date;
  /** 调用方主动停止全部工作;属于用户停止语义。 */
  signal?: AbortSignal;
  /** 进程内调度器关闭;任务应可在下次启动恢复。 */
  shutdownSignal?: AbortSignal;
  /** 连续调度时,单个空闲执行位两次领取检查之间的最长等待(默认等于调度间隔 intervalMs,默认 2000ms)。 */
  idlePollMs?: number;
  /** 等待统一准入/媒体名额后再次尝试的基础退避;默认 100ms,媒体类最少 1000ms,准入类最少 500ms。 */
  deferBackoffMs?: number;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

const activeBatchTaskControllers = new Set<AbortController>();

/** 广播停机到不一定已经拿到 scheduler controller 的批量执行器。 */
export function abortRunningBatchTasks(): number {
  const running = [...activeBatchTaskControllers];
  for (const controller of running) controller.abort();
  return running.length;
}

/** 返回超时后仍在执行的批量任务数。 */
export async function waitForBatchTasksIdle(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (activeBatchTaskControllers.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return activeBatchTaskControllers.size;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

type DeferCause = 'media' | 'admission' | 'lease';
type ExecuteOneOutcome =
  | { kind: 'completed' }
  | { kind: 'deferred'; cause: Exclude<DeferCause, 'lease'> }
  | { kind: 'lease_lost' };
type InterruptionReason = 'batch_control' | 'lease_lost' | 'superseded';
type SlotLane = 'analysis' | 'general' | undefined;

const DEFAULT_DEFER_BACKOFF_MS = 100;
const MEDIA_BACKOFF_MIN_MS = 1_000;
const ADMISSION_BACKOFF_MIN_MS = 500;
const LEASE_LOST_BACKOFF_MIN_MS = 100;
const MAX_TRACKED_DEFERRALS = 64;
const MIN_IDLE_POLL_MS = 5;
const DEFAULT_IDLE_POLL_MS = 2_000;

/**
 * 进程内唤醒信号:入队或资源状态变化时可打断空闲等待。
 * token 用于消除「检查完队列、还没开始等待就来了唤醒」的丢唤醒窗口。
 */
interface SchedulerWake {
  readonly token: number;
  wake(): void;
  waitSince(token: number, ms: number, signal?: AbortSignal): Promise<void>;
}

function createSchedulerWake(): SchedulerWake {
  let generation = 0;
  const waiters = new Set<() => void>();
  return {
    get token() {
      return generation;
    },
    wake() {
      generation += 1;
      for (const finish of [...waiters]) finish();
      waiters.clear();
    },
    waitSince(token, ms, signal) {
      if (signal?.aborted || generation !== token || ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          waiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
      });
    },
  };
}

/**
 * 延期任务的短时退避表。任务仍在数据库里排队,这里只在进程内记录
 * 「到某个时刻前先别再领它」,让同 lane 的其他合格任务先推进;
 * 到期后条目自动失效,不需要后台清理。
 */
interface DeferredBackoff {
  defer(taskId: string, cause: DeferCause): void;
  clear(taskId: string): void;
  excludedIds(): string[];
  delayUntilNextAttemptMs(): number | null;
}

function createDeferredBackoff(baseMs: number): DeferredBackoff {
  const retryAt = new Map<string, number>();
  const backoffFor = (cause: DeferCause): number => {
    if (cause === 'admission') return Math.max(baseMs, ADMISSION_BACKOFF_MIN_MS);
    if (cause === 'lease') return Math.max(baseMs, LEASE_LOST_BACKOFF_MIN_MS);
    return Math.max(baseMs, MEDIA_BACKOFF_MIN_MS);
  };
  const prune = (): void => {
    const current = Date.now();
    for (const [taskId, at] of retryAt) {
      if (at <= current) retryAt.delete(taskId);
    }
    // 超过上限时淘汰最远到期的条目,保留最早到期的——被淘汰的任务本轮
    // 立即重新可领取,不会让本应退避的任务立刻重试。
    while (retryAt.size > MAX_TRACKED_DEFERRALS) {
      let farthestId: string | null = null;
      let farthestAt = Number.NEGATIVE_INFINITY;
      for (const [taskId, at] of retryAt) {
        if (at > farthestAt) {
          farthestAt = at;
          farthestId = taskId;
        }
      }
      if (farthestId === null) break;
      retryAt.delete(farthestId);
    }
  };
  return {
    defer(taskId, cause) {
      retryAt.set(taskId, Date.now() + Math.max(1, backoffFor(cause)));
      prune();
    },
    clear(taskId) {
      retryAt.delete(taskId);
    },
    excludedIds() {
      prune();
      return [...retryAt.keys()];
    },
    delayUntilNextAttemptMs() {
      prune();
      if (retryAt.size === 0) return null;
      const current = Date.now();
      let soonest = Infinity;
      for (const at of retryAt.values()) soonest = Math.min(soonest, at - current);
      return Math.max(0, soonest);
    },
  };
}

function assertSchedulerConcurrency(concurrency: number, analysisConcurrency: number): void {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isSafeInteger(analysisConcurrency) || analysisConcurrency < 0 || analysisConcurrency > 8) {
    throw new Error('批量任务并发配置无效');
  }
}

interface SlotOptions {
  /** 连续模式:队列为空时等待唤醒/有界轮询;关闭时单轮排空后返回。 */
  continuous: boolean;
  wake?: SchedulerWake;
  idlePollMs?: number;
  backoff?: DeferredBackoff;
}

/**
 * 单个执行位:领取 → 执行 → 再领取。
 * 单轮模式下没有可领取任务或遇到延期/租约丢失就返回,保持
 * runPendingOnce 的既有语义;连续模式下永不因其他 lane 的长任务停摆,
 * 空闲时等待入队唤醒或有界轮询,延期任务按原因退避后重试。
 */
async function runSlot(
  options: SchedulerRunOptions,
  lane: SlotLane,
  slot: SlotOptions,
): Promise<number> {
  const {
    db,
    workerId,
    executors,
    leaseDurationMs = 5 * 60_000,
    heartbeatMs = Math.max(200, Math.min(1_000, Math.floor(leaseDurationMs / 3))),
    progressThrottleMs = 1_000,
  } = options;
  const now = options.now;
  const waitSignals = [options.signal, options.shutdownSignal]
    .filter((signal): signal is AbortSignal => Boolean(signal));
  const waitSignal = waitSignals.length > 1 ? AbortSignal.any(waitSignals) : waitSignals[0];
  let handled = 0;

  while (!options.signal?.aborted && !options.shutdownSignal?.aborted) {
    const wakeToken = slot.wake?.token ?? -1;
    let claim: ReturnType<typeof claimNextTask>;
    try {
      claim = claimNextTask(db, {
        workerId,
        now,
        leaseDurationMs,
        lane,
        excludeTaskIds: slot.backoff?.excludedIds(),
      });
    } catch (error) {
      if (!slot.continuous) throw error;
      console.error('批量调度领取失败:', error instanceof Error ? error.message : String(error));
      claim = null;
    }
    if (!claim) {
      if (!slot.continuous || !slot.wake) return handled;
      // 有延期任务时等到最早退避到期,但空闲检查仍受 idlePollMs 上界约束;
      // 下一次领取会继续用 excludeTaskIds 跳过未到期的任务,不做忙循环。
      const idleWaitMs = slot.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
      const backoffDelay = slot.backoff?.delayUntilNextAttemptMs() ?? null;
      const waitMs = backoffDelay !== null ? Math.min(idleWaitMs, backoffDelay) : idleWaitMs;
      await slot.wake.waitSince(wakeToken, Math.max(MIN_IDLE_POLL_MS, waitMs), waitSignal);
      continue;
    }
    slot.backoff?.clear(claim.task.id);
    handled += 1;
    const controller = new AbortController();
    let outcome: ExecuteOneOutcome;
    try {
      outcome = await runWithTaskAccessContext(db, 'batch', claim.task.id, () => executeOne(claim!, controller, {
        db,
        workerId,
        executors,
        log: options.log,
        leaseDurationMs,
        heartbeatMs,
        progressThrottleMs,
        now,
        signal: options.signal,
        shutdownSignal: options.shutdownSignal,
      }));
    } catch (error) {
      if (!slot.continuous) throw error;
      console.error('批量调度执行失败:', error instanceof Error ? error.message : String(error));
      outcome = { kind: 'completed' };
      // 非预期异常也必须退一步再领取,避免持续抛错时空转。
      await slot.wake?.waitSince(slot.wake.token, slot.idlePollMs ?? DEFAULT_IDLE_POLL_MS, waitSignal);
    }
    if (outcome.kind === 'deferred' || outcome.kind === 'lease_lost') {
      // 失去租约或链内等待时不立即重领同一任务:连续模式按原因退避,
      // 让其他合格工作先获得名额;单轮模式保持既有语义直接结束本槽。
      slot.backoff?.defer(claim.task.id, outcome.kind === 'deferred' ? outcome.cause : 'lease');
      if (!slot.continuous) return handled;
    }
  }
  return handled;
}

/**
 * 领取并执行一轮可执行任务(受控 worker pool)。
 * 通用任务不超过 concurrency，独立分析不超过 analysisConcurrency；每个槽独立领取，
 * 领取由数据库原子性保证不重复,所有槽执行完才返回。
 * 执行期间独立心跳续租(不依赖执行器是否报告进度),并监视批次控制状态:
 * 批次暂停/停止时中止运行任务并按期望落账。
 */
export async function runPendingOnce(options: SchedulerRunOptions): Promise<number> {
  const { concurrency = 2, analysisConcurrency = 0 } = options;
  assertSchedulerConcurrency(concurrency, analysisConcurrency);
  const handled = await Promise.all([
    ...Array.from({ length: concurrency }, () => runSlot(
      options,
      analysisConcurrency ? 'general' : undefined,
      { continuous: false },
    )),
    ...Array.from({ length: analysisConcurrency }, () => runSlot(
      options,
      'analysis',
      { continuous: false },
    )),
  ]);
  return handled.reduce((total, count) => total + count, 0);
}

interface ExecuteOneOptions {
  db: Database.Database;
  workerId: string;
  executors: BatchTaskExecutor[];
  log?: typeof writeLog;
  leaseDurationMs: number;
  heartbeatMs: number;
  progressThrottleMs: number;
  now?: () => Date;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
}

async function executeOne(
  claim: NonNullable<Awaited<ReturnType<typeof claimNextTask>>>,
  controller: AbortController,
  options: ExecuteOneOptions,
): Promise<ExecuteOneOutcome> {
  const { db, workerId, executors, leaseDurationMs, heartbeatMs, progressThrottleMs, now } = options;
  const log = options.log ?? writeLog;
  activeBatchTaskControllers.add(controller);
  const executor = findExecutor(executors, claim.task.workType);
  let lastProgressWrite = 0;
  let lastLoggedPhase = '';
  const analysisLabel = claim.task.workType === 'asset_prepare' ? '素材分析'
    : claim.task.workType === 'semantic_score' ? 'AI 语义匹配' : null;
  const lastProgress: BatchTaskProgress = { phase: 'starting' };
  let interruptionReason: InterruptionReason | null = null;
  let discardUnacceptedResult: (() => Promise<void> | void) | undefined;
  const interrupt = (reason: InterruptionReason): void => {
    interruptionReason ??= reason;
    controller.abort();
  };
  const reportProgress = (progress: BatchTaskProgress): void => {
    Object.assign(lastProgress, progress);
    // 只记录分析阶段切换，不把百分比更新/心跳刷进项目日志。
    if (analysisLabel && progress.phase !== lastLoggedPhase) {
      lastLoggedPhase = progress.phase;
      log({ projectId: claim.task.projectId, jobId: claim.task.id, level: 'info',
        attempt: claim.attempt.attemptNumber,
        message: `[批量生产] ${analysisLabel}：${progress.description || '开始处理'}` });
    }
    const nowMs = Date.now();
    if (nowMs - lastProgressWrite < progressThrottleMs) {
      return;
    }
    lastProgressWrite = nowMs;
    // 只有持有有效租约的 worker 才能写进度
    if (!renewLease(db, claim.attempt.id, { workerId, now, leaseDurationMs })) {
      interrupt('lease_lost');
      return;
    }
    db.prepare(`
      UPDATE batch_task_attempts SET progressJson = ? WHERE id = ? AND claimedBy = ?
    `).run(JSON.stringify(lastProgress), claim.attempt.id, workerId);
  };

  // 独立心跳:定期续租并检查控制状态,不依赖执行器是否报告进度。
  // 同时检查批次 controlState 和这个任务自己的 expectedState——单独暂停/取消
  // 一个任务(不动批次 controlState)必须能在下一个心跳周期内被感知并中止,
  // 不必等任务自然跑完。
  const heartbeat = setInterval(() => {
    if (!renewLease(db, claim.attempt.id, { workerId, now, leaseDurationMs })) {
      interrupt('lease_lost');
      return;
    }
    const control = db.prepare(`
      SELECT COALESCE(p.controlState, 'running') AS controlState, t.expectedState,
        CASE
          WHEN t.workType <> 'render' OR (t.targetKind <> 'output_version' AND t.targetKind <> 'output_version_cover') THEN 1
          WHEN EXISTS (
            SELECT 1 FROM batch_output_versions o
            JOIN batch_output_plans plan ON plan.id = o.planId
            WHERE o.id = t.targetId AND plan.currentVersionId = o.id
          ) THEN 1 ELSE 0
        END AS targetIsCurrent
      FROM batch_tasks t
      LEFT JOIN batch_productions p ON p.id = t.batchId
      WHERE t.id = ?
    `).get(claim.task.id) as { controlState: string; expectedState: string; targetIsCurrent: number } | undefined;
    if (control?.targetIsCurrent === 0) {
      interrupt('superseded');
    } else if (control && (control.controlState !== 'running' || control.expectedState !== 'running')) {
      interrupt('batch_control');
    }
  }, heartbeatMs);

  try {
    if (!executor) {
      throw new Error(`没有注册可执行 ${claim.task.workType} 任务的执行器`);
    }
    reportProgress({ phase: 'running' });
    // 执行器同时接收内部控制信号(批次暂停/停止)与外部停止信号
    const signals = [controller.signal, options.signal, options.shutdownSignal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    const executorSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
    const execution = await executor.execute({
      db,
      claim,
      signal: executorSignal,
      reportProgress,
    });
    if (execution.deferred) {
      deferTaskAttempt(db, claim.attempt.id, {
        workerId,
        operationId: execution.deferred.operationId,
        continuationKey: execution.deferred.continuationKey,
        waitReason: execution.deferred.waitReason,
        progressJson: lastProgress,
        now,
      });
      return { kind: 'deferred', cause: /media/i.test(execution.deferred.waitReason ?? '') ? 'media' : 'admission' };
    }
    let resultJson = execution.resultJson;
    discardUnacceptedResult = execution.discard;
    // 执行器可能没有及时响应 AbortSignal。结果发布前必须重新核对持久化
    // 控制状态,不能让 pause/stop 之后的迟到回调提交 succeeded。
    // 指针、控制态、租约和成功落账必须在同一 SQLite 事务内检查，避免
    // 重分配刚切换 currentVersionId 时旧 render 仍提交迟到候选。
    db.transaction(() => {
      const completionState = db.prepare(`
        SELECT t.expectedState, COALESCE(p.controlState, 'running') AS controlState,
          CASE
            WHEN t.workType <> 'render' OR (t.targetKind <> 'output_version' AND t.targetKind <> 'output_version_cover') THEN 1
            WHEN EXISTS (
              SELECT 1 FROM batch_output_versions o
              JOIN batch_output_plans plan ON plan.id = o.planId
              WHERE o.id = t.targetId AND plan.currentVersionId = o.id
            ) THEN 1 ELSE 0
          END AS targetIsCurrent
        FROM batch_tasks t
        LEFT JOIN batch_productions p ON p.id = t.batchId
        WHERE t.id = ?
      `).get(claim.task.id) as { expectedState: string; controlState: string; targetIsCurrent: number } | undefined;
      if (completionState?.targetIsCurrent === 0) {
        interrupt('superseded');
        throw new Error('渲染目标已被新成片版本替代,不能提交结果');
      }
      // 同版本范围内的契约 CAS:封面/整片任务的新格式 requestKey 携带契约哈希,
      // 渲染期间同版本内容又变了(换封面/改片段)时,基于旧契约的迟到结果
      // 不能落成 succeeded——旧任务按 superseded 取消终态,由新契约任务接棒。
      const renderTask = db.prepare(`
        SELECT workType, targetKind, targetId, requestKey FROM batch_tasks WHERE id = ?
      `).get(claim.task.id) as {
        workType: string;
        targetKind: string;
        targetId: string;
        requestKey: string | null;
      } | undefined;
      let expectedRequestKey: string | null;
      try {
        expectedRequestKey = resolveCurrentRenderRequestKey(db, renderTask);
      } catch {
        interrupt('superseded');
        throw new Error('当前渲染契约无法验证,结果不能提交');
      }
      if (expectedRequestKey && renderTask?.requestKey !== expectedRequestKey) {
        interrupt('superseded');
        throw new Error('渲染契约已变化,旧任务结果不能提交');
      }
      if (
        !completionState
        || executorSignal.aborted
        || completionState.expectedState !== 'running'
        || completionState.controlState !== 'running'
      ) {
        interrupt('batch_control');
        throw new Error('任务已被暂停或停止,不能提交结果');
      }
      if (!hasValidLease(db, claim.attempt.id, workerId, now)) {
        interrupt('lease_lost');
        throw new Error('任务租约已到期,不能提交结果');
      }
      if (execution.commit) {
        const committed = execution.commit();
        resultJson = committed.resultJson;
        discardUnacceptedResult = committed.discard ?? discardUnacceptedResult;
        if (committed.progress) Object.assign(lastProgress, committed.progress);
        // commit 回调也可能触发外部停止信号；再次检查可让同一事务完整
        // 回滚刚发布的领域写入，而不是把取消后的结果落成 succeeded。
        if (executorSignal.aborted) {
          interrupt('batch_control');
          throw new Error('任务在发布结果时被中止,不能提交成功结果');
        }
      }
      // 封面 A→B→A 时，task key 与当前 key 可能再次相等；还必须证明执行器
      // 返回的产物确实来自 task 声明的冻结契约，不能把 B 结果记到 A 任务。
      const parsedTaskKey = parseRenderTaskRequestKey(renderTask?.requestKey);
      const taskCoverHash = parsedTaskKey?.kind === 'cover' ? parsedTaskKey.contractHash : null;
      if (
        renderTask?.targetKind === 'output_version_cover'
        && taskCoverHash
        && coverContractHashFromResult(resultJson) !== taskCoverHash
      ) {
        interrupt('superseded');
        throw new Error('封面渲染结果与任务契约不一致,不能提交结果');
      }
      db.prepare(`
        UPDATE batch_task_attempts SET progressJson = ? WHERE id = ? AND claimedBy = ?
      `).run(JSON.stringify(lastProgress), claim.attempt.id, workerId);
      completeTaskAttempt(db, claim.attempt.id, {
        workerId,
        status: 'succeeded',
        progressJson: lastProgress,
        resultJson,
        now,
      });
    }).immediate();
    discardUnacceptedResult = undefined;
    if (analysisLabel) {
      log({ projectId: claim.task.projectId, jobId: claim.task.id, level: 'info',
        attempt: claim.attempt.attemptNumber, message: `[批量生产] ${analysisLabel}完成：${lastProgress.skipped ? lastProgress.description : '结果已保存'}` });
    }
    return { kind: 'completed' };
  } catch (error) {
    if (discardUnacceptedResult) {
      await Promise.resolve(discardUnacceptedResult()).catch(() => undefined);
      discardUnacceptedResult = undefined;
    }
    // 用信号状态判定中止来源,不靠错误消息猜测:
    // 外部停止信号 → 停止终态;内部控制检查(批次暂停/停止) → 按批次期望落账
    const abortedByUserStop = Boolean(options.signal?.aborted);
    const abortedBySchedulerShutdown = Boolean(options.shutdownSignal?.aborted);
    const executionError = error as { code?: unknown; operationId?: unknown; waitReason?: unknown } | null;
    if (
      isExecutionDeferredError(error)
      && !abortedByUserStop
      && !abortedBySchedulerShutdown
      && !controller.signal.aborted
      && hasValidLease(db, claim.attempt.id, workerId, now)
    ) {
      deferTaskAttempt(db, claim.attempt.id, {
        workerId,
        operationId: typeof executionError?.operationId === 'string' ? executionError.operationId : undefined,
        continuationKey: executionError?.code === 'media_resource_deferred'
          ? 'media-core.media-resource-gate.v1'
          : 'script-providers.completeJson.v1',
        waitReason: typeof executionError?.waitReason === 'string' ? executionError.waitReason : null,
        progressJson: lastProgress,
        now,
      });
      return { kind: 'deferred', cause: executionError?.code === 'media_resource_deferred' ? 'media' : 'admission' };
    }
    if (abortedByUserStop) {
      // 外部停止信号:任务进入停止终态,尝试记录为 interrupted
      settleInterruptedTask(db, claim.attempt.id, now, 'user_stop');
    } else if (abortedBySchedulerShutdown) {
      // 应用/调度器关闭不是用户停止:尝试结束,任务保持 running 期望并可恢复。
      settleInterruptedTask(db, claim.attempt.id, now, 'scheduler_shutdown');
    } else if (interruptionReason === 'superseded') {
      settleInterruptedTask(db, claim.attempt.id, now, 'superseded');
    } else if (interruptionReason === 'lease_lost' || !hasValidLease(db, claim.attempt.id, workerId, now)) {
      // 租约丢失不是用户暂停。只做过期恢复,保留 expectedState=running;
      // 如果尝试已被其他恢复流程处理,这里不会覆盖其结果。
      expireStaleLeases(db, { now });
      return { kind: 'lease_lost' };
    } else if (controller.signal.aborted) {
      // 批次暂停/停止(内部控制检查):按批次期望落成可继续或终态
      settleInterruptedTask(db, claim.attempt.id, now, 'batch_control');
    } else {
      // 执行器抛出的带 code 错误(如 semantic_fallback)保留机器可读错误码,
      // 供重试入口与界面区分失败原因;其余维持 executor_error。
      const executorErrorCode = (error as { code?: unknown } | null)?.code;
      const failureMessage = error instanceof Error ? error.message : String(error);
      completeTaskAttempt(db, claim.attempt.id, {
        workerId,
        status: 'failed',
        errorCode: typeof executorErrorCode === 'string' && executorErrorCode ? executorErrorCode : 'executor_error',
        errorMessage: failureMessage,
        progressJson: lastProgress,
        now,
      });
      // 批量任务失败同步进项目日志:此前只落在 batch_task_attempts,
      // 界面上完全不可见。
      log({
        jobId: claim.task.id,
        projectId: claim.task.projectId,
        level: claim.task.workType === 'semantic_score' && executorErrorCode === 'semantic_fallback' ? 'warn' : 'error',
        message: claim.task.workType === 'semantic_score' && executorErrorCode === 'semantic_fallback'
          ? `[批量生产] ${semanticFallbackMessage(claim.attempt.attemptNumber)}（第 ${claim.attempt.attemptNumber} 次）原因：${failureMessage}`
          : `[批量生产] ${claim.task.workType} 任务失败（第 ${claim.attempt.attemptNumber} 次）: ${failureMessage}`,
        attempt: claim.attempt.attemptNumber,
      });
    }
    return { kind: 'completed' };
  } finally {
    clearInterval(heartbeat);
    activeBatchTaskControllers.delete(controller);
  }
}

export interface SchedulerController {
  /** 停止领取并等待所有在途任务安全落账。 */
  stop(): Promise<void>;
  readonly running: boolean;
}

interface SchedulerState {
  stopped: boolean;
  loopPromise: Promise<void> | null;
  stopController: AbortController;
  wake: SchedulerWake;
}

let schedulerInstance: SchedulerState | null = null;
let schedulerController: SchedulerController | null = null;

/**
 * 启动进程内单例调度循环:启动时先做一次恢复(旧实例 running 尝试失效),
 * 然后为每个执行位启动独立持续循环。空闲位不会等待其他 lane 的长任务
 * 整轮结束:入队/释放可经 wakeBatchScheduler() 唤醒,否则按有界空闲轮询检查;
 * 延期任务按原因短时退避,让同 lane 的合格工作先推进。
 * 同一进程重复初始化幂等(返回同一个 controller 实例);
 * stop() 停止继续领取并等待在途任务落账。
 */
export function startBatchScheduler(
  options: SchedulerRunOptions & { intervalMs?: number },
): SchedulerController {
  if (schedulerInstance && schedulerController) {
    return schedulerController;
  }
  const { db, intervalMs = 2_000 } = options;
  const concurrency = options.concurrency ?? 2;
  const analysisConcurrency = options.analysisConcurrency ?? 0;
  assertSchedulerConcurrency(concurrency, analysisConcurrency);
  setBatchSchedulerDraining(false);
  recoverInterruptedWork(db, { now: options.now });
  const maxIdlePollMs = Math.max(MIN_IDLE_POLL_MS, intervalMs);
  // 默认按调度间隔做有界轮询(默认 2000ms):空闲位由入队唤醒即时补位,
  // 无唤醒时不再以 500ms 高频空转;显式传 idlePollMs 的调用方保持原语义。
  const idlePollMs = Math.max(MIN_IDLE_POLL_MS, Math.min(
    options.idlePollMs ?? maxIdlePollMs,
    maxIdlePollMs,
  ));
  const backoff = createDeferredBackoff(options.deferBackoffMs ?? DEFAULT_DEFER_BACKOFF_MS);
  const state: SchedulerState = {
    stopped: false,
    loopPromise: null,
    stopController: new AbortController(),
    wake: createSchedulerWake(),
  };

  const loop = async (): Promise<void> => {
    const slotOptions: SchedulerRunOptions = { ...options, shutdownSignal: state.stopController.signal };
    const slotRuns = [
      ...Array.from({ length: concurrency }, () => runSlot(
        slotOptions,
        analysisConcurrency ? 'general' : undefined,
        { continuous: true, wake: state.wake, idlePollMs, backoff },
      )),
      ...Array.from({ length: analysisConcurrency }, () => runSlot(
        slotOptions,
        'analysis',
        { continuous: true, wake: state.wake, idlePollMs, backoff },
      )),
    ];
    // 租约过期检查独立于各执行位,不再和某一轮任务执行绑在一起。
    const maintenance = (async (): Promise<void> => {
      while (!state.stopController.signal.aborted) {
        try {
          const expired = expireStaleLeases(db, { now: options.now });
          if (expired > 0) state.wake.wake();
        } catch (error) {
          console.error('批量调度租约检查失败:', error instanceof Error ? error.message : String(error));
        }
        await sleep(intervalMs, state.stopController.signal);
      }
    })();
    await Promise.all([...slotRuns, maintenance]);
  };

  state.loopPromise = loop();
  schedulerInstance = state;
  const controller: SchedulerController = {
    async stop() {
      setBatchSchedulerDraining(true);
      if (!state.stopped) {
        state.stopped = true;
        state.stopController.abort();
        state.wake.wake();
      }
      // 不提前释放单例:必须等当前一轮中止并落账,避免重启后双调度器共存。
      await state.loopPromise;
      if (schedulerInstance === state && schedulerController === controller) {
        schedulerInstance = null;
        schedulerController = null;
      }
    },
    get running() {
      return !state.stopped;
    },
  };
  schedulerController = controller;
  return controller;
}

/** 返回当前进程的批量调度器；未启动时为 null。 */
export function getBatchSchedulerController(): SchedulerController | null {
  return schedulerController;
}

/**
 * 唤醒空闲执行位(入队、资源释放或控制态变化后调用)。
 * 未启动或正在停止时返回 false;唤醒本身幂等,可由任意 API 请求重复调用。
 */
export function wakeBatchScheduler(): boolean {
  if (!schedulerInstance || schedulerInstance.stopped) return false;
  schedulerInstance.wake.wake();
  return true;
}

/** 测试用:重置进程内单例状态。 */
export async function resetSchedulerSingletonForTests(): Promise<void> {
  await schedulerController?.stop();
  schedulerInstance = null;
  schedulerController = null;
  setBatchSchedulerDraining(false);
}

export { nowIso };
