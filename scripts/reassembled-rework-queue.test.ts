// node --loader ./scripts/typescript-extension-loader.mjs scripts/reassembled-rework-queue.test.ts
// Isolated SQLite + loopback HTTP + fake video adapter; no paid/network suppliers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reassembled-rework-queue-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { getDb } = await import('../lib/db.ts');
const { runQueue } = await import('../lib/queue.ts');
const { runVideoQueue, claimNextVideoJob, RATE_LIMIT_COOLDOWN_MS } = await import('../lib/video-queue.ts');
const { registerTestVideoAdapter } = await import('../lib/video-providers/index.ts');
const { protectReassembledQueue } = await import('../lib/reassembled-shot-guard.ts');
const db = getDb();
let imageCalls = 0, videoCalls = 0, polls = 0;
const server = http.createServer((req, res) => {
  imageCalls++;
  req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unknown submit outcome' } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const png = path.join(root, 'input.png');
await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toFile(png);
db.prepare("INSERT INTO providers(id,name,type,baseUrl,apiKey,model) VALUES('image','local','openai-compatible',?,'fixture-only','fake')")
  .run(`http://127.0.0.1:${address.port}/v1`);
db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,baseUrl,apiKey,defaultModel) VALUES('video','local','jimeng','','','','http://127.0.0.1:1','fixture-only','fake')").run();
db.prepare(`INSERT INTO final_edit_groups(id,projectId,scriptDraftId,shotSetId,scriptSnapshotJson,narrationHash,narrationConfigJson,coverTitleJson,textStylesJson,createdAt,updatedAt)
  VALUES('group','p','script','shots','{}','hash','{}','{}','{}','now','now')`).run();
db.prepare(`INSERT INTO final_edit_variants(id,groupId,indexNum,outputPreset,timelineJson,bgmJson,coverJson,createdAt,updatedAt)
  VALUES('variant','group',0,'portrait','{}','{}','{}','now','now')`).run();
db.prepare(`INSERT INTO final_edit_film_bindings(id,importKey,importHash,projectId,shotSetId,groupId,variantId,specJson,candidatesJson,manifestJson,inputHashesJson,managedRootRelative,deliveryDir,baseName,reviewToken,createdAt)
  VALUES('binding','import','hash','p','shots','group','variant','{}','[]','{}','{}','managed','delivery','film','token','now')`).run();
function seed(id: string, kind: 'image' | 'video', rework = true, status = 'pending', attempt = 0, remote: string | null = null) {
  db.prepare("INSERT INTO projects(id,name,providerId,model,prompt) VALUES(?,?,'image','fake','test')").run(id, id);
  db.prepare("INSERT INTO image_assets(id,projectId,role,filename,path,mimeType) VALUES(?,?,'input','input.png',?,'image/png')").run(id, id, png);
  if (kind === 'image') db.prepare(`INSERT INTO jobs(id,projectId,inputImageId,providerId,model,prompt,size,quality,status,attempt,maxAttempts,providerTaskId)
    VALUES(?,?,?,'image','fake','test','1024x1024','standard',?,?,5,?)`).run(id, id, id, status, attempt, remote);
  else db.prepare(`INSERT INTO video_jobs(id,projectId,sourceImageId,providerId,model,prompt,durationSec,status,attempt,maxAttempts,providerTaskId)
    VALUES(?,?,?,'video','fake','test',5,?,?,1,?)`).run(id, id, id, status, attempt, remote);
  if (rework) db.prepare(`INSERT INTO final_edit_film_reworks(id,bindingId,clipId,baseRevision,actor,kind,jobId,requestJson,resultJson,createdAt)
    VALUES(?,'binding',?,0,'agent',?,?,'{}','{}','now')`).run(id, id, `generate_${kind}`, id);
}
const row = (id: string, kind: 'image' | 'video') => db.prepare(`SELECT * FROM ${kind === 'image' ? 'jobs' : 'video_jobs'} WHERE id=?`).get(id) as { status: string; attempt: number; providerTaskId: string | null; errorMessage: string };
const run = (id: string, kind: 'image' | 'video') => kind === 'image'
  ? runQueue({ projectId: id, jobId: id, concurrency: 1, maxAttempts: 5, timeoutMs: 1000 })
  : runVideoQueue({ projectId: id, jobId: id, concurrency: 1, timeoutMs: 1000 });
RATE_LIMIT_COOLDOWN_MS.splice(0, RATE_LIMIT_COOLDOWN_MS.length, 1);
registerTestVideoAdapter('jimeng', {
  submit: async () => { videoCalls++; throw new Error('submit error 503: Unknown outcome'); },
  poll: async () => { polls++; return { status: 'failed', errorMessage: 'fixture remote terminal failure', rawResponse: null }; },
  minimumPollingTimeoutMs: () => 0,
});
try {
  for (const kind of ['image', 'video'] as const) {
    const id = `${kind}-unknown`; seed(id, kind); await run(id, kind);
    assert.equal(row(id, kind).status, 'failed');
    assert.equal(row(id, kind).attempt, 1);
    assert.match(row(id, kind).errorMessage, /停止自动重发/);
    await run(id, kind); // Same task cannot be replayed into a second paid submit.
    for (const state of ['running', 'pending', 'retrying']) {
      const crash = `${kind}-${state}`; seed(crash, kind, true, state, 1);
      await run(crash, kind);
      assert.equal(row(crash, kind).status, 'failed');
      assert.equal(row(crash, kind).attempt, 1);
    }
    const remote = `${kind}-remote`; seed(remote, kind, true, 'running', 1, 'remote-original');
    await run(remote, kind);
    assert.equal(row(remote, kind).providerTaskId, 'remote-original');
    assert.equal(row(remote, kind).status, kind === 'image' ? 'needs_check' : 'failed');
  }
  assert.equal(imageCalls, 1); assert.equal(videoCalls, 1); assert.equal(polls, 1);

  registerTestVideoAdapter('jimeng', {
    submit: async () => { videoCalls++; throw new Error('submit error 429: Unknown outcome'); },
    poll: async () => { polls++; if (polls === 2) throw new Error('submit error 503: poll transport failure'); return { status: 'failed', errorMessage: 'fixture terminal', rawResponse: null }; },
    minimumPollingTimeoutMs: () => 0,
  });
  seed('video-429', 'video'); await run('video-429', 'video');
  assert.equal(row('video-429', 'video').status, 'failed');
  assert.equal(row('video-429', 'video').attempt, 1); assert.equal(videoCalls, 2);
  seed('video-poll-recovery', 'video', true, 'running', 1, 'remote-poll');
  await run('video-poll-recovery', 'video');
  assert.equal(row('video-poll-recovery', 'video').providerTaskId, 'remote-poll');
  assert.equal(videoCalls, 2); assert.equal(polls, 3);

  // Claim guard must reject a previously attempted row even after queue startup.
  seed('video-late', 'video', true, 'pending', 1);
  assert.equal(claimNextVideoJob('video-late').job, null);
  assert.equal(row('video-late', 'video').status, 'failed');
  // Claim-time protection cannot mark another worker's active task failed.
  seed('image-live', 'image', true, 'running', 1);
  protectReassembledQueue(db, 'image-live', 'generate_image', undefined, false);
  assert.equal(row('image-live', 'image').status, 'running');
  protectReassembledQueue(db, 'image-live', 'generate_image', 'unrelated');
  assert.equal(row('image-live', 'image').status, 'running');
  protectReassembledQueue(db, 'other-project', 'generate_image');
  assert.equal(row('image-live', 'image').status, 'running');

  // Preserve ordinary legacy video retries (maxAttempts=1 defaults to two).
  registerTestVideoAdapter('jimeng', {
    submit: async () => { videoCalls++; throw new Error('ordinary submit failure'); },
    poll: async () => { throw new Error('must not poll'); }, minimumPollingTimeoutMs: () => 0,
  });
  seed('ordinary-video', 'video', false); await run('ordinary-video', 'video');
  assert.equal(row('ordinary-video', 'video').attempt, 2); assert.equal(videoCalls, 4);
  seed('ordinary-image', 'image', false);
  db.prepare("UPDATE jobs SET maxAttempts=2 WHERE id='ordinary-image'").run();
  await run('ordinary-image', 'image'); assert.equal(imageCalls, 3);
  assert.equal(row('ordinary-image', 'image').attempt, 2);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, paidCalls: 0, imageCalls, videoCalls, polls, root }));
} finally {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close();
}
