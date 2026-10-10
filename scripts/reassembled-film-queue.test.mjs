import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireLock, approve, enqueue, FilmQueue, hashFile, local, readInbox, readJson, sleep, writeJson } from './reassembled-film/runtime.mjs';

const roots = [];
function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'film-queue-test-')); roots.push(project);
  fs.writeFileSync(path.join(project, 'source.png'), 'source');
  fs.writeFileSync(path.join(project, 'prompt.txt'), 'product remains intact');
  return project;
}
function job(id, kind = 'image', extra = {}) {
  return { id, kind, providerId: `test-${kind}`, model: kind === 'image' ? 'qiniuyun/gpt-image-2-medium' : 'kling-2.5', input: 'source.png', prompt: 'prompt.txt', output: `out/${id}.bin`, ...(kind === 'video' ? { durationSec: 4 } : {}), ...extra };
}
function fake(holds = {}) {
  const calls = [];
  return { calls,
    async submit(j) { calls.push(`submit:${j.id}`); return { taskId: `remote-${j.id}` }; },
    async poll(j, id) { calls.push(`poll:${id}`); await holds[j.id]; return { status: 'succeeded', mediaUrl: 'https://example.invalid/media?secret=NEVER_PERSIST' }; },
    async download(j) { calls.push(`download:${j.id}`); return { buffer: Buffer.from(`rendered-${j.id}`) }; },
  };
}
const queue = (project, adapter, extra = {}) => new FilmQueue({ project, adapter, pollMs: 0, log: () => {}, ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { for (let i = 0; i < 2000; i++) { if (fn()) return; await sleep(1); } throw new Error('Test timed out'); }
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await test('atomic JSON replacement survives transient Windows destination locks and preserves the old ledger on permanent failure', async () => {
    if (process.platform !== 'win32') return;
    const p = fixture(), file = local(p, 'review/atomic.json');
    writeJson(file, { version: 1 });
    const rename = fs.renameSync;
    let attempts = 0;
    try {
      fs.renameSync = (...args) => {
        if (++attempts <= 2) throw Object.assign(new Error('reader holds destination'), { code: 'EPERM' });
        return rename(...args);
      };
      writeJson(file, { version: 2 });
      assert.equal(attempts, 3);
      assert.deepEqual(readJson(file), { version: 2 });
      fs.renameSync = () => { throw Object.assign(new Error('persistent denial'), { code: 'EACCES' }); };
      assert.throws(() => writeJson(file, { version: 3 }), /persistent denial/);
      assert.deepEqual(readJson(file), { version: 2 });
    } finally { fs.renameSync = rename; }
  });
  await test('fast reviewed image advances while slow image runs; dynamic rework enters live worker', async () => {
    const p = fixture(), hold = deferred(), adapter = fake({ slow: hold.promise }), q = queue(p, adapter);
    const quick = job('quick'), slow = job('slow'), video = job('video', 'video', { input: quick.output });
    enqueue(p, [quick, slow, video]); q.tick(readInbox(p));
    await until(() => q.done.has('quick')); q.tick(readInbox(p));
    assert.equal(q.states.video, 'waiting_visual_review:quick');
    assert(!adapter.calls.includes('submit:video'));
    approve(p, 'quick', 'agent', 'Inspected product geometry and background'); q.tick(readInbox(p));
    await until(() => q.done.has('video'));
    assert(q.active.has('slow'), 'video must finish before slow candidate');
    enqueue(p, [job('repair', 'video')]); q.tick(readInbox(p));
    await until(() => q.done.has('repair'));
    assert(q.active.has('slow'), 'rework must enter before original batch finishes');
    hold.resolve(); await q.drain([]);
    assert.equal(q.done.size, 4);
  });
  await test('Seedance pool cannot monopolize normal-video capacity', async () => {
    const p = fixture(), hold = deferred(), adapter = fake({ seed1: hold.promise });
    const q = queue(p, adapter, { concurrency: 2, pools: { image: 2, video: 2, seedance: 1 } });
    q.tick([job('seed1', 'video', { model: 'doubao-seedance-2-0-260128' }), job('seed2', 'video', { model: 'doubao-seedance-2-0-260128' }), job('kling', 'video')]);
    await until(() => q.done.has('kling'));
    assert.equal(q.states.seed2, 'waiting_slot');
    assert(!adapter.calls.includes('submit:seed2')); hold.resolve(); await q.drain([]);
  });
  await test('recovery polls stored ID without another paid submit', async () => {
    const p = fixture(), j = job('resume'), adapter = fake();
    writeJson(local(p, 'review/generation-ledger.json'), { resume: { job: j, taskId: 'existing-id', status: 'processing', estimateYuan: .25 } });
    const q = queue(p, adapter); await q.drain([j]);
    assert.deepEqual(adapter.calls, ['poll:existing-id', 'download:resume']);
    const calls = adapter.calls.length; await queue(p, adapter).drain([j]); assert.equal(adapter.calls.length, calls);
  });
  await test('ambiguous submission and failed remote task never auto-resubmit', async () => {
    const p = fixture(), a = job('ambiguous'), b = job('failed'), adapter = fake();
    writeJson(local(p, 'review/generation-ledger.json'), {
      ambiguous: { job: a, status: 'submitting', estimateYuan: .25 },
      failed: { job: b, taskId: 'failed-id', remoteFailed: true, status: 'attention', estimateYuan: .25 },
    });
    const result = await queue(p, adapter).drain([a, b]);
    assert.equal(Object.keys(result.errors).length, 2); assert.equal(adapter.calls.length, 0);
  });
  await test('a poll interruption resumes the same task and input edits block resumption', async () => {
    const p = fixture(), j = job('interrupted'), adapter = fake();
    const poll = adapter.poll;
    adapter.poll = async () => { throw new Error('Simulated connection loss'); };
    const first = await queue(p, adapter).drain([j]); assert(first.errors.interrupted);
    assert.equal(readJson(local(p, 'review/generation-ledger.json')).interrupted.taskId, 'remote-interrupted');
    fs.writeFileSync(local(p, 'source.png'), 'changed');
    const second = await queue(p, adapter).drain([j]); assert.match(second.errors.interrupted, /Input content changed/);
    fs.writeFileSync(local(p, 'source.png'), 'source'); adapter.poll = poll;
    const third = await queue(p, adapter).drain([j]); assert.equal(third.completed, 1);
    assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 1);
  });
  await test('budget reservations are atomic across concurrent submissions', async () => {
    const p = fixture(), adapter = fake();
    const result = await queue(p, adapter, { concurrency: 5, cap: .5, pools: { image: 5, video: 2, seedance: 1 } }).drain([job('a'), job('b'), job('c')]);
    assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 2);
    assert.equal(result.estimateYuan, .5); assert(result.errors.c);
  });
  await test('50 slots are shared globally across image, Kling and Seedance tasks', async () => {
    const p = fixture(), hold = deferred();
    const jobs = Array.from({ length: 60 }, (_, i) => job(`batch-${i}`, i % 3 ? 'video' : 'image', i % 3 === 2 ? { model: 'doubao-seedance-2-0-260128' } : {}));
    const adapter = fake(Object.fromEntries(jobs.map(j => [j.id, hold.promise])));
    const q = queue(p, adapter, { cap: 100 });
    const defaults = readJson(new URL('./reassembled-film/defaults.json', import.meta.url));
    assert.equal(q.concurrency, defaults.concurrency); assert.deepEqual(q.pools, defaults.pools);
    try {
      q.tick(jobs);
      assert.equal(q.active.size, 50);
      assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 50);
      assert.equal(Object.values(q.states).filter(s => s === 'waiting_slot').length, 10);
      q.tick(); assert.equal(q.active.size, 50);
    } finally { hold.resolve(); await q.drain([]); }
    assert.equal(q.done.size, 60); assert.equal(q.errors.size, 0);
    assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 60);
  });
  await test('50-slot queue still reserves budget before every submission', async () => {
    const p = fixture(), adapter = fake();
    const result = await queue(p, adapter, { cap: 1 }).drain(Array.from({ length: 50 }, (_, i) => job(`cost-${i}`)));
    assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 4);
    assert.equal(result.estimateYuan, 1); assert.equal(Object.keys(result.errors).length, 46);
  });
  await test('concurrency and pool bounds reject invalid values above 50', async () => {
    const p = fixture();
    for (const n of [0, -1, 1.5, 51, NaN]) {
      assert.throws(() => queue(p, fake(), { concurrency: n }), /1–50/);
      assert.throws(() => queue(p, fake(), { pools: { image: n, video: 50, seedance: 50 } }), /1–50/);
    }
  });
  await test('prompt changes after enqueue are rejected before any provider call', async () => {
    const p = fixture(), adapter = fake(); enqueue(p, [job('a')]);
    fs.writeFileSync(local(p, 'prompt.txt'), 'silently changed');
    const result = await queue(p, adapter).drain(readInbox(p));
    assert.match(result.errors.a, /Prompt changed/); assert.equal(adapter.calls.length, 0);
  });
  await test('approval is bound to output bytes, not filename', async () => {
    const p = fixture(), adapter = fake(), j = job('image'); const q = queue(p, adapter);
    await q.drain([j]); approve(p, j.id, 'agent', 'Reviewed full-size');
    fs.writeFileSync(local(p, j.output), 'changed-after-review');
    q.tick([job('video', 'video', { input: j.output })]);
    assert.equal(q.states.video, 'waiting_visual_review:image');
    assert(!adapter.calls.includes('submit:video'));
    const replay = await queue(p, adapter).drain([j]); assert.match(replay.errors.image, /missing or changed/);
  });
  await test('crash between output commit and ledger commit recovers by hash', async () => {
    const p = fixture(), j = job('recover'), adapter = fake(), output = local(p, j.output);
    fs.mkdirSync(path.dirname(output)); fs.writeFileSync(output, 'finished');
    writeJson(local(p, 'review/generation-ledger.json'), { recover: { job: j, taskId: 'paid', status: 'succeeded', estimateYuan: .25, pendingOutput: { hash: hashFile(output) } } });
    const result = await queue(p, adapter).drain([j]); assert.equal(result.completed, 1); assert.equal(adapter.calls.length, 0);
  });
  await test('duplicate output, changed task identity, cycles and path escape fail closed', async () => {
    const p = fixture(), adapter = fake();
    assert.throws(() => queue(p, adapter).add([job('a'), job('b', 'image', { output: 'out/a.bin' })]), /Two jobs/);
    const q = queue(p, adapter); q.add([job('a')]); assert.throws(() => q.add([job('a', 'image', { input: 'other.png' })]), /Changed queue/);
    assert.throws(() => queue(p, adapter).add([{ job: job('a'), dependsOn: ['b'] }, { job: job('b'), dependsOn: ['a'] }]), /cycle/);
    assert.throws(() => local(p, '../escape'), /outside/);
    assert.throws(() => enqueue(p, [{ job: job('bad'), openingEffectId: 'ordinary-pan' }]), /four approved/);
  });
  await test('single writer lock rejects a second worker', async () => {
    const p = fixture(), release = acquireLock(p); assert.throws(() => acquireLock(p), /EEXIST/); release(); acquireLock(p)();
  });
  await test('stage timestamps persist but authenticated URLs do not', async () => {
    const p = fixture(); await queue(p, fake()).drain([job('timed')]);
    const file = local(p, 'review/generation-ledger.json'), record = readJson(file).timed;
    for (const key of ['enqueuedAt', 'readyAt', 'startedAt', 'submittedAt', 'remoteSucceededAt', 'downloadStartedAt', 'completedAt']) assert(Number.isFinite(Date.parse(record[key])), key);
    assert(!fs.readFileSync(file, 'utf8').includes('NEVER_PERSIST'));
    assert.equal(record.outputHash, crypto.createHash('sha256').update('rendered-timed').digest('hex'));
  });
  await test('tail frame waits for generation and review; changed tail bytes invalidate approval', async () => {
    const p = fixture(), adapter = fake(), q = queue(p, adapter), tail = job('tail');
    const video = job('tail-video', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 5, tailInput: tail.output });
    enqueue(p, [video, tail]); q.tick(readInbox(p));
    assert.equal(q.states[video.id], 'waiting_dependency:tail');
    assert(!adapter.calls.includes(`submit:${video.id}`));
    await until(() => q.done.has(tail.id)); q.tick();
    assert.equal(q.states[video.id], 'waiting_visual_review:tail');
    approve(p, tail.id, 'agent', 'Reviewed tail composition and product geometry');
    fs.writeFileSync(local(p, tail.output), 'changed-after-review'); q.tick();
    assert.equal(q.states[video.id], 'waiting_visual_review:tail');
    assert(!adapter.calls.includes(`submit:${video.id}`));
    fs.writeFileSync(local(p, tail.output), `rendered-${tail.id}`);
    await q.drain([]);
    assert.equal(q.done.size, 2); assert.equal(q.errors.size, 0);
    assert.equal(adapter.calls.filter(c => c === `submit:${video.id}`).length, 1);
  });
  await test('invalid tail paths and tail dependency cycles fail before provider calls', async () => {
    const p = fixture(), adapter = fake();
    for (const tailInput of ['', null, 42, []]) {
      assert.throws(() => enqueue(p, [job('bad-tail', 'video', { tailInput })]), /Invalid tailInput/);
      assert.throws(() => queue(p, adapter).add([job('bad-tail', 'video', { tailInput })]), /Invalid tailInput/);
    }
    assert.throws(() => enqueue(p, [job('escape-tail', 'video', { tailInput: '../escape.png' })]), /outside/);
    const a = job('cycle-a', 'video', { tailInput: 'out/cycle-b.bin' });
    const b = job('cycle-b', 'image', { input: a.output });
    assert.throws(() => queue(p, adapter).add([a, b]), /cycle/);
    assert.equal(adapter.calls.length, 0);
  });
  await test('changed tail content blocks resumption without another paid submission', async () => {
    const p = fixture(), adapter = fake();
    fs.writeFileSync(local(p, 'tail.png'), 'original-tail');
    const j = job('tail-resume', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 5, tailInput: 'tail.png' });
    const poll = adapter.poll;
    adapter.poll = async () => { throw new Error('Simulated connection loss'); };
    const first = await queue(p, adapter).drain([j]); assert(first.errors[j.id]);
    fs.writeFileSync(local(p, 'tail.png'), 'changed-tail');
    const second = await queue(p, adapter).drain([j]); assert.match(second.errors[j.id], /Input content changed/);
    fs.writeFileSync(local(p, 'tail.png'), 'original-tail'); adapter.poll = poll;
    const third = await queue(p, adapter).drain([j]); assert.equal(third.completed, 1);
    assert.equal(adapter.calls.filter(c => c.startsWith('submit:')).length, 1);
  });
  await test('video estimates scale with duration while image estimates stay per image', async () => {
    const p = fixture(), adapter = fake();
    const jobs = [
      job('qiniu3', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 3 }),
      job('qiniu5', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 5 }),
      job('qiniu10', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 10 }),
      job('qiniu15', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 15 }),
      job('kling10', 'video', { durationSec: 10 }),
      job('seedance8', 'video', { model: 'doubao-seedance-2-0-260128', durationSec: 8 }),
      job('seedance25_8', 'video', { model: 'doubao-seedance-2-5-260628', durationSec: 8 }),
      job('image'), job('seedream', 'image', { model: 'doubao-seedream-5-0-pro-image' }),
    ];
    const result = await queue(p, adapter, { cap: 100 }).drain(jobs);
    assert.equal(result.completed, jobs.length); assert.deepEqual(result.errors, {});
    const ledger = readJson(local(p, 'review/generation-ledger.json'));
    const expected = { qiniu3: 1.8, qiniu5: 3, qiniu10: 6, qiniu15: 9, kling10: 3.04, seedance8: 4, seedance25_8: 15.2, image: .25, seedream: .61 };
    for (const [id, cost] of Object.entries(expected)) assert.equal(ledger[id].estimateYuan, cost, id);
  });
  await test('duration-adjusted reservations enforce the cap across concurrent video submissions', async () => {
    const p = fixture(), adapter = fake();
    const jobs = [10, 5].map((durationSec, i) => job(`budget-video-${i}`, 'video', { model: 'qiniuyun/kling-3.0', durationSec }));
    const result = await queue(p, adapter, { cap: 6 }).drain(jobs);
    assert.deepEqual(adapter.calls.filter(c => c.startsWith('submit:')), ['submit:budget-video-0']);
    assert.equal(result.estimateYuan, 6); assert.match(result.errors[jobs[1].id], /budget cap/);
    const blocked = await queue(fixture(), fake(), { cap: 5.99 }).drain([jobs[0]]);
    assert.equal(blocked.completed, 0); assert.equal(blocked.estimateYuan, 0);
    assert.match(blocked.errors[jobs[0].id], /budget cap/);
  });
  await test('historical reservations stay frozen on resume and unknown models cannot submit', async () => {
    const p = fixture(), adapter = fake();
    const old = job('old-qiniu', 'video', { model: 'qiniuyun/kling-3.0', durationSec: 10 });
    writeJson(local(p, 'review/generation-ledger.json'), { [old.id]: { job: old, taskId: 'paid-old-id', status: 'processing', estimateYuan: 3 } });
    const result = await queue(p, adapter, { cap: 3 }).drain([old, job('unknown', 'video', { model: 'unknown-model' })]);
    assert.equal(result.completed, 1); assert.equal(result.estimateYuan, 3);
    assert.match(result.errors.unknown, /Unknown estimate/);
    assert.deepEqual(adapter.calls, ['poll:paid-old-id', 'download:old-qiniu']);
    assert.equal(readJson(local(p, 'review/generation-ledger.json'))[old.id].estimateYuan, 3);
  });
  console.log(`${passed} tests passed; no external API calls.`);
} finally {
  for (const root of roots) {
    const resolved = path.resolve(root);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'film-queue-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
