/**
 * 运行与任务的持久化（技术约定 C2／C3／C4）。
 *
 * 这里只做存储与状态推进，不调用任何供应商：
 * - 幂等创建：同一 requestKey 重放返回原 run／task，同 key 不同内容冲突；
 * - 名额：slotHeld 是持久化并发名额，按 SQLite 写事务领取，跨实例也不超过全局上限；
 * - lease 是本地工作权，与名额分开，过期只允许接管安全的查询／下载。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CanvasError } from './errors.ts';
import type { CanvasPlan, CanvasPlanTask } from './planner.ts';
import {
  CANVAS_SLOT_HOLDING_TASK_PHASES,
  isTerminalTaskPhase,
  type CanvasMediaKind,
  type CanvasReferenceRole,
  type CanvasSubmissionState,
  type CanvasTaskPhase,
} from './types.ts';

export const CANVAS_DEFAULT_GLOBAL_TASK_LIMIT = 10;
export const CANVAS_DEFAULT_TASK_LEASE_MS = 60_000;

export interface CanvasRunRecord {
  id: string;
  canvasId: string;
  requestKey: string;
  requestHash: string;
  mode: 'single' | 'branch';
  planSnapshot: string;
  status: string;
  resumeRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasTaskRecord {
  id: string;
  runId: string | null;
  canvasId: string;
  nodeId: string;
  nodeEpoch: number;
  mediaKind: Exclude<CanvasMediaKind, 'audio'>;
  phase: CanvasTaskPhase;
  providerSnapshot: string;
  parameterSnapshot: string;
  providerTaskId: string | null;
  submissionState: CanvasSubmissionState;
  slotHeld: boolean;
  quotaKey: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  fence: number;
  cancelRequestedAt: string | null;
  outputAssetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastPolledAt: string | null;
  pollCount: number;
  /** 同一次 run 内的变体编号（single 从 0 递增；branch 恒为 0）。 */
  variantIndex: number;
  createdAt: string;
  updatedAt: string;
}

/** single 模式下单个节点允许的并发任务上限（已有活跃 + 本次变体）。 */
export const MAX_NODE_VARIANTS = 8;

export interface CanvasTaskInputRecord {
  id: string;
  taskId: string;
  refId: string;
  orderIndex: number;
  role: CanvasReferenceRole;
  note: string;
  sourceNodeId: string | null;
  assetId: string | null;
  upstreamTaskId: string | null;
  textContent: string | null;
  resolvedAssetId: string | null;
}

export function phaseHoldsTaskSlot(phase: CanvasTaskPhase): boolean {
  return CANVAS_SLOT_HOLDING_TASK_PHASES.includes(phase);
}

function rowToTask(row: Record<string, unknown>): CanvasTaskRecord {
  return {
    id: String(row.id),
    runId: row.runId === null || row.runId === undefined ? null : String(row.runId),
    canvasId: String(row.canvasId),
    nodeId: String(row.nodeId),
    nodeEpoch: Number(row.nodeEpoch),
    mediaKind: row.mediaKind as 'image' | 'video',
    phase: row.phase as CanvasTaskPhase,
    providerSnapshot: String(row.providerSnapshot ?? '{}'),
    parameterSnapshot: String(row.parameterSnapshot ?? '{}'),
    providerTaskId: row.providerTaskId === null || row.providerTaskId === undefined ? null : String(row.providerTaskId),
    submissionState: row.submissionState as CanvasSubmissionState,
    slotHeld: Number(row.slotHeld) === 1,
    quotaKey: row.quotaKey === null || row.quotaKey === undefined ? null : String(row.quotaKey),
    leaseOwner: row.leaseOwner === null || row.leaseOwner === undefined ? null : String(row.leaseOwner),
    leaseUntil: row.leaseUntil === null || row.leaseUntil === undefined ? null : String(row.leaseUntil),
    fence: Number(row.fence),
    cancelRequestedAt: row.cancelRequestedAt === null || row.cancelRequestedAt === undefined
      ? null
      : String(row.cancelRequestedAt),
    outputAssetId: row.outputAssetId === null || row.outputAssetId === undefined ? null : String(row.outputAssetId),
    errorCode: row.errorCode === null || row.errorCode === undefined ? null : String(row.errorCode),
    variantIndex: Number(row.variantIndex ?? 0),
    errorMessage: row.errorMessage === null || row.errorMessage === undefined ? null : String(row.errorMessage),
    lastPolledAt: row.lastPolledAt === null || row.lastPolledAt === undefined ? null : String(row.lastPolledAt),
    pollCount: Number(row.pollCount ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function rowToInput(row: Record<string, unknown>): CanvasTaskInputRecord {
  return {
    id: String(row.id),
    taskId: String(row.taskId),
    refId: String(row.refId),
    orderIndex: Number(row.orderIndex),
    role: row.role as CanvasReferenceRole,
    note: String(row.note ?? ''),
    sourceNodeId: row.sourceNodeId === null || row.sourceNodeId === undefined ? null : String(row.sourceNodeId),
    assetId: row.assetId === null || row.assetId === undefined ? null : String(row.assetId),
    upstreamTaskId: row.upstreamTaskId === null || row.upstreamTaskId === undefined ? null : String(row.upstreamTaskId),
    textContent: row.textContent === null || row.textContent === undefined ? null : String(row.textContent),
    resolvedAssetId: row.resolvedAssetId === null || row.resolvedAssetId === undefined ? null : String(row.resolvedAssetId),
  };
}

export function getCanvasTask(db: Database.Database, taskId: string): CanvasTaskRecord | null {
  const row = db.prepare(`SELECT * FROM creative_canvas_tasks WHERE id = ?`).get(taskId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTask(row) : null;
}

export function requireCanvasTask(db: Database.Database, taskId: string): CanvasTaskRecord {
  const task = getCanvasTask(db, taskId);
  if (!task) throw new CanvasError('not_found', '任务不存在。');
  return task;
}

export function listCanvasTaskInputs(db: Database.Database, taskId: string): CanvasTaskInputRecord[] {
  return (db.prepare(
    `SELECT * FROM creative_canvas_task_inputs WHERE taskId = ? ORDER BY orderIndex`,
  ).all(taskId) as Array<Record<string, unknown>>).map(rowToInput);
}

export function listCanvasTasksForRun(db: Database.Database, runId: string): CanvasTaskRecord[] {
  return (db.prepare(
    `SELECT * FROM creative_canvas_tasks WHERE runId = ? ORDER BY createdAt, nodeId`,
  ).all(runId) as Array<Record<string, unknown>>).map(rowToTask);
}

export function listCanvasTasks(
  db: Database.Database,
  params: { canvasId?: string; phases?: CanvasTaskPhase[]; limit?: number } = {},
): CanvasTaskRecord[] {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  if (params.canvasId && params.phases && params.phases.length > 0) {
    const placeholders = params.phases.map(() => '?').join(',');
    return (db.prepare(
      `SELECT * FROM creative_canvas_tasks WHERE canvasId = ? AND phase IN (${placeholders}) ORDER BY createdAt DESC LIMIT ?`,
    ).all(params.canvasId, ...params.phases, limit) as Array<Record<string, unknown>>).map(rowToTask);
  }
  if (params.canvasId) {
    return (db.prepare(
      `SELECT * FROM creative_canvas_tasks WHERE canvasId = ? ORDER BY createdAt DESC LIMIT ?`,
    ).all(params.canvasId, limit) as Array<Record<string, unknown>>).map(rowToTask);
  }
  return (db.prepare(
    `SELECT * FROM creative_canvas_tasks ORDER BY createdAt DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>).map(rowToTask);
}

/** 同一节点至多一个未结束任务；数据库部分唯一索引兜底。 */
export function findActiveTaskForCanvasNode(
  db: Database.Database,
  canvasId: string,
  nodeId: string,
): CanvasTaskRecord | null {
  const row = db.prepare(`
    SELECT * FROM creative_canvas_tasks
     WHERE canvasId = ? AND nodeId = ?
       AND phase NOT IN ('succeeded','failed','blocked','cancelled')
     ORDER BY createdAt DESC LIMIT 1
  `).get(canvasId, nodeId) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function findCanvasRunByRequestKey(
  db: Database.Database,
  canvasId: string,
  requestKey: string,
): CanvasRunRecord | null {
  const row = db.prepare(
    `SELECT * FROM creative_canvas_runs WHERE canvasId = ? AND requestKey = ?`,
  ).get(canvasId, requestKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    canvasId: String(row.canvasId),
    requestKey: String(row.requestKey),
    requestHash: String(row.requestHash),
    mode: row.mode as 'single' | 'branch',
    planSnapshot: String(row.planSnapshot),
    status: String(row.status),
    resumeRequired: Number(row.resumeRequired) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export interface CreateCanvasRunResult {
  run: CanvasRunRecord;
  tasks: CanvasTaskRecord[];
  idempotentReplay: boolean;
}

/**
 * 事务内幂等创建 run／tasks／inputs，并建立节点活跃关联。
 * 重放查询先于当前图与活跃状态检查：图后来改了、任务已经开始，都不能拒绝同一请求的重放。
 */
export function createCanvasRun(
  db: Database.Database,
  params: { plan: CanvasPlan; requestHash: string; now?: () => Date },
): CreateCanvasRunResult {
  const { plan, requestHash } = params;
  const now = params.now ?? (() => new Date());
  const runId = randomUUID();

  const execute = db.transaction((): CreateCanvasRunResult => {
    const existing = findCanvasRunByRequestKey(db, plan.canvasId, plan.requestKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new CanvasError('conflict', '同一请求标识对应了不同的计划内容。', {
          runId: existing.id,
        });
      }
      return {
        run: existing,
        tasks: listCanvasTasksForRun(db, existing.id),
        idempotentReplay: true,
      };
    }

    const currentCanvas = db.prepare(`SELECT graphRevision FROM creative_canvases WHERE id = ?`).get(plan.canvasId) as
      | { graphRevision: number } | undefined;
    if (!currentCanvas || Number(currentCanvas.graphRevision) !== plan.graphRevision) {
      throw new CanvasError('conflict', '画布已在别处修改，请刷新后重新确认。', {
        expectedGraphRevision: plan.graphRevision,
        currentGraphRevision: currentCanvas ? Number(currentCanvas.graphRevision) : null,
      });
    }

    for (const taskPlan of plan.tasks) {
      const active = findActiveTaskForCanvasNode(db, plan.canvasId, taskPlan.nodeId);
      if (active) {
        // branch 语义是整链重跑，拒绝混入并发任务；single 允许多变体并存，
        // 数量护栏在下方按节点总量检查。
        if (plan.mode === 'branch') {
          throw new CanvasError('conflict', `节点 ${taskPlan.nodeId} 已有正在进行的任务。`, {
            nodeId: taskPlan.nodeId,
            activeTaskId: active.id,
          });
        }
      }
    }
    if (plan.mode === 'single') {
      // 单节点并发变体上限：已有活跃任务 + 本次变体数不得超过 MAX_NODE_VARIANTS
      const nodeIds = new Set(plan.tasks.map((taskPlan) => taskPlan.nodeId));
      for (const nodeId of nodeIds) {
        const variantCount = plan.tasks.filter((taskPlan) => taskPlan.nodeId === nodeId).length;
        const activeCount = db.prepare(
          `SELECT COUNT(*) AS count FROM creative_canvas_tasks
           WHERE canvasId = ? AND nodeId = ? AND phase NOT IN ('succeeded','failed','blocked','cancelled')`,
        ).get(plan.canvasId, nodeId) as { count: number };
        if (Number(activeCount.count) + variantCount > MAX_NODE_VARIANTS) {
          throw new CanvasError('node_variant_limit',
            `该节点的并发任务数已达上限（${MAX_NODE_VARIANTS}）：请等部分任务完成后再追加变体。`, {
              nodeId,
              limit: MAX_NODE_VARIANTS,
            });
        }
      }
    }

    const at = now().toISOString();
    db.prepare(`
      INSERT INTO creative_canvas_runs
        (id, canvasId, requestKey, requestHash, mode, planSnapshot, status, resumeRequired, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)
    `).run(runId, plan.canvasId, plan.requestKey, requestHash, plan.mode, JSON.stringify(plan), at, at);

    const taskIdByNode = new Map<string, string>();
    // 与 plan.tasks 顺序一致的 taskId（single 多变体同 nodeId，不能只用 Map）
    const taskIds: string[] = [];
    const insertTask = db.prepare(`
      INSERT INTO creative_canvas_tasks
        (id, runId, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot,
         providerTaskId, submissionState, slotHeld, quotaKey, leaseOwner, leaseUntil, fence,
         cancelRequestedAt, outputAssetId, errorCode, errorMessage, lastPolledAt, pollCount,
         variantIndex, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'not_sent', 0, ?, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, 0, ?, ?, ?)
    `);

    const created: CanvasTaskRecord[] = [];
    plan.tasks.forEach((taskPlan, planIndex) => {
      const taskId = randomUUID();
      taskIds.push(taskId);
      // 覆盖式记录：同节点多变体时 activeTaskId 绑定最后创建的变体；
      // branch 模式每节点一任务，上游解析（taskIdByNode.get）不受覆盖影响。
      taskIdByNode.set(taskPlan.nodeId, taskId);
      // 等待上游的任务不占名额；输入全部就绪的直接排队
      const waitsForUpstream = taskPlan.inputs.some(
        (input) => input.upstreamNodeId !== null || input.upstreamTaskId !== null,
      );
      const phase: CanvasTaskPhase = waitsForUpstream ? 'waiting_input' : 'queued';
      insertTask.run(
        taskId,
        runId,
        plan.canvasId,
        taskPlan.nodeId,
        taskPlan.nodeEpoch,
        taskPlan.mediaKind,
        phase,
        JSON.stringify({
          capabilityKey: taskPlan.capabilityKey,
          providerIdentity: taskPlan.providerIdentity,
          modelAlias: taskPlan.modelAlias,
        }),
        JSON.stringify({
          generationMode: taskPlan.generationMode,
          prompt: taskPlan.prompt,
          parameters: taskPlan.parameters,
        }),
        taskPlan.capabilityKey,
        // 变体编号：branch（每节点一任务）与历史任务恒为 0
        plan.mode === 'single' ? planIndex : 0,
        at,
        at,
      );
      created.push(requireCanvasTask(db, taskId));
    });

    const insertInput = db.prepare(`
      INSERT INTO creative_canvas_task_inputs
        (id, taskId, refId, orderIndex, role, note, sourceNodeId, assetId, upstreamTaskId, textContent, resolvedAssetId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    plan.tasks.forEach((taskPlan, planIndex) => {
      const taskId = taskIds[planIndex];
      for (const input of taskPlan.inputs) {
        // 计划内的上游解析成本次运行的任务；单点绑定则沿用已存在的任务身份
        const upstreamTaskId = input.upstreamNodeId
          ? taskIdByNode.get(input.upstreamNodeId) ?? null
          : input.upstreamTaskId;
        insertInput.run(
          randomUUID(),
          taskId,
          input.refId,
          input.orderIndex,
          input.role,
          input.note,
          input.sourceNodeId,
          input.assetId,
          upstreamTaskId,
          input.textContent,
          at,
        );
      }
    });

    const bindActive = db.prepare(
      `UPDATE creative_canvas_node_states SET activeTaskId = ?, updatedAt = ? WHERE canvasId = ? AND nodeId = ?`,
    );
    for (const taskPlan of plan.tasks) {
      const info = bindActive.run(taskIdByNode.get(taskPlan.nodeId) as string, at, plan.canvasId, taskPlan.nodeId);
      if (info.changes === 0) {
        throw new CanvasError('invalid_input', `节点 ${taskPlan.nodeId} 不在当前画布中。`);
      }
    }

    const run = findCanvasRunByRequestKey(db, plan.canvasId, plan.requestKey);
    if (!run) throw new CanvasError('conflict', '运行创建失败。');
    return { run, tasks: created, idempotentReplay: false };
  });

  return execute.immediate();
}

/**
 * 让等待输入的任务前进一步：
 * - 上游成功 → 把该次任务的产物登记为已解析输入；
 * - 上游失败／取消且没有产物 → 本次依赖阻塞（不改等后来新建的任务）；
 * - 全部输入就绪 → 进入排队。
 */
export function resolveCanvasTaskInputs(
  db: Database.Database,
  now: () => Date = () => new Date(),
): { promoted: string[]; blocked: string[] } {
  const execute = db.transaction(() => {
    const promoted: string[] = [];
    const blocked: string[] = [];
    const waiting = db.prepare(
      `SELECT * FROM creative_canvas_tasks WHERE phase = 'waiting_input' ORDER BY createdAt, rowid`,
    ).all() as Array<Record<string, unknown>>;

    for (const raw of waiting) {
      const task = rowToTask(raw);
      const inputs = listCanvasTaskInputs(db, task.id);
      let stillWaiting = false;
      let upstreamFailed: CanvasTaskRecord | null = null;

      for (const input of inputs) {
        if (!input.upstreamTaskId || input.resolvedAssetId) continue;
        const upstream = getCanvasTask(db, input.upstreamTaskId);
        if (!upstream) {
          upstreamFailed = upstreamFailed ?? null;
          stillWaiting = true;
          continue;
        }
        if (upstream.outputAssetId) {
          db.prepare(
            `UPDATE creative_canvas_task_inputs SET resolvedAssetId = ? WHERE id = ?`,
          ).run(upstream.outputAssetId, input.id);
          continue;
        }
        if (isTerminalTaskPhase(upstream.phase)) {
          upstreamFailed = upstream;
          continue;
        }
        stillWaiting = true;
      }

      const at = now().toISOString();
      if (upstreamFailed) {
        db.prepare(`
          UPDATE creative_canvas_tasks
             SET phase = 'blocked', slotHeld = 0, errorCode = 'upstream_incomplete',
                 errorMessage = ?, updatedAt = ?
           WHERE id = ?
        `).run('上游任务未完成，本次依赖已停止推进。', at, task.id);
        db.prepare(
          `UPDATE creative_canvas_node_states SET activeTaskId = NULL, updatedAt = ? WHERE canvasId = ? AND nodeId = ? AND activeTaskId = ?`,
        ).run(at, task.canvasId, task.nodeId, task.id);
        blocked.push(task.id);
        continue;
      }
      if (!stillWaiting) {
        db.prepare(
          `UPDATE creative_canvas_tasks SET phase = 'queued', updatedAt = ? WHERE id = ?`,
        ).run(at, task.id);
        promoted.push(task.id);
      }
    }
    return { promoted, blocked };
  });
  return execute.immediate();
}

export interface ClaimCanvasTasksOptions {
  db: Database.Database;
  workerId: string;
  limit?: number;
  globalLimit?: number;
  leaseMs?: number;
  now?: () => Date;
  /** 每个 quotaKey 的并发上限；未列出的按全局上限。 */
  quotaLimits?: Record<string, number>;
  /** 任务已由本进程在飞时不得再次领取（避免先改 fence 再跳过）。 */
  skipTaskIds?: ReadonlySet<string>;
}

export interface ClaimedCanvasTask {
  task: CanvasTaskRecord;
  fence: number;
}

/**
 * 在单个 SQLite 写事务里完成「计数 → 领取 → 置 slotHeld」。
 * 两个调度器实例同时领取也不会超过全局名额；模型名额不足时跳过该任务继续扫描。
 */
export function claimCanvasTasks(options: ClaimCanvasTasksOptions): ClaimedCanvasTask[] {
  const {
    db,
    workerId,
    limit = CANVAS_DEFAULT_GLOBAL_TASK_LIMIT,
    globalLimit = CANVAS_DEFAULT_GLOBAL_TASK_LIMIT,
    leaseMs = CANVAS_DEFAULT_TASK_LEASE_MS,
    now = () => new Date(),
    quotaLimits = {}, skipTaskIds = new Set<string>(),
  } = options;

  const execute = db.transaction((): ClaimedCanvasTask[] => {
    const held = Number((db.prepare(
      `SELECT COUNT(*) AS count FROM creative_canvas_tasks WHERE slotHeld = 1`,
    ).get() as { count: number }).count);
    // 已有 providerTaskId 的过期任务接管原名额，不需要等待新的全局名额。
    let remaining = Math.min(limit, Math.max(globalLimit - held, 0));
    let budget = limit;

    const atIso = now().toISOString();
    const candidates = db.prepare(`
      SELECT * FROM creative_canvas_tasks
       WHERE (phase = 'queued' AND slotHeld = 0)
          OR (providerTaskId IS NOT NULL
              AND phase IN ('polling', 'downloading')
              AND (leaseUntil IS NULL OR leaseUntil < ?))
       ORDER BY createdAt, rowid
    `).all(atIso) as Array<Record<string, unknown>>;

    const quotaUsage = new Map<string, number>();
    for (const row of db.prepare(
      `SELECT quotaKey, COUNT(*) AS count FROM creative_canvas_tasks WHERE slotHeld = 1 GROUP BY quotaKey`,
    ).all() as Array<{ quotaKey: string | null; count: number }>) {
      quotaUsage.set(row.quotaKey ?? '', Number(row.count));
    }

    const claimed: ClaimedCanvasTask[] = [];
    const at = now();
    const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
    // 已有远端身份的接管：只改租约，不回到 preparing（绝不能重新 POST）
    const takeover = db.prepare(`
      UPDATE creative_canvas_tasks
         SET slotHeld = 1, leaseOwner = ?, leaseUntil = ?, fence = fence + 1, updatedAt = ?
       WHERE id = ? AND providerTaskId IS NOT NULL AND phase IN ('polling', 'downloading')
         AND (leaseUntil IS NULL OR leaseUntil < ?)
    `);
    const claim = db.prepare(`
      UPDATE creative_canvas_tasks
         SET phase = 'preparing', slotHeld = 1, leaseOwner = ?, leaseUntil = ?, fence = fence + 1, updatedAt = ?
       WHERE id = ? AND phase = 'queued' AND slotHeld = 0
    `);

    for (const row of candidates) {
      if (budget <= 0) break;
      const task = rowToTask(row);
      if (skipTaskIds.has(task.id)) continue;
      const quotaKey = task.quotaKey ?? '';
      const quotaLimit = quotaLimits[quotaKey] ?? globalLimit;
      const used = quotaUsage.get(quotaKey) ?? 0;
      const takeoverCandidate = task.providerTaskId !== null && task.slotHeld;
      const needsNewSlot = !takeoverCandidate;
      if (needsNewSlot && (remaining <= 0 || used >= quotaLimit)) continue;
      const info = takeoverCandidate
        ? takeover.run(workerId, leaseUntil, atIso, task.id, atIso)
        : task.providerTaskId
          ? db.prepare(`UPDATE creative_canvas_tasks SET slotHeld = 1, leaseOwner = ?, leaseUntil = ?, fence = fence + 1, updatedAt = ? WHERE id = ? AND providerTaskId IS NOT NULL AND phase IN ('polling','downloading') AND slotHeld = 0`).run(workerId, leaseUntil, atIso, task.id)
          : claim.run(workerId, leaseUntil, atIso, task.id);
      if (info.changes !== 1) continue;
      if (needsNewSlot) quotaUsage.set(quotaKey, used + 1);
      budget -= 1;
      if (needsNewSlot) remaining -= 1;
      const updated = requireCanvasTask(db, task.id);
      claimed.push({ task: updated, fence: updated.fence });
    }
    return claimed;
  });

  return execute.immediate();
}

export interface CanvasTaskPatch {
  phase?: CanvasTaskPhase;
  providerTaskId?: string | null;
  submissionState?: CanvasSubmissionState;
  outputAssetId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  lastPolledAt?: string | null;
  pollCount?: number;
  cancelRequestedAt?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
}

/**
 * 带 fence／leaseOwner 守卫的状态推进：失去所有权的 worker 不能继续写状态。
 * phase 变化时同步维护 slotHeld（占名额的阶段见 C4 表）。
 */
export function updateCanvasTaskGuarded(
  db: Database.Database,
  params: {
    taskId: string;
    patch: CanvasTaskPatch;
    guard: { fence: number; workerId: string };
    now?: () => Date;
  },
): boolean {
  const { taskId, patch, guard } = params;
  const at = (params.now ?? (() => new Date()))().toISOString();
  const sets: string[] = ['updatedAt = @updatedAt'];
  const values: Record<string, unknown> = { updatedAt: at, taskId, fence: guard.fence, workerId: guard.workerId };

  const assign = (column: string, key: string, value: unknown) => {
    sets.push(`${column} = @${key}`);
    values[key] = value;
  };

  if (patch.phase !== undefined) {
    assign('phase', 'phase', patch.phase);
    assign('slotHeld', 'slotHeld', phaseHoldsTaskSlot(patch.phase) ? 1 : 0);
  }
  if (patch.providerTaskId !== undefined) assign('providerTaskId', 'providerTaskId', patch.providerTaskId);
  if (patch.submissionState !== undefined) assign('submissionState', 'submissionState', patch.submissionState);
  if (patch.outputAssetId !== undefined) assign('outputAssetId', 'outputAssetId', patch.outputAssetId);
  if (patch.errorCode !== undefined) assign('errorCode', 'errorCode', patch.errorCode);
  if (patch.errorMessage !== undefined) assign('errorMessage', 'errorMessage', patch.errorMessage);
  if (patch.lastPolledAt !== undefined) assign('lastPolledAt', 'lastPolledAt', patch.lastPolledAt);
  if (patch.pollCount !== undefined) assign('pollCount', 'pollCount', patch.pollCount);
  if (patch.cancelRequestedAt !== undefined) assign('cancelRequestedAt', 'cancelRequestedAt', patch.cancelRequestedAt);
  if (patch.leaseOwner !== undefined) assign('leaseOwner', 'leaseOwner', patch.leaseOwner);
  if (patch.leaseUntil !== undefined) assign('leaseUntil', 'leaseUntil', patch.leaseUntil);

  const info = db.prepare(`
    UPDATE creative_canvas_tasks SET ${sets.join(', ')}
     WHERE id = @taskId AND fence = @fence AND leaseOwner = @workerId
  `).run(values);
  return info.changes === 1;
}

/**
 * 不带 fence 守卫的状态更新：只允许恢复／核查流程使用（没有在飞 worker 时才安全）。
 * 提交与发布路径必须继续用 updateCanvasTaskGuarded。
 */
export function updateCanvasTaskUnGuarded(
  db: Database.Database,
  taskId: string,
  patch: Partial<CanvasTaskRecord> & { updatedAt?: string },
): boolean {
  const columns = [
    'phase', 'providerTaskId', 'submissionState', 'slotHeld', 'outputAssetId',
    'errorCode', 'errorMessage', 'lastPolledAt', 'pollCount', 'cancelRequestedAt',
    'leaseOwner', 'leaseUntil', 'updatedAt',
  ] as const;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const column of columns) {
    if (!(column in patch)) continue;
    const value = (patch as Record<string, unknown>)[column];
    sets.push(`${column} = ?`);
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (sets.length === 0) return false;
  values.push(taskId);
  const info = db.prepare(`UPDATE creative_canvas_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return info.changes === 1;
}

export function releaseCanvasTaskLease(
  db: Database.Database,
  params: { taskId: string; now?: () => Date },
): void {
  db.prepare(
    `UPDATE creative_canvas_tasks SET leaseOwner = NULL, leaseUntil = NULL, updatedAt = ? WHERE id = ?`,
  ).run((params.now ?? (() => new Date()))().toISOString(), params.taskId);
}

/** 租约续期与状态写入使用同一 fence，避免长时间供应商调用期间被安全接管。 */
export function renewCanvasTaskLease(
  db: Database.Database,
  params: { taskId: string; fence: number; workerId: string; leaseMs: number; now?: () => Date },
): boolean {
  const now = (params.now ?? (() => new Date()))();
  const until = new Date(now.getTime() + params.leaseMs).toISOString();
  const info = db.prepare(`
    UPDATE creative_canvas_tasks SET leaseUntil = ?, updatedAt = ?
     WHERE id = ? AND fence = ? AND leaseOwner = ? AND slotHeld = 1
  `).run(until, now.toISOString(), params.taskId, params.fence, params.workerId);
  return info.changes === 1;
}

/** 服务端记录节点与任务的关联（发布检查使用 node_states.activeTaskId）。 */
export function bindCanvasNodeActiveTask(
  db: Database.Database,
  params: { canvasId: string; nodeId: string; taskId: string | null; now?: () => Date },
): void {
  db.prepare(
    `UPDATE creative_canvas_node_states SET activeTaskId = ?, updatedAt = ? WHERE canvasId = ? AND nodeId = ?`,
  ).run(params.taskId, (params.now ?? (() => new Date()))().toISOString(), params.canvasId, params.nodeId);
}

export interface CanvasTaskSlotUsage {
  held: number;
  byQuotaKey: Record<string, number>;
}

export function canvasTaskSlotUsage(db: Database.Database): CanvasTaskSlotUsage {
  const held = Number((db.prepare(
    `SELECT COUNT(*) AS count FROM creative_canvas_tasks WHERE slotHeld = 1`,
  ).get() as { count: number }).count);
  const byQuotaKey: Record<string, number> = {};
  for (const row of db.prepare(
    `SELECT quotaKey, COUNT(*) AS count FROM creative_canvas_tasks WHERE slotHeld = 1 GROUP BY quotaKey`,
  ).all() as Array<{ quotaKey: string | null; count: number }>) {
    byQuotaKey[row.quotaKey ?? ''] = Number(row.count);
  }
  return { held, byQuotaKey };
}

export type { CanvasPlanTask };
