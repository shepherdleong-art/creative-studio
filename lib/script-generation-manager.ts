import type { ScriptGenerationProgress } from './script-generation-v3.ts';

// ── 类型 ──

export type ScriptGenerationState =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ScriptGenerationSnapshot {
  generationId: string;
  projectId: string;
  state: ScriptGenerationState;
  progress: ScriptGenerationProgress;
  draftId: string | null;
  error: { code: string; message: string } | null;
  cancellationReason: 'user' | 'shutdown' | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScriptGenerationExecutionResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ScriptGenerationTaskInput {
  projectId: string;
  generationId: string;
  /** 由调用方注入的真实生成执行器；必须尊重 signal 取消。 */
  execute(context: {
    signal: AbortSignal;
    onProgress: (progress: ScriptGenerationProgress) => void;
  }): Promise<ScriptGenerationExecutionResult>;
}

export interface ScriptGenerationStartResult {
  created: boolean;
  snapshot: ScriptGenerationSnapshot;
}

export class ScriptGenerationShuttingDownError extends Error {
  readonly code = 'script_generation_shutting_down';

  constructor() {
    super('服务正在关闭，无法开始新的脚本生成');
    this.name = 'ScriptGenerationShuttingDownError';
  }
}

// ── 进程级单例注册表 ──
// Next 路由模块重载或不同服务端入口可能各自加载一份本模块；
// 注册表挂在 globalThis 的 Symbol.for 键上，保证全进程只有一套状态。

interface ScriptGenerationTaskRecord {
  projectId: string;
  generationId: string;
  controller: AbortController;
  state: ScriptGenerationState;
  progress: ScriptGenerationProgress;
  draftId: string | null;
  error: { code: string; message: string } | null;
  cancellationReason: 'user' | 'shutdown' | null;
  startedAt: string;
  finishedAt: string | null;
  terminalAtMs: number | null;
}

interface ScriptGenerationRegistry {
  byKey: Map<string, ScriptGenerationTaskRecord>;
  activeByProject: Map<string, string>;
  latestByProject: Map<string, string>;
  shuttingDown: boolean;
  now: () => number;
  terminalTtlMs: number;
}

const DEFAULT_TERMINAL_TTL_MS = 10 * 60 * 1000;
const REGISTRY_KEY = Symbol.for('creative-studio.script-generation-manager');

function registry(): ScriptGenerationRegistry {
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  if (!globalScope[REGISTRY_KEY]) {
    globalScope[REGISTRY_KEY] = {
      byKey: new Map(),
      activeByProject: new Map(),
      latestByProject: new Map(),
      shuttingDown: false,
      now: () => Date.now(),
      terminalTtlMs: DEFAULT_TERMINAL_TTL_MS,
    } satisfies ScriptGenerationRegistry;
  }
  return globalScope[REGISTRY_KEY] as ScriptGenerationRegistry;
}

function taskKey(projectId: string, generationId: string): string {
  return `${projectId}:${generationId}`;
}

const INITIAL_PROGRESS: ScriptGenerationProgress = {
  phase: 'preparing',
  percent: 0,
  message: '已接受生成任务，等待开始',
};

function toSnapshot(record: ScriptGenerationTaskRecord): ScriptGenerationSnapshot {
  return {
    generationId: record.generationId,
    projectId: record.projectId,
    state: record.state,
    progress: { ...record.progress },
    draftId: record.draftId,
    error: record.error ? { ...record.error } : null,
    cancellationReason: record.cancellationReason,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

function sanitizeError(body: Record<string, unknown>): { code: string; message: string } {
  const rawCode = typeof body.error === 'string' ? body.error : '';
  const rawMessage = typeof body.message === 'string' ? body.message : '';
  return {
    code: rawCode || 'script_generation_failed',
    message: rawMessage || rawCode || '脚本生成失败',
  };
}

/** 只有仍处 running 的任务允许落入终态；取消/停机后的迟到结果一律丢弃。 */
function settle(
  record: ScriptGenerationTaskRecord,
  apply: () => void,
): void {
  if (record.state !== 'running') return;
  apply();
  const reg = registry();
  record.finishedAt = new Date(reg.now()).toISOString();
  record.terminalAtMs = reg.now();
  if (reg.activeByProject.get(record.projectId) === record.generationId) {
    reg.activeByProject.delete(record.projectId);
  }
  reg.latestByProject.set(record.projectId, record.generationId);
}

function cancelRecord(record: ScriptGenerationTaskRecord, reason: 'user' | 'shutdown'): void {
  settle(record, () => {
    record.state = 'cancelled';
    record.cancellationReason = reason;
  });
  record.controller.abort();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || error.message === '脚本生成已取消');
}

// ── 公开 API ──

/**
 * 启动或取得脚本生成任务。注册项目占用发生在任何异步模型调用之前，
 * 依赖单 Node 进程事件循环完成原子检查。
 */
export function startScriptGeneration(input: ScriptGenerationTaskInput): ScriptGenerationStartResult {
  const reg = registry();
  const key = taskKey(input.projectId, input.generationId);
  const existing = reg.byKey.get(key);
  if (existing) return { created: false, snapshot: toSnapshot(existing) };

  const activeId = reg.activeByProject.get(input.projectId);
  const active = activeId ? reg.byKey.get(taskKey(input.projectId, activeId)) : undefined;
  if (active && active.state === 'running') {
    return { created: false, snapshot: toSnapshot(active) };
  }

  if (reg.shuttingDown) throw new ScriptGenerationShuttingDownError();

  const record: ScriptGenerationTaskRecord = {
    projectId: input.projectId,
    generationId: input.generationId,
    controller: new AbortController(),
    state: 'running',
    progress: { ...INITIAL_PROGRESS },
    draftId: null,
    error: null,
    cancellationReason: null,
    startedAt: new Date(reg.now()).toISOString(),
    finishedAt: null,
    terminalAtMs: null,
  };
  reg.byKey.set(key, record);
  reg.activeByProject.set(input.projectId, input.generationId);
  reg.latestByProject.set(input.projectId, input.generationId);

  const onProgress = (progress: ScriptGenerationProgress) => {
    if (record.state !== 'running') return;
    record.progress = { ...progress };
  };

  // 后台 Promise 在管理器内部完整捕获成功/失败/取消，不产生未处理 rejection。
  void (async () => {
    try {
      const result = await input.execute({ signal: record.controller.signal, onProgress });
      settle(record, () => {
        if (record.controller.signal.aborted) {
          record.state = 'cancelled';
          record.cancellationReason = record.cancellationReason ?? 'user';
          return;
        }
        if (result.status < 400 && typeof result.body.draftId === 'string') {
          record.state = 'succeeded';
          record.draftId = result.body.draftId;
        } else {
          record.state = 'failed';
          record.error = sanitizeError(result.body);
        }
      });
    } catch (error) {
      settle(record, () => {
        if (record.controller.signal.aborted || isAbortError(error)) {
          record.state = 'cancelled';
          record.cancellationReason = record.cancellationReason ?? 'user';
        } else {
          record.state = 'failed';
          record.error = {
            code: 'script_generation_error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  })();

  return { created: true, snapshot: toSnapshot(record) };
}

/** 项目当前活动任务；无活动任务时返回 10 分钟内的最近终态，过期返回 null。 */
export function getProjectScriptGeneration(projectId: string): ScriptGenerationSnapshot | null {
  const reg = registry();
  const activeId = reg.activeByProject.get(projectId);
  const active = activeId ? reg.byKey.get(taskKey(projectId, activeId)) : undefined;
  if (active && active.state === 'running') return toSnapshot(active);

  const latestId = reg.latestByProject.get(projectId);
  const latest = latestId ? reg.byKey.get(taskKey(projectId, latestId)) : undefined;
  if (!latest) return null;
  if (latest.terminalAtMs !== null && reg.now() - latest.terminalAtMs > reg.terminalTtlMs) {
    reg.byKey.delete(taskKey(projectId, latest.generationId));
    if (reg.latestByProject.get(projectId) === latest.generationId) {
      reg.latestByProject.delete(projectId);
    }
    return null;
  }
  return toSnapshot(latest);
}

/** 显式取消。仅运行中任务可取消并返回 true；终态或不存在返回 false。 */
export function cancelScriptGeneration(projectId: string, generationId: string): boolean {
  const record = registry().byKey.get(taskKey(projectId, generationId));
  if (!record || record.state !== 'running') return false;
  cancelRecord(record, 'user');
  return true;
}

/** 停机：拒绝新任务，并以 shutdown 原因取消全部运行中任务。返回取消数量。 */
export function beginScriptGenerationShutdown(): number {
  const reg = registry();
  reg.shuttingDown = true;
  let aborted = 0;
  for (const record of reg.byKey.values()) {
    if (record.state === 'running') {
      cancelRecord(record, 'shutdown');
      aborted += 1;
    }
  }
  return aborted;
}

export function isScriptGenerationShuttingDown(): boolean {
  return registry().shuttingDown;
}

/** 等待全部任务离开 running；返回超时后仍未完成的任务数。 */
export async function waitForScriptGenerationsIdle(timeoutMs: number): Promise<number> {
  const reg = registry();
  const deadline = reg.now() + Math.max(0, timeoutMs);
  for (;;) {
    let running = 0;
    for (const record of reg.byKey.values()) {
      if (record.state === 'running') running += 1;
    }
    if (running === 0 || reg.now() >= deadline) return running;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ── 测试专用 ──

/** 测试用：覆盖时钟与终态保留时长；传 null 恢复默认。生产代码不应调用。 */
export function configureScriptGenerationManagerForTests(
  overrides: { now?: () => number; terminalTtlMs?: number } | null,
): void {
  const reg = registry();
  reg.now = overrides?.now ?? (() => Date.now());
  reg.terminalTtlMs = overrides?.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
}

/** 测试用：清空注册表（不 abort 运行中任务，测试应自行结束它们）。生产代码不应调用。 */
export function resetScriptGenerationManagerForTests(): void {
  const reg = registry();
  reg.byKey.clear();
  reg.activeByProject.clear();
  reg.latestByProject.clear();
  reg.shuttingDown = false;
}
