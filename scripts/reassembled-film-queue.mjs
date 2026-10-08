// node scripts/reassembled-film-queue.mjs <enqueue|run|approve|status|timings> PROJECT ...
import path from 'node:path';
import { acquireLock, approve, enqueue, FilmQueue, local, now, readInbox, readJson, sleep, writeJson } from './reassembled-film/runtime.mjs';

const [command, projectArg, ...args] = process.argv.slice(2);
if (!projectArg) throw new Error('Usage: <enqueue|run|approve|status|timings> PROJECT ...');
const project = path.resolve(projectArg);
const defaults = readJson(new URL('./reassembled-film/defaults.json', import.meta.url));
if (command === 'enqueue') {
  if (!args[0]) throw new Error('enqueue requires a job JSON file');
  console.log(enqueue(project, readJson(path.resolve(args[0]))));
} else if (command === 'approve') {
  const [id, reviewer, note] = args;
  console.log(JSON.stringify(approve(project, id, reviewer, note)));
} else if (command === 'status') {
  console.log(JSON.stringify(readJson(local(project, 'queue/status.json'), { status: 'not_started' }), null, 2));
} else if (command === 'timings') {
  const ledger = readJson(local(project, 'review/generation-ledger.json'), {});
  const delta = (a, b) => a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null;
  const report = Object.values(ledger).map(r => ({ id: r.job.id, model: r.job.model, status: r.status,
    queuedToStartSec: delta(r.enqueuedAt, r.startedAt), submitSec: delta(r.startedAt, r.submittedAt),
    remoteAndPollingSec: delta(r.submittedAt, r.remoteSucceededAt), downloadAndWriteSec: delta(r.downloadStartedAt, r.completedAt),
    totalSec: delta(r.startedAt, r.completedAt), legacyTiming: !r.submittedAt }));
  console.log(JSON.stringify(report, null, 2));
} else if (command === 'run') {
  if (args.some(a => a !== '--watch')) throw new Error('run supports only --watch');
  const config = readJson(local(project, 'queue/config.json'), {});
  const release = acquireLock(project);
  let adapter, loading, stopping = false, queue;
  const stop = () => { stopping = true; console.log('Draining active tasks; remote IDs remain resumable.'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const lazy = Object.fromEntries(['submit', 'poll', 'download'].map(method => [method, async (...values) => {
      loading ||= import('./reassembled-film/company-adapter.mjs').then(m => adapter = m.companyAdapter(project));
      await loading;
      return adapter[method](...values);
    }]));
    queue = new FilmQueue({ project, adapter: lazy, concurrency: config.concurrency ?? defaults.concurrency,
      pools: config.pools ?? defaults.pools, cap: config.capYuan ?? defaults.capYuan });
    for (;;) {
      if (stopping) break;
      const status = queue.tick(readInbox(project));
      writeJson(local(project, 'queue/status.json'), { ...status, workerPid: process.pid, worker: 'running' });
      if (!args.includes('--watch') && !queue.active.size) break;
      if (stopping) break;
      await sleep(500);
    }
  } finally {
    // Never release the sole-writer lock while tasks are still mutating the ledger.
    if (queue) {
      await Promise.all([...queue.active.values()].map(a => a.promise));
      const status = queue.snapshot();
      writeJson(local(project, 'queue/status.json'), { ...status, worker: 'stopped', stoppedAt: now() });
      if (Object.keys(status.errors).length) process.exitCode = 1;
      else if (Object.values(status.states).some(s => s.startsWith('waiting_'))) process.exitCode = 2;
    }
    adapter?.close(); release();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
} else throw new Error(`Unknown command ${command}`);
