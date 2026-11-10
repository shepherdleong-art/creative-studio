// Real queues + SQLite/execution; all provider calls are intercepted, no paid requests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-queue-workers-'));
const previousEnv = { ...process.env };
const originalFetch = globalThis.fetch;
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'queue-workers-test',
  CREATIVE_STUDIO_INSTANCE_ID: 'queue-workers-test-instance',
  CREATIVE_STUDIO_PORT: '43109',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
});

const { getDb, closeDb } = await import('../lib/db.ts');
const { startTeamServiceRuntime, drainTeamRuntime, releaseTeamRuntimeOwner } = await import('../lib/team-service/runtime/index.ts');
const queue = await import('../lib/queue.ts');
const videoQueue = await import('../lib/video-queue.ts');
const { registerTestVideoAdapter } = await import('../lib/video-providers/index.ts');
const { configureLegacyMediaProviderPool } = await import('../lib/legacy-media-execution.ts');
const { readActorPolicy, updateActorPolicy } = await import('../lib/media-core/execution/pools.ts');
const { readTeamConcurrencyPolicy, updateTeamConcurrencyPolicy } = await import('../lib/media-core/execution/team-policy.ts');
const { configuredProviderPool } = await import('../lib/media-core/execution/configured-provider-pool.ts');

const runtime = await startTeamServiceRuntime();
assert.equal(runtime.ready, true, runtime.code);
const db = getDb();
const now = new Date().toISOString();
const baseUrl = 'https://concurrency.example.test';
const apiKey = 'fixture-concurrency-key';
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#eeeeee' } }).png().toBuffer();
const imagePath = path.join(root, 'input.png');
fs.writeFileSync(imagePath, png);
const runs: Promise<void>[] = [];
const errors: unknown[] = [];
const seen = new Set<string>();
const releases = new Map<string, () => void>();
let releaseAutomatically = false;
let maxHeld = 0;
let poolKey = '';

function heldIn(key: string): number {
  return db.prepare("SELECT COUNT(*) FROM execution_reservations WHERE poolKey=? AND kind='concurrency' AND state='held'")
    .pluck().get(key) as number;
}
const held = () => heldIn(poolKey);
async function gate(key: string): Promise<void> {
  assert.equal(seen.has(key), false, `Duplicate paid submission: ${key}`);
  seen.add(key);
  maxHeld = Math.max(maxHeld, held());
  if (!releaseAutomatically) await new Promise<void>(resolve => releases.set(key, resolve));
}
function releaseAll(): void {
  releaseAutomatically = true;
  for (const release of releases.values()) release();
  releases.clear();
}
function resetGates(): void {
  assert.equal(held(), 0);
  releases.clear();
  seen.clear();
  releaseAutomatically = false;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) {
    if (errors.length) throw errors[0];
    await sleep(25);
  }
  assert.ok(check(), `${message}; submitted=${seen.size}, held=${held()}`);
}
function launch(run: Promise<void>): Promise<void> {
  runs.push(run);
  void run.catch(error => errors.push(error));
  return run;
}
function teamMode(mode: 'auto' | 'manual', manualDefaultConcurrency = 7): void {
  updateTeamConcurrencyPolicy(db, { mode, manualDefaultConcurrency, expectedVersion: readTeamConcurrencyPolicy(db).version });
}
function member(id: string, fixed?: number): void {
  db.prepare(`INSERT INTO team_users (id,employeeId,displayName,role,status,passwordHash,createdAt,updatedAt)
    VALUES (?,?,?,'employee','active','hash',?,?)`).run(id, id, id, now, now);
  updateActorPolicy(db, {
    actorId: id, monthlyLimitMinor: null, personalConcurrency: fixed ?? 0,
    concurrencyMode: fixed === undefined ? 'inherit' : 'fixed', paused: false, expectedVersion: 0,
  });
}
function project(id: string, actorId: string): void {
  db.prepare(`INSERT INTO projects (id,name,providerId,model,prompt,concurrency,videoConcurrency)
    VALUES (?,?,'image-provider','fixture-image','prompt',10,10)`).run(id, id);
  db.prepare(`INSERT INTO team_resource_scopes (resourceType,resourceId,ownerUserId,rootType,rootId,createdAt,updatedAt)
    VALUES ('project',?,?,'project',?,?,?)`).run(id, actorId, id, now, now);
  db.prepare(`INSERT INTO image_assets (id,projectId,role,filename,path,mimeType)
    VALUES (?,?,'input','input.png',?,'image/png')`).run(`input-${id}`, id, imagePath);
}
function jobs(kind: 'image' | 'video', projectId: string, actorId: string, count: number): void {
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `${projectId}-${String(index).padStart(3, '0')}`;
      if (kind === 'image') {
        db.prepare(`INSERT INTO jobs (id,projectId,inputImageId,providerId,model,prompt,size,quality,status,attempt,maxAttempts)
          VALUES (?,?,?,'image-provider','fixture-image',?,'16x16','standard','pending',0,1)`)
          .run(id, projectId, `input-${projectId}`, id);
      } else {
        db.prepare(`INSERT INTO video_jobs (id,projectId,sourceImageId,providerId,model,prompt,durationSec,status,attempt,maxAttempts)
          VALUES (?,?,?,'video-provider','fixture-video',?,5,'pending',0,1)`)
          .run(id, projectId, `input-${projectId}`, id);
      }
      db.prepare(`INSERT INTO team_task_principals (module,taskId,actorUserId,scopeType,scopeId,creationSnapshot,createdAt)
        VALUES (?,?,?,'project',?,'{}',?)`).run(kind, id, actorId, projectId, now);
      db.prepare(`INSERT INTO team_resource_scopes (resourceType,resourceId,ownerUserId,parentType,parentId,rootType,rootId,createdAt,updatedAt)
        VALUES (?,?,?,'project',?,'project',?,?,?)`)
        .run(kind === 'image' ? 'job' : 'video_job', id, actorId, projectId, projectId, now, now);
    }
  })();
}
function images(projectId: string): Promise<void> {
  return launch(queue.runQueue({ projectId, concurrency: 10, maxAttempts: 1, timeoutMs: 60_000 }));
}

globalThis.fetch = (async (input, init) => {
  assert.ok(['', '/pool20', '/pool50'].some(prefix => String(input) === `${baseUrl}${prefix}/v1/images/edits`),
    'Unexpected network request');
  assert.ok(init?.body instanceof FormData);
  await gate(`image:${init.body.get('prompt')}`);
  return Response.json({ data: [{ b64_json: png.toString('base64') }] });
}) as typeof fetch;
registerTestVideoAdapter('openai-video', {
  submit: async request => {
    await gate(`video:${request.prompt}`);
    return { providerTaskId: `remote-${request.prompt}`, rawResponse: null };
  },
  poll: async () => ({ status: 'failed', errorMessage: 'fixture terminal', rawResponse: null }),
  minimumPollingTimeoutMs: () => 0,
});

try {
  db.prepare(`INSERT INTO providers (id,name,type,baseUrl,apiKey,model,enabled)
    VALUES ('image-provider','fixture','openai-compatible',?,?,'fixture-image',1)`).run(baseUrl, apiKey);
  db.prepare(`INSERT INTO video_providers (id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled,baseUrl,apiKey)
    VALUES ('video-provider','fixture','openai-video','','','','fixture-video',1,?,?)`).run(baseUrl, apiKey);
  teamMode('auto');
  member('member-a');
  member('member-b');
  assert.equal(readActorPolicy(db, 'member-a').effectiveConcurrency, null);
  project('image-a', 'member-a');
  project('image-b', 'member-b');
  jobs('image', 'image-a', 'member-a', 101);
  poolKey = configureLegacyMediaProviderPool({ baseUrl, apiKey, capacity: 10 });
  const firstRun = images('image-a');
  await until(() => seen.size === 10, 'Initial capacity 10 must be usable');
  configureLegacyMediaProviderPool({ baseUrl, apiKey, capacity: 100 });
  await until(() => seen.size === 100, 'One ordinary project must expand to all 100 free slots');
  assert.equal(held(), 100);
  await sleep(300);
  assert.equal(seen.size, 100, 'The 101st request must wait for real pool capacity');

  jobs('image', 'image-b', 'member-b', 1);
  const newcomerRun = images('image-b');
  await until(() => Boolean(db.prepare("SELECT 1 FROM execution_operations WHERE taskId='image-b-000' AND status='deferred'").get()),
    'Newcomer must be queued before a slot is released');
  releases.get('image:image-a-000')!();
  releases.delete('image:image-a-000');
  await until(() => seen.has('image:image-b-000'), 'Newcomer must receive the released slot');
  assert.equal(seen.has('image:image-a-100'), false, 'Original member cannot take all future slots');
  assert.equal(held(), 100, 'Other already running requests must continue');
  releaseAll();
  await Promise.all([firstRun, newcomerRun]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM jobs WHERE status='succeeded'").pluck().get(), 102);
  console.log('single image project: live capacity 10 -> 100, pool cap, second-member fairness passed');

  for (const [mode, fixed, limit] of [['manual', undefined, 7], ['auto', 4, 4]] as const) {
    resetGates();
    teamMode(mode);
    const id = `limit-${mode}`;
    member(id, fixed);
    project(id, id);
    jobs('image', id, id, 18);
    const run = images(id);
    await until(() => seen.size === limit, `${mode} member limit must be usable`);
    await sleep(350);
    assert.equal(seen.size, limit, 'Removing project cap must preserve member limits');
    releaseAll();
    await run;
    assert.equal(seen.size, 18);
  }
  console.log('manual team limit and explicit personal override passed');

  resetGates();
  teamMode('auto');
  project('mixed-pools', 'member-a');
  jobs('image', 'mixed-pools', 'member-a', 91);
  for (const [providerId, suffix] of [['pool20-a', '/pool20'], ['pool20-b', '/pool20'], ['pool50', '/pool50']]) {
    db.prepare(`INSERT INTO providers (id,name,type,baseUrl,apiKey,model,enabled)
      VALUES (?,?,'openai-compatible',?,?,'fixture-image',1)`).run(providerId, providerId, `${baseUrl}${suffix}`, apiKey);
  }
  const pool20 = configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/pool20`, apiKey, capacity: 20 });
  const pool50 = configureLegacyMediaProviderPool({ baseUrl: `${baseUrl}/pool50`, apiKey, capacity: 50 });
  db.prepare(`UPDATE jobs SET providerId = CASE
    WHEN id < 'mixed-pools-020' THEN 'pool20-a'
    WHEN id < 'mixed-pools-040' THEN 'pool20-b'
    ELSE 'pool50' END WHERE projectId = 'mixed-pools'`).run();
  const mixedRun = images('mixed-pools');
  await until(() => heldIn(pool20) === 20 && heldIn(pool50) === 50, 'Independent pools must both fill from one project');
  await sleep(300);
  assert.equal(seen.size, 70, 'Shared aliases cannot double capacity; separate pools must not block each other');
  assert.equal(heldIn(pool20), 20);
  assert.equal(heldIn(pool50), 50);
  releaseAll();
  await mixedRun;
  assert.equal(db.prepare("SELECT COUNT(*) FROM jobs WHERE projectId='mixed-pools' AND status='succeeded'").pluck().get(), 91);
  console.log('single project: independent 20/50 pools and aliases sharing one capacity passed');

  resetGates();
  teamMode('auto');
  project('video-a', 'member-a');
  jobs('video', 'video-a', 'member-a', 101);
  const videoRun = launch(videoQueue.runVideoQueue({ projectId: 'video-a', concurrency: 10, timeoutMs: 60_000 }));
  await until(() => seen.size === 100, 'One video project must also use all 100 free slots');
  await sleep(300);
  assert.equal(seen.size, 100);
  assert.equal(held(), 100);
  releaseAll();
  await videoRun;
  assert.equal(seen.size, 101);
  assert.equal(maxHeld, 100);
  console.log('single video project: 100 shared slots, no overbooking or duplicate submissions passed');

  // Old combined Kling credentials must resolve to the same capacity as paid submission.
  db.prepare(`INSERT INTO video_providers (id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled,baseUrl,apiKey)
    VALUES ('legacy-kling','fixture','kling','','','','fixture-kling',1,?,'fixture-ak:fixture-sk')`).run(baseUrl);
  const klingPool = configureLegacyMediaProviderPool({ baseUrl, apiKey: 'fixture-ak\0fixture-sk', capacity: 100 });
  assert.equal(configuredProviderPool(db, 'video', 'legacy-kling'), klingPool);
  assert.deepEqual(errors, []);
  console.log('media queue workers tests passed');
} finally {
  releaseAll();
  await drainTeamRuntime(5_000);
  await Promise.allSettled(runs);
  releaseTeamRuntimeOwner();
  globalThis.fetch = originalFetch;
  closeDb();
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
