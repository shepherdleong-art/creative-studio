// Admit one read continuation per event-loop turn. A burst of synchronous SQLite
// projections must leave poll/check turns for static assets and video streams.
// Only continuations are queued: authorization/results are never cached, and an
// admitted request does not hold a slot while awaiting external or filesystem I/O.
interface Entry {
  finish: (admitted: boolean) => void;
  signal?: AbortSignal;
  cancel: () => void;
}
interface ReadTurns { waiting: Entry[]; scheduled: boolean }
const key = Symbol.for('creative-studio.team-read-turns');
function state(): ReadTurns {
  const registry = globalThis as unknown as Record<symbol, ReadTurns | undefined>;
  return registry[key] ??= { waiting: [], scheduled: false };
}
function schedule(turns: ReadTurns): void {
  if (turns.scheduled || turns.waiting.length === 0) return;
  turns.scheduled = true;
  setImmediate(() => {
    turns.scheduled = false;
    const entry = turns.waiting.shift();
    if (entry) {
      entry.signal?.removeEventListener('abort', entry.cancel);
      entry.finish(!entry.signal?.aborted);
    }
    schedule(turns);
  });
}
export function waitForTeamReadTurn(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const turns = state();
  return new Promise(resolve => {
    const entry: Entry = {
      finish: resolve,
      signal,
      cancel: () => {
        const index = turns.waiting.indexOf(entry);
        if (index >= 0) turns.waiting.splice(index, 1);
        signal?.removeEventListener('abort', entry.cancel);
        resolve(false);
      },
    };
    turns.waiting.push(entry);
    signal?.addEventListener('abort', entry.cancel, { once: true });
    schedule(turns);
  });
}
