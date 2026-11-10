import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaintenancePreviewReader } from '../lib/team-service/maintenance/preview.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-preview-'));
const scriptPath = path.join(root, 'busy.mjs');
fs.writeFileSync(scriptPath, `
process.on('disconnect', () => process.exit(1));
process.once('message', request => {
  if (request.candidateRoot === 'crash') process.exit(1);
  if (request.candidateRoot === 'hang') { setInterval(() => {}, 100); return; }
  const started = Date.now();
  while (Date.now() - started < 650) Math.sqrt(Math.random());
  process.send({ok:true,result:[{pid:process.pid,started,finished:Date.now()}]}, () => process.exit(0));
});
`);
const reader = createMaintenancePreviewReader({ scriptPath, timeoutMs: 2500 });
const request = { kind: 'candidates' as const, candidateRoot: 'busy', current: { appVersion: '0.7.1', dataSchemaVersion: 1 }, allowFixtureForTests: false };
try {
  let ticks = 0;
  const heartbeat = setInterval(() => { ticks += 1; }, 20);
  let results;
  try { results = await Promise.all(Array.from({ length: 12 }, () => reader.read(request))); }
  finally { clearInterval(heartbeat); }
  assert.ok(ticks >= 10, 'A busy validation child must not block the HTTP process event loop');
  assert.ok(results.every(value => value === results[0]), 'Concurrent refreshes share the exact same read');
  assert.equal(await reader.read(request), results[0], 'Polling reuses the short display cache');
  reader.invalidate();
  const next = await reader.read(request);
  assert.notDeepEqual(next, results[0], 'Invalidation refreshes uploaded candidates');
  const [a, b] = await Promise.all(['one', 'two'].map(candidateRoot => reader.read({ ...request, candidateRoot })));
  const first = (a as unknown as Array<{ finished: number }>)[0];
  const second = (b as unknown as Array<{ started: number }>)[0];
  assert.ok(second.started >= first.finished, 'Only one heavy verification process runs at a time');
  await assert.rejects(reader.read({ ...request, candidateRoot: 'crash' }), /提前退出/);
  await assert.rejects(reader.read({ ...request, candidateRoot: 'hang' }), /超时/);
  assert.ok(await reader.read({ ...request, candidateRoot: 'after-failure' }), 'Failure does not poison the queue');
  const hanging = reader.read({ ...request, candidateRoot: 'hang' });
  const rejected = assert.rejects(hanging, /停止/);
  await new Promise(resolve => setTimeout(resolve, 100));
  await reader.stop();
  await rejected;
  await assert.rejects(reader.read(request), /停止/);
  const real = createMaintenancePreviewReader({ cacheMs: 0 });
  try {
    assert.deepEqual(await real.read({ kind: 'backups', backupRoot: path.join(root, 'empty'), deploymentId: 'test',
      currentRelease: { releaseId: 'test', packageSha256: 'a'.repeat(64) } }), { backups: [] });
    assert.deepEqual(await real.read({ ...request, candidateRoot: path.join(root, 'empty') }), []);
  } finally { await real.stop(); }
  console.log('PASS: real preview worker, shared reads, bounded concurrency, responsive event loop, cache invalidation, crash/timeout recovery and shutdown');
} finally {
  await reader.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
