// node scripts/team-read-turn.test.ts
// A busy read burst must leave event-loop turns for actual static/gzip I/O.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { waitForTeamReadTurn } from '../lib/team-service/read-turn.ts';

const require = createRequire(import.meta.url);
const compression = require('next/dist/compiled/compression');
const { serveStatic } = require('next/dist/server/serve-static');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-read-turn-'));
const file = path.join(root, 'fixture.js');
const content = Buffer.from(Array.from({ length: 20000 }, (_, i) => `export const item${i} = ${i};`).join('\n'));
fs.writeFileSync(file, content);
let active = true;
let completed = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/api/read') {
    await waitForTeamReadTurn();
    // The production calls are synchronous SQLite projections. A fixed CPU slice
    // reproduces their event-loop occupancy without hardware-dependent SQL timing.
    const deadline = performance.now() + 10;
    while (performance.now() < deadline) { /* synchronous read work */ }
    response.end('current');
    return;
  }
  compression()(request, response, () => {
    void serveStatic(request, response, file).catch((error: Error) => response.destroy(error));
  });
});
let clients: Array<Promise<void>> = [];
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  clients = Array.from({ length: 24 }, async () => {
    while (active) {
      const response = await fetch(`${base}/api/read`);
      assert.equal(await response.text(), 'current');
      completed++;
    }
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const start = performance.now();
  const response = await fetch(`${base}/fixture.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  const durationMs = performance.now() - start;
  active = false;
  await Promise.all(clients);
  assert.ok(completed >= 24, 'Real read traffic must overlap the static response');
  assert.ok(durationMs < 2500, `Busy reads starved static/gzip I/O for ${durationMs.toFixed(1)} ms`);
  console.log(`PASS: compressed script completed during 24 busy readers in ${durationMs.toFixed(1)} ms`);

  const owners = new AsyncLocalStorage<string>();
  const canceled = new AbortController();
  const order: number[] = [];
  const turns = Array.from({ length: 8 }, (_, i) => owners.run(`employee-${i}`, async () => {
    const admitted = await waitForTeamReadTurn(i === 3 ? canceled.signal : undefined);
    assert.equal(owners.getStore(), `employee-${i}`, 'Queue must preserve the awaiting request context');
    if (admitted) order.push(i);
    else assert.equal(i, 3);
    return admitted;
  }));
  canceled.abort();
  const admitted = await Promise.all(turns);
  assert.equal(admitted[3], false, 'Abort before entry must remove queued work');
  assert.deepEqual(order, [0, 1, 2, 4, 5, 6, 7], 'Live readers retain FIFO order');
  assert.equal(await waitForTeamReadTurn(canceled.signal), false);
  console.log('PASS: queued cancellation, FIFO order and independent employee contexts');
} finally {
  active = false;
  await Promise.allSettled(clients);
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
