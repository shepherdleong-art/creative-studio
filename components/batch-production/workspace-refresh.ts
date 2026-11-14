/**
 * 工作区轮询的单飞协调器。
 *
 * 批量工作区同时被「周期轮询」和「编辑/重试/发布后的立即刷新」触发。浏览器里
 * 这两个来源会重叠，直接并发 fetch 会让旧响应后到、覆盖新状态。这里保证：
 * - 同类请求同一时刻最多一个在途；
 * - 在途期间只保留**一个**共享尾随刷新：同批次的重复请求复用同一个 Promise，
 *   所有调用方的 await 都等到这次尾随刷新结束；
 * - 非当前活动批次的请求直接 resolve（不排队、不覆盖当前批次的尾随刷新）；
 * - 每个请求记录发起时的 batchId、generation 与批次代次 epoch；响应回来用
 *   `isCurrent()` 再核对，切走再切回同一 batchId 的旧响应也会被拒绝。
 *
 * 纯逻辑、无 React 依赖，可直接在 Node 测试里验证。
 */

export interface WorkspaceRefreshRequest {
  /** 发起请求时选中的批次。 */
  readonly batchId: string;
  /** 每次真正执行的刷新递增；用于丢弃被后续请求取代的响应。 */
  readonly generation: number;
  /** 发起时的批次代次；每次活动批次变化递增，A→B→A 也能识别旧响应。 */
  readonly epoch: number;
  /** 响应回来时是否仍可落状态（批次代次与活动批次都未变化）。 */
  isCurrent(): boolean;
}

export interface WorkspaceRefreshCoordinator {
  /** 切换活动批次；切换后旧批次的迟到响应会被 isCurrent() 拒绝。 */
  setActiveBatch(batchId: string): void;
  /** 发起一次刷新；同类请求最多一个在途，后到请求合并为一次尾随刷新。 */
  refresh(batchId: string): Promise<void>;
}

/**
 * @param getActiveBatchId 同步读取当前活动批次（生产代码用 render 中更新的 ref，
 *   避免 setActiveBatch 的 effect 在切批次后、提交前仍返回旧批次）。
 *   省略时回退到 `setActiveBatch` 维护的内部值，供测试与旧调用方使用。
 * @param getBatchEpoch 同步读取批次代次；每次活动批次变化递增。生产代码用
 *   render 中维护的 ref，保证 A→B→A 时切换前发起的旧响应不会被重新接受。
 *   省略时由 `setActiveBatch` 维护。
 */
export function createRefreshCoordinator(
  worker: (request: WorkspaceRefreshRequest) => Promise<void>,
  getActiveBatchId?: () => string,
  getBatchEpoch?: () => number,
): WorkspaceRefreshCoordinator {
  let internalActiveBatchId = '';
  let internalEpoch = 0;
  const activeBatchId = (): string => getActiveBatchId?.() ?? internalActiveBatchId;
  const batchEpoch = (): number => getBatchEpoch?.() ?? internalEpoch;
  let generation = 0;
  let inFlight = false;
  /** 在途期间唯一的尾随刷新目标批次（最新活动批次胜出）。 */
  let pendingBatchId: string | null = null;
  /** 在途期间唯一的共享尾随 Promise/resolver。 */
  let pendingPromise: Promise<void> | null = null;
  let pendingResolve: (() => void) | null = null;

  async function run(requestBatchId: string): Promise<void> {
    const requestGeneration = ++generation;
    const requestEpoch = batchEpoch();
    const request: WorkspaceRefreshRequest = {
      batchId: requestBatchId,
      generation: requestGeneration,
      epoch: requestEpoch,
      isCurrent: () => generation === requestGeneration
        && batchEpoch() === requestEpoch
        && activeBatchId() === requestBatchId,
    };
    try {
      await worker(request);
    } catch {
      // worker 自己负责把失败反馈给用户；协调器只保证队列继续前进。
    }
  }

  function start(requestBatchId: string): Promise<void> {
    inFlight = true;
    return run(requestBatchId).finally(() => {
      inFlight = false;
      const nextBatchId = pendingBatchId;
      const resolve = pendingResolve;
      pendingBatchId = null;
      pendingPromise = null;
      pendingResolve = null;
      if (nextBatchId !== null) {
        // 尾随刷新沿用调用方已 await 的同一个 Promise；下一轮在途期间的
        // 新请求会创建新的共享尾随 Promise，resolver 数量始终有界。
        void start(nextBatchId).finally(() => resolve?.());
      } else {
        resolve?.();
      }
    });
  }

  function enqueueTrailing(requestBatchId: string): Promise<void> {
    if (pendingPromise === null) {
      pendingPromise = new Promise<void>((resolve) => { pendingResolve = resolve; });
    }
    // 只保留一个尾随目标：切批次后到达的当前批次请求替换旧目标，
    // 之前的等待者仍由同一个 Promise 在尾随刷新完成后统一 resolve。
    pendingBatchId = requestBatchId;
    return pendingPromise;
  }

  return {
    setActiveBatch(batchId: string): void {
      if (batchId !== internalActiveBatchId) {
        internalActiveBatchId = batchId;
        internalEpoch += 1;
      }
    },
    refresh(batchId: string): Promise<void> {
      // 非当前活动批次不参与排队：它既不需要刷新，也不得覆盖当前批次的尾随请求。
      if (batchId !== activeBatchId()) return Promise.resolve();
      if (!inFlight) return start(batchId);
      return enqueueTrailing(batchId);
    },
  };
}
