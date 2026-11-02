import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface MediaResourceOptions {
  taskId: string;
  step?: string;
  /** false 用于批量编排：忙时返回 deferred，让出业务执行槽。 */
  wait: boolean;
  signal?: AbortSignal;
}

interface MediaLeaseContext {
  leaseId: string;
  taskId: string;
  step: string;
}

interface MediaWaiter {
  taskId: string;
  step: string;
  signal?: AbortSignal;
  resolve: (context: MediaLeaseContext) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface MediaResourceState {
  active: number;
  queue: MediaWaiter[];
  storage: AsyncLocalStorage<MediaLeaseContext>;
}

const STATE_KEY = Symbol.for('creative-studio.media-resource-gate');
const CAPACITY = (() => {
  const parsed = Number(process.env.CREATIVE_STUDIO_MEDIA_CONCURRENCY ?? '1');
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 32 ? parsed : 1;
})();

function state(): MediaResourceState {
  const globals = globalThis as Record<PropertyKey, unknown>;
  if (!globals[STATE_KEY]) {
    globals[STATE_KEY] = {
      active: 0,
      queue: [],
      storage: new AsyncLocalStorage<MediaLeaseContext>(),
    } satisfies MediaResourceState;
  }
  return globals[STATE_KEY] as MediaResourceState;
}

export class MediaResourceDeferredError extends Error {
  readonly code = 'media_resource_deferred';
  readonly taskId: string;
  readonly step: string;

  constructor(taskId: string, step: string) {
    super('本地媒体容量已满，任务已延期');
    this.name = 'MediaResourceDeferredError';
    this.taskId = taskId;
    this.step = step;
  }
}

function abortError(): Error {
  return new DOMException('媒体资源等待已取消', 'AbortError');
}

function pump(): void {
  const current = state();
  while (current.active < CAPACITY && current.queue.length > 0) {
    const waiter = current.queue.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      continue;
    }
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    current.active += 1;
    waiter.resolve({ leaseId: randomUUID(), taskId: waiter.taskId, step: waiter.step });
  }
}

async function acquire(options: MediaResourceOptions): Promise<MediaLeaseContext> {
  const current = state();
  options.signal?.throwIfAborted();
  const step = options.step ?? 'media';
  if (current.active < CAPACITY) {
    current.active += 1;
    return { leaseId: randomUUID(), taskId: options.taskId, step };
  }
  if (!options.wait) throw new MediaResourceDeferredError(options.taskId, step);
  return new Promise<MediaLeaseContext>((resolve, reject) => {
    const waiter: MediaWaiter = { taskId: options.taskId, step, signal: options.signal, resolve, reject };
    if (options.signal) {
      waiter.onAbort = () => {
        const index = current.queue.indexOf(waiter);
        if (index >= 0) current.queue.splice(index, 1);
        reject(abortError());
        pump();
      };
      options.signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    current.queue.push(waiter);
  });
}

function release(): void {
  const current = state();
  current.active = Math.max(0, current.active - 1);
  pump();
}

export async function withMediaResource<T>(
  options: MediaResourceOptions,
  operation: (lease: MediaLeaseContext) => Promise<T>,
): Promise<T> {
  const current = state();
  const inherited = current.storage.getStore();
  if (inherited) return operation(inherited);
  const lease = await acquire(options);
  try {
    return await current.storage.run(lease, () => operation(lease));
  } finally {
    release();
  }
}

export function getMediaResourceSnapshot(): { capacity: number; active: number; queued: number } {
  const current = state();
  return { capacity: CAPACITY, active: current.active, queued: current.queue.length };
}
