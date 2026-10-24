import type Database from 'better-sqlite3';
import type { BatchTaskWorkType, ClaimedBatchTask } from './tasks.ts';

/**
 * 统一进度报告。不可测的阶段 percent 必须为 null,不允许伪造
 * “看起来在动”的假数字(供应商只返回处理中时显示阶段与等待)。
 */
export interface BatchTaskProgress {
  phase: string;
  description?: string;
  completed?: number;
  total?: number;
  /** 0–1;不可测时为 null */
  percent?: number | null;
  /** 任务以成功收场但实际跳过执行时给出机器可读原因(如 no-content-analysis) */
  skipped?: string;
}

export interface BatchTaskExecutionContext {
  db: Database.Database;
  claim: ClaimedBatchTask;
  signal: AbortSignal;
  /** 报告当前阶段与真实进度(调度器负责节流落库) */
  reportProgress(progress: BatchTaskProgress): void;
}

export interface BatchTaskExecutor {
  /** 该执行器接受的任务种类 */
  workTypes: BatchTaskWorkType[];
  execute(context: BatchTaskExecutionContext): Promise<{
    resultJson?: unknown;
    /** 成功执行后若调度器拒绝迟到结果，用于删除本次未被接受的候选。 */
    discard?: () => Promise<void> | void;
    /**
     * 仅做同步数据库发布；runner 会在同一个 IMMEDIATE 事务中先复核租约、
     * 任务/批次控制态，再调用它并落成功状态，避免取消后的迟到发布。
     */
    commit?: () => {
      resultJson?: unknown;
      discard?: () => Promise<void> | void;
      progress?: BatchTaskProgress;
    };
  }>;
}

/** 带机器可读 code 的执行器错误;runner 落账时优先采用 code 作为 errorCode。 */
export class BatchExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchExecutorError';
    this.code = code;
  }
}

/** 按任务种类选择执行器;没有注册执行器的任务种类返回 null。 */
export function findExecutor(
  executors: BatchTaskExecutor[],
  workType: BatchTaskWorkType,
): BatchTaskExecutor | undefined {
  return executors.find((executor) => executor.workTypes.includes(workType));
}
