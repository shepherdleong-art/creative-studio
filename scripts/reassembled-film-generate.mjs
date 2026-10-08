// Compatibility entry point. Prefer reassembled-film-queue.mjs for production.
import path from 'node:path';
import { acquireLock, FilmQueue, readJson } from './reassembled-film/runtime.mjs';
const [projectArg, jobsArg, parallelArg = '3'] = process.argv.slice(2);
if (!projectArg || !jobsArg) throw new Error('Usage: <project> <jobs.json> [concurrency]');
const project = path.resolve(projectArg), release = acquireLock(project);
let adapter, loading;
try {
  // Lazy import: completed jobs can be verified without providers, keys or network.
  const lazy = Object.fromEntries(['submit', 'poll', 'download'].map(method => [method, async (...args) => {
    loading ||= import('./reassembled-film/company-adapter.mjs').then(m => adapter = m.companyAdapter(project));
    await loading;
    return adapter[method](...args);
  }]));
  const queue = new FilmQueue({ project, adapter: lazy, concurrency: Number(parallelArg), legacy: true });
  const result = await queue.drain(readJson(path.resolve(jobsArg)));
  console.log(JSON.stringify(result, null, 2));
  if (Object.keys(result.errors).length) process.exitCode = 1;
} finally { adapter?.close(); release(); }
