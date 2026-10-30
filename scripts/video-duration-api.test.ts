import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
register('./typescript-extension-loader.mjs', import.meta.url);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-capabilities-api-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
const { getDb, closeDb } = await import('../lib/db.ts');
const duration = await import('../lib/video-duration.ts');
const multiShot = await import('../lib/video-multi-shot.ts');
const reassembledGuard = await import('../lib/reassembled-shot-guard.ts');
const providerCapabilities = await import('../lib/video-model-capabilities.ts');
const videoAuth = await import('../lib/video-auth.ts');
const tailFrames = await import('../lib/video-tail-frame.ts');
const filenames = await import('../lib/video-output-filenames.ts');
const productionCodes = await import('../lib/media-core/production-code-reader.ts');
const videoJobCreate = await import('../lib/video-job-create.ts');
const providerVisibility = await import('../lib/provider-list-visibility.ts');

// Production schema/handlers; only queue dispatch and HTTP transport are substituted.
const db = getDb();
db.prepare(`INSERT INTO providers (id, name, baseUrl, model) VALUES ('image-provider','test','http://invalid.test','test')`).run();
db.prepare(`INSERT INTO projects (id, name, providerId, model, prompt) VALUES ('project','test','image-provider','test','test')`).run();
db.prepare(`INSERT INTO image_assets (id, projectId, role, filename, path) VALUES ('image','project','input','test.png','/test.png')`).run();
db.prepare(`INSERT INTO shot_sets (id, projectId, name) VALUES ('set','project','test')`).run();
db.prepare(`INSERT INTO shots (id, shotSetId, sourceImageId, indexNum) VALUES ('shot','set','image',1)`).run();
for (const [id, model] of [['sd25','doubao-seedance-2-5-260628'], ['sd20','doubao-seedance-2-0-260128'],
  ['fast','doubao-seedance-2-0-fast-260128'], ['kling','kling-3.0'], ['qiniu','qiniuyun/kling-3.0'], ['k25','kling-2.5'], ['h3','minimax-h3'], ['wan3','wan-3.0']]) {
  db.prepare(`INSERT INTO video_providers (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, apiKey, enabled) VALUES (?, ?, 'openai-video', ?, '', '', '', 'http://invalid.test', 'test-key', 1)`).run(id, id, model);
}
const dependencies: Record<string, unknown> = {
  '@/lib/reassembled-shot-guard': reassembledGuard,
  '@/lib/media-core/production-code-reader': productionCodes,
  'next/server': { NextResponse: { json: (data: unknown, init?: ResponseInit) => Response.json(data, init) } },
  '@/lib/db': { getDb: () => db }, 'uuid': { v4: randomUUID },
  '@/lib/video-queue': { getVideoQueueStatus: () => 'running', runVideoQueue: () => { throw new Error('Unexpected queue start'); } },
  '@/lib/storage-url': {}, '@/lib/video-duration': duration,
  '@/lib/video-auth': videoAuth,
  '@/lib/video-model-capabilities': providerCapabilities,
  '@/lib/video-provider-schema-runtime': { getVideoProviderGatewayReadiness: () => { throw new Error('Unexpected schema upgrade'); } },
  '@/lib/video-tail-frame': tailFrames,
  '@/lib/video-multi-shot': multiShot,
  '@/lib/video-output-filenames': filenames,
  '@/lib/video-job-create': videoJobCreate,
  '@/lib/provider-list-visibility': providerVisibility,
};
function loadRoute(file: string, method = 'POST') {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: Record<string, (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>> = {};
  vm.runInNewContext(code, { exports, console, URL, require: (name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } });
  return exports[method];
}
const single = loadRoute('app/api/shot-sets/[id]/video-jobs/route.ts');
const batch = loadRoute('app/api/shot-sets/[id]/video-jobs/batch/route.ts');
async function submit(handler: typeof single, body: unknown) {
  db.exec('DELETE FROM video_jobs');
  return handler(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'set' }) });
}
try {
  for (const [providerId, min, max] of [['sd25',4,30], ['sd20',4,15], ['fast',4,15], ['kling',3,15], ['qiniu',3,15], ['k25',5,10], ['h3',4,15], ['wan3',2,30]] as const) {
    for (const seconds of [2, 3, 4, 5, 7, 10, 11, 15, 16, 30, 31, 100, min, max, min - 1, max + 1, 4.5, 10.5, 'bad', null, '']) {
      const valid = typeof seconds === 'number' && Number.isInteger(seconds)
        && (providerId === 'k25' ? seconds === 5 || seconds === 10 : seconds >= min && seconds <= max);
      for (const handler of [single, batch]) {
        const item = { providerId, prompt: 'test', durationSec: seconds };
        const body = handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [{ ...item, durationSec: min }, item] };
        const response = await submit(handler, body);
        assert.equal(response.status, valid ? 200 : 400, `${providerId} ${seconds}: ${await response.text()}`);
        const stored = db.prepare('SELECT durationSec FROM video_jobs').all() as { durationSec: number }[];
        assert.deepEqual(stored.map(r => r.durationSec), valid ? (handler === single ? [seconds] : [min, seconds]) : []);
      }
    }
  }
  for (const fastDuration of [15, 30]) {
    const response = await submit(batch, { shotId: 'shot', items: [
      { providerId: 'sd25', prompt: 'test', durationSec: 30 },
      { providerId: 'fast', prompt: 'test', durationSec: fastDuration },
    ] });
    assert.equal(response.status, fastDuration === 15 ? 200 : 400);
    const stored = db.prepare('SELECT durationSec FROM video_jobs').all() as { durationSec: number }[];
    assert.deepEqual(stored.map(r => r.durationSec), fastDuration === 15 ? [30, 15] : []);
  }
  // Exercise real persistence, including canonical model selection and old NULL semantics.
  db.prepare(`UPDATE video_providers SET defaultModel = ' qiniuyun/kling-3.0 ' WHERE id = 'qiniu'`).run();
  for (const providerId of ['qiniu', 'kling', 'sd25']) {
    for (const value of [false, true, undefined, null]) {
      for (const handler of [single, batch]) {
        const item = { providerId, prompt: 'test', durationSec: 5, multiShot: value };
        const response = await submit(handler, handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [item] });
        assert.equal(response.status, 200, await response.text());
        const stored = db.prepare('SELECT multiShot, model FROM video_jobs').get() as { multiShot: number | null; model: string };
        assert.equal(stored.multiShot, providerId === 'sd25' ? null : value === false ? 0 : 1);
        assert.equal(stored.model, stored.model.trim());
        assert.equal(multiShot.videoMultiShotFromStorage(stored.multiShot), providerId === 'sd25' ? undefined : value !== false);
      }
    }
  }
  // 单条与批量路由共用同一创建链路：参考模式字段必须一致透传并持久化。
  db.prepare(`INSERT INTO video_reference_assets (id, projectId, kind, filename, path, mimeType, byteSize, durationSec)
    VALUES ('ref-image', 'project', 'image', 'ref.png', '/test.png', 'image/png', 10, NULL)`).run();
  for (const handler of [single, batch]) {
    const item = {
      providerId: 'sd25', prompt: 'reference', durationSec: 20,
      generationMode: 'reference-to-video', referenceAssetIds: ['ref-image'],
      aspectRatio: '9:16', resolution: '720p',
    };
    const response = await submit(handler, handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [item] });
    assert.equal(response.status, 200, await response.text());
    const stored = db.prepare(`SELECT generationMode, aspectRatio, resolution, sourceImageId
      FROM video_jobs`).all() as Array<{ generationMode: string; aspectRatio: string; resolution: string; sourceImageId: string }>;
    assert.deepEqual(stored, [{
      generationMode: 'reference-to-video', aspectRatio: '9:16', resolution: '720p', sourceImageId: 'image',
    }], '单条与批量必须同口径持久化参考模式快照');
    const link = db.prepare('SELECT orderIndex, assetId FROM video_job_references').all();
    assert.deepEqual(link, [{ orderIndex: 0, assetId: 'ref-image' }]);
  }
  db.exec('DELETE FROM video_jobs; DELETE FROM video_reference_assets');

  // Incomplete Kling credentials must yield actionable 400s, never throwing runtime resolution.
  db.prepare(`INSERT INTO video_providers (id, name, type, defaultModel, baseUrlEnv, apiKeyEnv, modelEnv, baseUrl, accessKey) VALUES ('incomplete', 'incomplete', 'kling', 'kling-v3', '', '', '', 'http://invalid.test', 'test-key')`).run();
  for (const handler of [single, batch]) {
    const item = { providerId: 'incomplete', prompt: 'test', durationSec: 5 };
    const response = await submit(handler, handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [item] });
    assert.equal(response.status, 400);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM video_jobs').get() as { n: number }).n, 0);
  }
  // Both provider response paths publish the same capability snapshot and legacy aliases.
  db.prepare(`DELETE FROM video_providers WHERE id = 'incomplete'`).run();
  const getProviders = loadRoute('app/api/providers/video/route.ts', 'GET');
  const listResponse = await getProviders(new Request('http://localhost/providers'), { params: Promise.resolve({ id: '' }) });
  assert.equal(listResponse.status, 200, await listResponse.clone().text());
  const listed = await listResponse.json() as Array<ReturnType<typeof providerCapabilities.describeVideoProvider>>;
  const listedQiniu = listed.find(p => p.id === 'qiniu')!;
  assert.deepEqual(listedQiniu.capabilities.durations, Array.from({ length: 13 }, (_, i) => i + 3));
  assert.deepEqual(listedQiniu.capabilities.tailFrame, listedQiniu.tailFrameCapability);
  assert.deepEqual(listedQiniu.capabilities.multiShot, listedQiniu.multiShotCapability);
  assert.equal('apiKey' in listedQiniu, false);
  const updateProvider = loadRoute('app/api/providers/video/[id]/route.ts', 'PUT');
  const updateResponse = await updateProvider(new Request('http://localhost/providers/qiniu', {
    method: 'PUT', body: JSON.stringify({ defaultModel: 'kling-2.5', defaultDurationSec: 10 }),
  }), { params: Promise.resolve({ id: 'qiniu' }) });
  assert.equal(updateResponse.status, 200, 'provider model switch must return current capabilities');
  const updated = await updateResponse.json();
  assert.deepEqual(updated.capabilities.durations, [5, 10]);
  assert.equal(updated.capabilities.tailFrame.supported, true);
  assert.equal(updated.capabilities.multiShot.supported, false);
  assert.equal('multiShotCapability' in updated, false, 'legacy unsupported capability remains omitted');
  const refreshed = await getProviders(new Request('http://localhost/providers'), { params: Promise.resolve({ id: '' }) });
  assert.deepEqual((await refreshed.json()).find((p: { id: string }) => p.id === 'qiniu'), updated,
    'PUT and GET must serialize the same provider identically');
  const createProvider = loadRoute('app/api/providers/video/route.ts');
  const createdResponse = await createProvider(new Request('http://localhost/providers', {
    method: 'POST', body: JSON.stringify({ type: 'jimeng', defaultModel: 'doubao-seedance-2-0-260128', defaultDurationSec: 5 }),
  }), { params: Promise.resolve({ id: '' }) });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.equal(created.capabilities.tailFrame.protocol, 'ark-content-roles');
  assert.equal(created.capabilities.durations[0], 4);


  db.exec(`
    INSERT INTO final_edit_film_productions (id,requestId,requestJson,projectId,root,createdAt)
      VALUES ('production','request','{}','project','/test','now');
    INSERT INTO final_edit_film_production_items (id,productionId,filmKey,importKey,title,shotSetId,groupId,variantId,draftId,shotIdsJson,snapshotJson,registryJson,baselineJson,updatedAt)
      VALUES ('item','production','film','import','test','set','group','variant','script','{}','{}','{"videos":{"synced":{"id":"synced-video"}}}','frozen production baseline','now');
  `);
  // Step four appends independent candidates even before production has a film binding.
  // It must never change synced media, current image selection, or the saved film.
  const protectedTables = ['shots', 'shot_sets', 'final_edit_groups', 'final_edit_film_productions', 'final_edit_film_production_items', 'final_edit_film_bindings', 'final_edit_variants'];
  const snapshot = () => protectedTables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  for (const stage of ['production', 'legacy', 'adopted']) {
    if (stage === 'legacy') {
      db.prepare(`INSERT INTO final_edit_groups (id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash, narrationConfigJson, coverTitleJson, textStylesJson, createdAt, updatedAt)
        VALUES ('group', 'project', 'script', 'set', '{}', 'hash', '{}', '{}', '{}', 'now', 'now')`).run();
      db.prepare(`INSERT INTO final_edit_variants (id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, createdAt, updatedAt)
        VALUES ('variant', 'group', 1, 'test', '{}', '{}', '{}', 'now', 'now')`).run();
      db.prepare(`INSERT INTO final_edit_film_bindings (id, importKey, importHash, projectId, shotSetId, groupId, variantId, specJson, candidatesJson, manifestJson, inputHashesJson, managedRootRelative, deliveryDir, baseName, reviewToken, createdAt)
        VALUES ('binding', 'import', 'hash', 'project', 'set', 'group', 'variant', '{}', '{}', '{}', '{}', 'test', '/test', 'test', 'token', 'now')`).run();
      db.prepare('UPDATE final_edit_variants SET timelineJson=? WHERE id=?').run(JSON.stringify({ clips: [{ videoJobId: 'synced-video' }] }), 'variant');
      db.prepare('UPDATE final_edit_film_production_items SET bindingId=? WHERE id=?').run('binding', 'item');
    }
    if (stage === 'adopted') db.prepare('UPDATE final_edit_variants SET timelineJson=?').run(
      JSON.stringify({ importedFilmEditor: 'mixcut', clips: [{ videoJobId: 'synced-video' }] }),
    );
    assert.equal(reassembledGuard.requiresReassembledUpstreamRework(db, 'set'), stage !== 'adopted');
    for (const handler of [single, batch]) {
      db.exec(`DELETE FROM video_jobs;
        INSERT INTO video_jobs(id, projectId, shotSetId, shotId, sourceImageId, prompt, providerId, model, durationSec, status)
        VALUES ('synced-video','project','set','shot','image','original synced prompt','kling','kling-3.0',5,'succeeded');`);
      const originalVideo = db.prepare('SELECT * FROM video_jobs WHERE id=?').get('synced-video');
      const before = snapshot();
      const item = { providerId: 'kling', prompt: 'new independent candidate', durationSec: 5 };
      const body = handler === single ? { shotId: 'shot', ...item } : { shotId: 'shot', items: [item, item] };
      const response = await handler(new Request('http://localhost/test', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'set' }) });
      assert.equal(response.status, 200, `${stage}: step four should append videos: ${await response.text()}`);
      const added = db.prepare('SELECT * FROM video_jobs WHERE id<>?').all('synced-video') as Array<Record<string, unknown>>;
      assert.equal(added.length, handler === single ? 1 : 2);
      for (const job of added) {
        assert.equal(job.projectId, 'project');
        assert.equal(job.shotSetId, 'set');
        assert.equal(job.shotId, 'shot');
        assert.equal(job.sourceImageId, 'image');
        assert.equal(job.model, 'kling-3.0');
        assert.equal(job.prompt, item.prompt);
      }
      assert.deepEqual(db.prepare('SELECT * FROM video_jobs WHERE id=?').get('synced-video'), originalVideo);
      assert.deepEqual(snapshot(), before, `${stage}: appending candidates must preserve production and film selection`);
    }
  }
  console.log('video-duration API tests passed');
} finally { closeDb(); fs.rmSync(dataRoot, { recursive: true, force: true }); }
