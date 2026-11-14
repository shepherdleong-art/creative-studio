import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { mapAnalysisMaterials, waitForAnalysisAdmission } from '../lib/media-core/analysis-concurrency.ts';

let active = 0, peak = 0;
const output = await mapAnalysisMaterials(Array.from({ length: 11 }, (_, i) => i), async (item) => {
  peak = Math.max(peak, ++active);
  await setTimeout((4 - item % 4) * 4);
  active--;
  return item * 2;
});
assert.equal(peak, 4);
assert.equal(active, 0);
assert.deepEqual(output, Array.from({ length: 11 }, (_, i) => i * 2), 'completion order must not reorder materials');

const started: number[] = [];
let drained = 0;
await assert.rejects(mapAnalysisMaterials([0, 1, 2, 3, 4, 5], async (item, _, signal) => {
  started.push(item);
  if (item === 1) throw new Error('unreadable asset');
  await setTimeout(20, undefined, { signal });
  drained++;
  return item;
}), /unreadable asset/);
assert.deepEqual(started, [0, 1, 2, 3]);
assert.equal(drained, 3, 'failure must drain active work before returning');

const controller = new AbortController();
let cancelled = 0;
const cancellation = mapAnalysisMaterials([0, 1, 2, 3, 4, 5], async (_, __, signal) => {
  try { await setTimeout(2_000, undefined, { signal }); }
  finally { cancelled++; }
}, controller.signal);
controller.abort();
await assert.rejects(cancellation, { name: 'AbortError' });
assert.equal(cancelled, 4);

let attempts = 0;
assert.equal(await waitForAnalysisAdmission(async () => {
  if (++attempts === 1) throw Object.assign(new Error('queued'), { code: 'llm_execution_deferred' });
  return 42;
}), 42);
assert.equal(attempts, 2);
attempts = 0;
await assert.rejects(waitForAnalysisAdmission(async () => {
  attempts++;
  throw Object.assign(new Error('unknown'), { code: 'llm_execution_unknown' });
}), /unknown/);
assert.equal(attempts, 1, 'unknown submissions must never be retried');
const waiting = new AbortController();
const admission = waitForAnalysisAdmission(async () => {
  throw Object.assign(new Error('queued'), { code: 'llm_execution_deferred' });
}, waiting.signal);
waiting.abort();
await assert.rejects(admission, { name: 'AbortError' });
console.log('analysis concurrency: 4 slots, stable order, failure drain, cancellation and admission passed');
