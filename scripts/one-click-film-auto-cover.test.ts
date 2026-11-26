import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

register('./typescript-extension-loader.mjs', import.meta.url);
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-auto-cover-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { syncFilmAutoCover, retryFilmAutoCover } = await import('../lib/one-click-film/cover-auto.ts');
const { tryFilmRequestLock } = await import('../lib/one-click-film/request-lock.ts');
const { readFilmBody } = await import('../lib/one-click-film/composition.ts');
const { ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
const { closeDb, getDb } = await import('../lib/db.ts');
const { seedScriptProviders } = await import('../lib/seed.ts');
const { runFfmpeg } = await import('../lib/ffmpeg.ts');
const { getOrCreateRun, createAnalysisVersion, markAnalysisSucceeded } = await import('../lib/one-click-film/store.ts');
const { upsertReviewFromDetection } = await import('../lib/one-click-film/review.ts');
const { listPackaging, preparePackaging, updatePackagingDraft } = await import('../lib/one-click-film/packaging.ts');

let requests = 0;
let receivedFrames: number[] = [];
let fixtureError: unknown;
let reply = '{"candidate":2}';
let code = 200;
let onRequest: (() => Promise<void>) | undefined;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    const pieces: Buffer[] = [];
    for await (const data of request) pieces.push(data);
    const body = JSON.parse(Buffer.concat(pieces).toString());
    const content = body.messages[1].content;
    const prompt = JSON.parse(content[0].text);
    assert.equal(prompt.task, 'select_product_panorama_cover_frame');
    assert.equal(prompt.entryCode, 'F01');
    assert.equal(prompt.productName, '云朵床');
    assert.equal(prompt.appearance, '蓝色软包床');
    const images = content.filter((part: { type: string }) => part.type === 'image_url');
    assert.equal(images.length, prompt.candidates.length);
    receivedFrames = prompt.candidates.map((candidate: { frame: number }) => candidate.frame);
    const jpeg = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
    const dimensions = await sharp(jpeg).metadata();
    assert.equal(dimensions.format, 'jpeg');
    assert.equal(dimensions.height, 480);
    assert.equal(dimensions.width, 360);
    requests++;
    await onRequest?.();
    response.writeHead(code, { 'Content-Type': 'application/json' });
    response.end(code === 200 ? JSON.stringify({ choices: [{ message: { content: reply } }] }) : '{"error":{"message":"PRIVATE_UPSTREAM_VALUE"}}');
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const db = getDb();
  db.prepare("INSERT INTO providers(id,name,baseUrl) VALUES ('p','fixture','https://fixture.invalid')").run();
  db.prepare("INSERT INTO projects (id,name,providerId,model,prompt) VALUES ('project','云朵床项目','p','m','')").run();
  db.prepare("INSERT INTO image_assets(id,projectId,role,filename,path) VALUES ('image','project','input','fixture.png','fixture.png')").run();
  db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel) VALUES ('p','fixture','kling','','','','fixture')").run();
  const readiness = await ensureOneClickFilmSchemaReady({ db, backupRoot: path.join(dataRoot, 'data', 'backups') });
  assert.equal(readiness.state, 'ready', JSON.stringify(readiness));
  // Opt out of real configured providers. The only usable fixture provider is on loopback.
  seedScriptProviders();
  db.prepare("UPDATE script_providers SET enabled=0").run();
  const run = getOrCreateRun(db, 'project');
  const analysis = createAnalysisVersion(db, { run, sourceImageIds: [], status: 'running' });
  markAnalysisSucceeded(db, { analysisId: analysis.id, productName: '云朵床', appearance: '蓝色软包床', sceneClues: '卧室',
    providerId: 'fixture', model: 'fixture', raw: {}, points: [] });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO one_click_film_entries
    (id,runId,projectId,ordinal,code,structure,structureSource,soundMode,status,promptDurationSec,promptAspectRatio,analysisId,productNameSnapshot,createdAt,updatedAt)
    VALUES ('entry',?,'project',1,'F01','scene','auto','none','confirmed',3,'3:4',?,'云朵床',?,?)`).run(run.id, analysis.id, now, now);
  const directory = path.join(dataRoot, 'storage', 'videos');
  fs.mkdirSync(directory, { recursive: true });
  const video = path.join(directory, 'fixture.mp4');
  await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x720:r=24:d=3', '-pix_fmt', 'yuv420p', video], { timeoutMs: 20_000 });
  const source = (id: string, durationUs: number, cutsUs: number[]) => {
    db.prepare(`INSERT INTO video_jobs(id,projectId,sourceImageId,providerId,model,prompt,status,localVideoPath)
      VALUES (?,'project','image','p','fixture','','succeeded',?)`).run('video-' + id, video);
    db.prepare(`INSERT INTO one_click_film_video_jobs
      (id,runId,projectId,entryId,entryCode,requestKey,shotSetId,shotId,videoJobId,status,providerId,model,generationMode,aspectRatio,durationSec,scriptSnapshotJson,createdAt,updatedAt)
      VALUES (?,?,'project','entry','F01',?,'ss','shot',?,'succeeded','p','fixture','direct','3:4',?,?,?,?)`)
      .run(id, run.id, id, 'video-' + id, durationUs / 1e6, JSON.stringify({ analysisId: analysis.id, productName: '云朵床', soundMode: 'none' }), now, now);
    upsertReviewFromDetection(db, { run, jobId: id, entryId: 'entry', entryCode: 'F01', durationUs, fps: 24, cutsUs, detection: cutsUs.length ? 'cuts' : 'single' });
    return readFilmBody(db, run, 'F01')!;
  };
  let body = source('original', 3_000_000, [1_000_000, 2_000_000]);
  preparePackaging(db, { run, codes: ['F01'], options: {}, allowPreview: true });
  const current = () => listPackaging(db, run)[0]!;
  await syncFilmAutoCover(db, run, body);
  assert.equal(current().autoCover?.reason, 'no_provider');
  assert.equal(current().autoCover?.media?.frame, 0);
  const address = server.address() as { port: number };
  db.prepare(`INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,enabled,supportsVision,isBuiltin)
    VALUES ('cover-fixture','00-fixture','openai-compatible','openai-compatible',?,'fixture-secret','fixture-vision',1,1,0)`)
    .run('http://127.0.0.1:' + address.port + '/v1');
  await syncFilmAutoCover(db, run, body);
  assert.equal(requests, 0, '配置恢复后仍需显式重试');
  const retry = () => retryFilmAutoCover(db, run, 'F01', body.signature, current().autoCover!.attempt);
  const initialAttempt = current().autoCover!.attempt;
  retry();
  retryFilmAutoCover(db, run, 'F01', body.signature, initialAttempt);
  const framing = { scale: 1.5, offsetX: 0.2, offsetY: -0.15 };
  const initialCover = { kind: 'auto_frame', frame: 0, sourceSignature: body.signature, fallback: true, framing };
  const framed = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: current().revision,
    options: { coverMedia: initialCover } })[0]!;
  assert.deepEqual(framed.options.coverMedia, initialCover);
  const before = current().revision;
  await Promise.all([syncFilmAutoCover(db, run, body), syncFilmAutoCover(db, run, body)]);
  assert.equal(fixtureError, undefined);
  assert.equal(requests, 1, '并发同步只请求一次');
  assert.deepEqual(receivedFrames, [12, 36, 60], '每个候选位于镜头内部');
  assert.equal(current().autoCover?.attempt, initialAttempt + 1);
  const auto = current().options.coverMedia;
  assert.deepEqual(auto, { kind: 'auto_frame', frame: 36, shotId: 's2', sourceSignature: body.signature, framing });
  assert.equal(current().revision, before + 1, '可见封面变化更新包装修订');

  code = 451;
  retry();
  await syncFilmAutoCover(db, run, body);
  assert.equal(current().autoCover?.reason, 'content_filtered');
  assert.equal(current().autoCover?.media?.frame, 0);
  assert.ok(!JSON.stringify(current()).includes('PRIVATE_UPSTREAM_VALUE'));
  code = 200;
  for (const [malformed, reason] of [['not json', 'invalid_result'], ['{"candidate":99}', 'invalid_result'], ['{"candidate":null}', 'no_panorama']]) {
    reply = malformed;
    retry();
    await syncFilmAutoCover(db, run, body);
    assert.equal(current().autoCover?.reason, reason);
    assert.equal(current().autoCover?.media?.frame, 0);
  }

  const timeout = Promise.withResolvers<void>();
  onRequest = () => timeout.promise;
  retry();
  try {
    await syncFilmAutoCover(db, run, body);
    assert.equal(current().autoCover?.reason, 'timeout');
    assert.equal(current().autoCover?.media?.frame, 0);
  } finally {
    timeout.resolve();
    onRequest = undefined;
  }

  reply = '{"candidate":2}';
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onRequest = () => { entered.resolve(); return release.promise; };
  retry();
  const pending = syncFilmAutoCover(db, run, body);
  await entered.promise;
  assert.equal(current().autoCover?.status, 'pending');
  const manual = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: current().revision, options: { coverMedia: { kind: 'video_frame', frame: 65 } } })[0]!;
  release.resolve();
  await pending;
  onRequest = undefined;
  assert.equal(current().autoCover?.status, 'ready');
  assert.deepEqual(current().options.coverMedia, manual.options.coverMedia);
  assert.equal(current().revision, manual.revision, '晚到的自动结果不改手动草稿与修订');

  body = source('short-body', 1_000_000, []);
  assert.equal(current().autoCover?.status, 'pending');
  await syncFilmAutoCover(db, run, body);
  assert.deepEqual(current().options.coverMedia, { kind: 'video_frame', frame: 23 });
  assert.equal(current().coverFrameClamped, true);
  updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: current().revision, options: { coverMedia: null } });
  assert.equal(current().options.coverMedia?.kind, 'auto_frame');
  reply = '{"candidate":1}';
  body = source('changed-body', 2_000_000, [1_000_000]);
  await syncFilmAutoCover(db, run, body);
  assert.equal(current().autoCover?.sourceSignature, body.signature);
  assert.equal(current().autoCover?.media?.frame, 12);
  assert.equal(current().options.coverMedia?.kind, 'auto_frame');

  const oldChoice = current().options.coverMedia;
  const revisionBeforeRender = current().revision;
  const exporting = await tryFilmRequestLock('cover-draft', [body.entryId]);
  assert.ok(exporting);
  try {
    reply = '{"candidate":2}';
    retry();
    await syncFilmAutoCover(db, run, body);
    assert.equal(current().autoCover?.media?.frame, 36);
    assert.equal(current().autoCoverPublicationPending, true);
    assert.equal(current().revision, revisionBeforeRender);
    assert.deepEqual(current().options.coverMedia, oldChoice, '进行中的导出保留开始时的封面');
  } finally {
    exporting.release();
  }
  await syncFilmAutoCover(db, run, body);
  assert.equal(current().revision, revisionBeforeRender + 1);

  const oldEntered = Promise.withResolvers<void>();
  const oldRelease = Promise.withResolvers<void>();
  onRequest = () => { oldEntered.resolve(); return oldRelease.promise; };
  retry();
  const olderRequest = syncFilmAutoCover(db, run, body);
  await oldEntered.promise;
  body = source('dense', 3_000_000, Array.from({ length: 17 }, (_, index) => Math.round((index + 1) * 4 / 24 * 1e6)));
  oldRelease.resolve();
  await olderRequest;
  assert.equal(current().autoCover?.status, 'pending');
  assert.equal(current().autoCover?.sourceSignature, body.signature);
  const revisionBeforeNew = current().revision;
  assert.equal(current().options.coverMedia?.kind, 'auto_frame');
  onRequest = undefined;
  reply = '{"candidate":8}';
  await syncFilmAutoCover(db, run, body);
  assert.deepEqual(receivedFrames, [2, 10, 22, 30, 42, 50, 62, 70]);
  assert.equal(current().autoCover?.media?.frame, 70);
  assert.ok(current().revision > revisionBeforeNew);
  assert.equal(fixtureError, undefined);

  // Existing image identifiers are provided by the project-image and generation modules.
  // They have no source-time coordinate and stay intact even when the next body is shorter.
  for (const kind of ['project_image', 'generated_image'] as const) {
    const chosen = { kind, assetId: kind + '-example', framing: { scale: 1.2, offsetX: 0.15, offsetY: 0.2 } };
    db.prepare(`UPDATE one_click_film_packaging SET optionsJson=json_set(optionsJson,'$.coverMedia',json(?)) WHERE entryId='entry'`)
      .run(JSON.stringify(chosen));
    const revision = current().revision;
    body = source(kind + '-body', 1_000_000, []);
    reply = '{"candidate":1}';
    await syncFilmAutoCover(db, run, body);
    assert.deepEqual(current().options.coverMedia, chosen);
    assert.equal(current().revision, revision);
  }
  console.log('one-click-film-auto-cover passed');
} finally {
  server.close();
  closeDb();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
