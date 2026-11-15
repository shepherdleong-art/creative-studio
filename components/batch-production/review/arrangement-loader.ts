/** 有界、逐条交付的审片详情加载；工作区轮询内容不变时复用结果。 */
export function createArrangementLoader<T>(options: {
  load(planId: string, signal: AbortSignal): Promise<T>;
  apply(planId: string, value: T): void;
  concurrency?: number;
}) {
  type Entry = { planId: string; epoch: number; controller: AbortController };
  const limit = options.concurrency ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid arrangement concurrency');
  let epoch = 0, revision: string | null = null, disposed = false, active = 0;
  let plans: readonly string[] = [], queue: Entry[] = [];
  const pending = new Map<string, Entry>();
  const loaded = new Set<string>();
  const failedAt = new Map<string, number>();
  // Explicit edits await a fresh view for undo/redo. Keep those waiters across
  // background revision changes; only a current response may complete them.
  const refreshWaiters = new Map<string, Set<(value: T | null) => void>>();
  function resolveRefresh(planId: string, value: T | null) {
    const waiters = refreshWaiters.get(planId);
    refreshWaiters.delete(planId);
    for (const resolve of waiters ?? []) resolve(value);
  }

  function pump() {
    while (!disposed && active < limit && queue.length) {
      const entry = queue.shift()!;
      if (pending.get(entry.planId) !== entry) continue;
      active++;
      void options.load(entry.planId, entry.controller.signal).then(value => {
        if (disposed || entry.epoch !== epoch || pending.get(entry.planId) !== entry) return;
        loaded.add(entry.planId);
        failedAt.delete(entry.planId);
        options.apply(entry.planId, value);
        resolveRefresh(entry.planId, value);
      }).catch(() => {
        if (entry.epoch === epoch && pending.get(entry.planId) === entry) {
          failedAt.set(entry.planId, Date.now());
          resolveRefresh(entry.planId, null);
        }
      }).finally(() => {
        if (pending.get(entry.planId) === entry) pending.delete(entry.planId);
        active--;
        pump();
      });
    }
  }

  function enqueue(planId: string): Entry {
    const old = pending.get(planId);
    if (old) return old;
    const entry = { planId, epoch, controller: new AbortController() };
    pending.set(planId, entry);
    queue.push(entry);
    return entry;
  }

  function invalidate() {
    epoch++;
    for (const entry of pending.values()) entry.controller.abort();
    pending.clear(); queue = []; loaded.clear(); failedAt.clear();
  }

  return {
    update(nextRevision: string, nextPlans: readonly string[], priority: readonly string[] = [], force = false) {
      if (disposed) return;
      if (revision !== nextRevision || force) { invalidate(); revision = nextRevision; }
      plans = nextPlans;
      for (const id of refreshWaiters.keys()) if (!plans.includes(id)) resolveRefresh(id, null);
      const order = [...new Set([...priority, ...plans])].filter(id => plans.includes(id));
      for (const id of order) {
        if (!loaded.has(id) && Date.now() - (failedAt.get(id) ?? 0) >= 2000) enqueue(id);
      }
      const rank = new Map(order.map((id, index) => [id, index]));
      queue.sort((a, b) => (rank.get(a.planId) ?? Infinity) - (rank.get(b.planId) ?? Infinity));
      pump();
    },
    async refresh(planId: string): Promise<T | null> {
      if (disposed || !plans.includes(planId)) return null;
      const old = pending.get(planId);
      if (old) { old.controller.abort(); pending.delete(planId); }
      loaded.delete(planId); failedAt.delete(planId);
      const promise = new Promise<T | null>(resolve => {
        const waiters = refreshWaiters.get(planId) ?? new Set<(value: T | null) => void>();
        waiters.add(resolve); refreshWaiters.set(planId, waiters);
      });
      const entry = enqueue(planId);
      queue = [entry, ...queue.filter(item => item !== entry)];
      pump();
      return promise;
    },
    dispose() { disposed = true; invalidate(); for (const id of refreshWaiters.keys()) resolveRefresh(id, null); },
  };
}
