import { setTimeout } from 'node:timers/promises';
import { isExecutionDeferredError } from './execution/waiting.ts';

/** 素材分析专用；不改变渲染、TTS、转码或供应商名额池。 */
export const MATERIAL_ANALYSIS_CONCURRENCY = 4;

/** 保持输入顺序；失败/取消后停止取新项，排空已启动任务再返回。 */
export async function mapAnalysisMaterials<T, R>(
  items: readonly T[],
  analyze: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let cursor = 0;
  let failure: unknown;
  let failed = false;
  const results: R[] = new Array(items.length);
  try {
    await Promise.all(Array.from({ length: Math.min(MATERIAL_ANALYSIS_CONCURRENCY, items.length) }, async () => {
      while (!failed && !controller.signal.aborted && cursor < items.length) {
        const index = cursor++;
        try {
          results[index] = await analyze(items[index], index, controller.signal);
        } catch (error) {
          if (!failed) { failed = true; failure = error; }
          // 单项失败只停止领取新素材。已提交的模型调用继续收结果，避免把成功调用
          // 一并取消成 maybe_sent/unknown；用户取消或停机仍由外部 signal 中断。
        }
      }
    }));
    signal?.throwIfAborted();
    if (failed) throw failure;
    return results;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** 单条准备保留执行位等候名额；重入同一个执行请求，不重试已失败/未知的供应商调用。 */
export async function waitForAnalysisAdmission<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (!isExecutionDeferredError(error)) throw error;
      await setTimeout(1_000, undefined, { signal });
    }
  }
}
