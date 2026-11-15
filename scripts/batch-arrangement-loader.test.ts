import assert from 'node:assert/strict';
import { createArrangementLoader } from '../components/batch-production/review/arrangement-loader.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const requests: Array<{ id: string; signal: AbortSignal; resolve(value: string): void }> = [];
const applied: Array<[string, string]> = [];
let active = 0, max = 0;
const loader = createArrangementLoader<string>({
  load(id, signal) {
    active++; max = Math.max(max, active);
    // Deliberately allow late responses after abort to exercise the stale guard.
    return new Promise<string>(resolve => requests.push({ id, signal, resolve })).finally(() => { active--; });
  },
  apply: (id, value) => applied.push([id, value]),
});
const plans = Array.from({ length: 100 }, (_, i) => 'plan-' + i);
loader.update('A', plans, ['plan-9']);
assert.equal(requests.length, 3);
assert.equal(requests[0].id, 'plan-9');
for (let i = 0; i < 50; i++) loader.update('A', [...plans], ['plan-9']);
assert.equal(requests.length, 3, 'Unchanged polling must coalesce queued and in-flight detail reads');
requests[0].resolve('first-visible'); await tick();
assert.deepEqual(applied, [['plan-9', 'first-visible']], 'First visible film must not wait for the other 99 films');
let consumed = 1;
while (consumed < 100) {
  const batch = requests.slice(consumed);
  for (const request of batch) request.resolve('cached');
  consumed += batch.length; await tick();
}
assert.equal(max, 3); assert.equal(applied.length, 100);
loader.update('A', [...plans]); assert.equal(requests.length, 100, 'Polling must reuse complete results');
loader.update('B', plans);
const stale = requests.slice(100);
loader.update('A', plans); // A -> B -> A; a revision string alone cannot guard old responses.
for (const request of stale) { assert.equal(request.signal.aborted, true); request.resolve('stale-B'); }
await tick();
assert.equal(applied.some(([, value]) => value === 'stale-B'), false);
const old = requests.slice(103);
const edited = loader.refresh(old[0].id);
old[0].resolve('pre-edit'); await tick();
assert.equal(applied.some(([, value]) => value === 'pre-edit'), false);
const fresh = requests.at(-1)!;
assert.equal(fresh.id, old[0].id); fresh.resolve('post-edit');
assert.equal(await edited, 'post-edit');
loader.dispose();
for (const request of requests) request.resolve('after-unmount');
await tick();
assert.equal(applied.some(([, value]) => value === 'after-unmount'), false);
assert.equal(active, 0); assert.ok(max <= 3);
// An edit waits for a fresh view for undo. A concurrent workspace revision must
// hand that waiter to the replacement read rather than resolving it as null.
const reads: Array<(value: string) => void> = [];
const editing = createArrangementLoader<string>({
  concurrency: 1,
  load: () => new Promise<string>(resolve => reads.push(resolve)),
  apply() {},
});
editing.update('before-save', ['film']);
const afterEdit = editing.refresh('film');
reads[0]('old-background'); await tick();
editing.update('after-save', ['film']);
reads[1]('superseded-refresh'); await tick();
reads[2]('latest-saved-view');
assert.equal(await afterEdit, 'latest-saved-view', 'Workspace invalidation must preserve the awaited post-edit snapshot for undo');
editing.dispose();
console.log('PASS: 100 films, three requests, progressive first film, polling reuse, revision roundtrip, edit race, post-edit waiter and unmount');
