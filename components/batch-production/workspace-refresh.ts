/**
 * 工作区轮询的单飞协调器。
 *
 * 批量工作区同时被「周期轮询」和「编辑/重试/发布后的立即刷新」触发。浏览器里
 * 这两个来源会重叠，直接并发 fetch 会让旧响应后到、覆盖新状态。这里保证：
 * - 同类请求同一时刻最多一个在途；
 * - 在途期间的新请求合并成一次尾随刷新（调用方的 await 要到最终状态才 resolve）；
 * - 每个请求记录发起时的 batchId 与 generation，响应回来用 `isCurrent()`
 *   再核对当前活动批次，切批次后旧响应一律忽略。
 *
 * 纯逻辑、无 React 依赖，可直接在 Node 测试里验证。
 */

export interface WorkspaceRefreshRequest {
  /** 发起请求时选中的批次。 */
  readonly batchId: string;
  /** 每次真正执行的刷新递增；用于丢弃被后续请求取代的响应。 */
  readonly generation: number;
  /** 响应回来时是否仍可落状态（活动批次未切换、且没有更新的执行）。 */
  isCurrent(): boolean;
}

export interface WorkspaceRefreshCoordinator {
  /** 切换活动批次；切换后旧批次的迟到响应会被 isCurrent() 拒绝。 */
  setActiveBatch(batchId: string): void;
  /** 发起一次刷新；同类请求最多一个在途，后到请求合并为尾随刷新。 */
  refresh(batchId: string): Promise<void>;
}

export function createRefreshCoordinator(
  worker: (request: WorkspaceRefreshRequest) => Promise<void>,
): WorkspaceRefreshCoordinator {
  let activeBatchId = '';
  let generation = 0;
  let inFlight = false;
  let queuedBatchId: string | null = null;
  let queuedResolvers: Array<() => void> = [];

  async function pump(firstBatchId: string, firstResolvers: Array<() => void>): Promise<void> {
    let batchId: string | null = firstBatchId;
    let resolvers = firstResolvers;
    while (batchId !== null) {
      const requestBatchId = batchId;
      inFlight = true;
      const requestGeneration = ++generation;
      const request: WorkspaceRefreshRequest = {
        batchId: requestBatchId,
        generation: requestGeneration,
        isCurrent: () => generation === requestGeneration && activeBatchId === requestBatchId,
      };
      try {
        await worker(request);
      } catch {
        // worker 自己负责把失败反馈给用户；协调器只保证队列继续前进。
      }
      inFlight = false;
      batchId = queuedBatchId;
      resolvers = resolvers.concat(queuedResolvers);
      queuedBatchId = null;
      queuedResolvers = [];
    }
    for (const resolve of resolvers) resolve();
  }

  return {
    setActiveBatch(batchId: string): void {
      activeBatchId = batchId;
    },
    refresh(batchId: string): Promise<void> {
      if (inFlight || queuedBatchId !== null) {
        queuedBatchId = batchId;
        return new Promise<void>((resolve) => { queuedResolvers.push(resolve); });
      }
      return new Promise<void>((resolve) => { void pump(batchId, [resolve]); });
    },
  };
}
