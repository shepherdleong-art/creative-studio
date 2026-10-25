// FILM_IMPORT_SPEC=/absolute/completed/spec.json node scripts/reassembled-film.integration.acceptance.ts
// Uses an existing synthetic fixed-render fixture; no provider calls. Leaves an isolated DB for browser acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FilmImportManifest, RegisteredCandidate } from '../lib/final-edit/reassembled/types.ts';
import type { FinalEditVariantView } from '../lib/final-edit/types.ts';
import { consumeFilmNavigation } from '../desktop/reassembled-navigation.ts';

const input = process.env.FILM_IMPORT_SPEC;
if (!input) throw new Error('Set FILM_IMPORT_SPEC to a verified synthetic spec.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.FILM_INTEGRATION_PARENT || os.tmpdir(), 'reassembled-P1-中文 空格-')));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
process.env.CREATIVE_STUDIO_DESKTOP = '1';
process.env.CREATIVE_STUDIO_INSTANCE_ID = 'p1-integration';
const { sha256 } = await import('../lib/film-render/files.ts');
const { dataRoot } = await import('../lib/data-root.ts');
assert.equal(dataRoot(), root, 'Test must never open the real workspace database');
const { getDb } = await import('../lib/db.ts');
const { importFilm } = await import('../lib/final-edit/reassembled/import.ts');
const { refreshFilmReview, reviewHtml } = await import('../lib/final-edit/reassembled/review.ts');
const { enqueueFilmRender, executeFilmJob } = await import('../lib/final-edit/reassembled/jobs.ts');
const { publishFilmPair, archivePriorFilm, verifyDeliveryDirectory } = await import('../lib/final-edit/reassembled/delivery.ts');
const { filmBinding } = await import('../lib/final-edit/reassembled/store.ts');
const { createFinalEditWorkspace } = await import('../lib/final-edit/workspace.ts');
const { runFfmpeg, probeDurationSec } = await import('../lib/ffmpeg.ts');
const { cancelFinalEditRenderJob } = await import('../lib/final-edit/worker.ts');
const db = getDb(), storageRoot = path.join(root, 'storage');
fs.mkdirSync(path.join(storageRoot, 'run'), { recursive: true });
fs.writeFileSync(path.join(storageRoot, 'run/electron-service.json'), JSON.stringify({ instanceId: 'p1-integration', origin: 'http://127.0.0.1:3391' }));
db.prepare("INSERT INTO providers(id,name,baseUrl) VALUES ('p1-fixture','Local synthetic fixture','http://127.0.0.1:1')").run();
db.prepare("INSERT INTO projects(id,name,providerId,model,prompt) VALUES ('p1-film','实拍重组隔离验收','p1-fixture','synthetic','No provider calls')").run();
db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel) VALUES ('p1-video','Local synthetic fixture','openai-video','','','','synthetic')").run();
const spec = JSON.parse(fs.readFileSync(input, 'utf8'));
const renderFile = path.join(path.dirname(input), 'render-manifest.json');
const render = JSON.parse(fs.readFileSync(renderFile, 'utf8'));
const sourceRoot = spec.project.root;
const alternative = 'variants/01/p1-alternative.mp4';
if (!fs.existsSync(path.join(sourceRoot, alternative))) await runFfmpeg(['-nostdin', '-hide_banner', '-n', '-f', 'lavfi', '-i', 'color=c=0x195a80:size=540x720:rate=24:duration=8', '-an', '-c:v', 'libx264', '-threads', '2', path.join(sourceRoot, alternative)], { timeoutMs: 30000 });
const rel = (file: string) => path.relative(sourceRoot, file).split(path.sep).join('/');
const canonical = (name: string) => name.split(path.sep).join('/');
const cover = canonical(spec.cover?.image || spec.classic.cover.image);
const names = [...new Set<string>([...Object.keys(render.inputs).map(canonical), rel(input), rel(renderFile), rel(render.outputs.video), rel(render.outputs.cover), alternative, cover])];
const delivery = path.join(root, '客户交付 空格'); fs.mkdirSync(delivery);
fs.copyFileSync(render.outputs.video, path.join(delivery, `${spec.project.baseName}.mp4`));
fs.copyFileSync(render.outputs.cover, path.join(delivery, `${spec.project.baseName}-封面.jpg`));
const syntheticDurations = new Map(await Promise.all([...new Set<string>([...spec.shots.map((shot: { file: string }) => canonical(shot.file)), alternative])].map(async file => [file, await probeDurationSec(path.join(sourceRoot, file))] as const)));
const manifest: FilmImportManifest = { schemaVersion: 1, importKey: 'isolated-fixture-v1', projectId: 'p1-film', root: sourceRoot, title: '实拍成片验收', sceneImage: cover, sceneProvenance: { provider: 'local-synthetic-fixture', model: 'none', prompt: 'Synthetic fixtures, no generation request' }, specFile: rel(input), renderManifestFile: rel(renderFile),
  files: Object.fromEntries(names.map(name => [name, sha256(path.join(sourceRoot, name))])),
  shots: spec.shots.map((shot: { id: string; file: string }, i: number) => ({ id: shot.id, selectedCandidateId: `${shot.id}-original`, candidates: [canonical(shot.file), ...(i === 0 ? [alternative] : [])].map((file, n) => ({ id: `${shot.id}-${n ? 'alternative' : 'original'}`, file, sourceImage: cover, generatedImage: cover, providerId: 'p1-video', model: 'synthetic-local', prompt: 'FFmpeg synthetic video; no remote generation', provenance: { imageProvider: 'local-fixture', imageModel: 'sharp', imagePrompt: 'Solid color test cover' }, approvedRangeSec: [0, syntheticDurations.get(file)!] })) })),
  delivery: { directory: delivery, baseName: spec.project.baseName } };
console.log(`EVIDENCE_ROOT=${root}`);
fs.writeFileSync(path.join(root, 'import.json'), JSON.stringify(manifest, null, 2));
const originalSpecHash = sha256(input), originalRenderHash = sha256(renderFile);
for (const invalidPath of ['../outside.mp4', 'variants/../outside.mp4', 'variants\\01\\opening.mp4', 'C:/outside.mp4']) {
  await assert.rejects(importFilm(db, storageRoot, { ...manifest, files: { [invalidPath]: 'a'.repeat(64) } }), { code: 'film_import_invalid' });
}
const binding = await importFilm(db, storageRoot, manifest);
assert.ok(binding.managedRootRelative.endsWith(`--${binding.id}/project`), 'managed folder includes a readable delivery name and stable identity');
assert.equal(sha256(input), originalSpecHash, 'original fixed-render spec must stay unchanged');
assert.equal(sha256(renderFile), originalRenderHash, 'original provenance must stay unchanged');
refreshFilmReview(db, binding.id, true);
assert.equal((await importFilm(db, storageRoot, manifest)).id, binding.id);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_artifacts WHERE sourceJobId=?').get(`import:${binding.id}`) as {n:number}).n, 2);
await assert.rejects(importFilm(db, storageRoot, { ...manifest, title: 'overwrite human edit' }));
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM final_edit_groups').get() as {n:number}).n, 1);
assert.equal((db.prepare("SELECT COUNT(*) AS n FROM video_jobs WHERE status!='succeeded'").get() as {n:number}).n, 0);
const forbidden = async (): Promise<never> => { throw new Error('Must not call provider or analyzer during import/edit/export'); };
const workspace = createFinalEditWorkspace({ db, storageRoot, probeVideo: forbidden, analyzeVideo: forbidden, synthesize: forbidden });
let group = workspace.load(binding.groupId);
assert.equal(group.variants[0].timeline.clips.length, spec.shots.length);
assert.equal(group.assets.length, spec.shots.length + 1);
const candidates = JSON.parse(binding.candidatesJson) as RegisteredCandidate[];
const c = candidates.find(c => c.file === alternative)!;
const first = group.variants[0].timeline.clips[0];
const command = { scope: 'variant' as const, variantId: binding.variantId, expectedRevision: 0, type: 'replace_clip' as const, clipId: first.id, videoJobId: c.videoJobId, sourceFingerprint: c.fingerprint, sourceInFrame: 0, sourceOutFrame: first.sourceOutFrame - first.sourceInFrame };
const changed = workspace.apply(command).view as FinalEditVariantView;
assert.equal(changed.revision, 1);
assert.throws(() => workspace.apply(command), { code: 'revision_conflict' });
assert.throws(() => workspace.apply({ scope: 'variant', variantId: binding.variantId, expectedRevision: 1, type: 'set_bgm', trackId: 'missing' }), { code: 'film_edit_unsupported' });
assert.equal((await importFilm(db, storageRoot, manifest)).id, binding.id);
assert.equal(workspace.load(binding.groupId).variants[0].revision, 1, 'idempotent reimport preserves human edit');
group = workspace.load(binding.groupId);
const enqueue = (mode: 'deliver' | 'preview') => enqueueFilmRender(db, { groupId: binding.groupId, variantId: binding.variantId, expectedGroupRevision: group.revision, expectedVariantRevision: group.variants[0].revision }, mode);
const cancelled = enqueue('preview');
cancelFinalEditRenderJob(cancelled.id);
assert.equal((db.prepare('SELECT status FROM final_edit_jobs WHERE id=?').get(cancelled.id) as {status:string}).status, 'cancelled');
// No preview/approval gate: direct export after replacement must enqueue.
const job = enqueue('deliver'); assert.equal(enqueue('deliver').id, job.id);
assert.match(job.target.videoFilename, /-v2\.mp4$/);
const snapshot = JSON.parse((db.prepare('SELECT inputSnapshotJson FROM final_edit_jobs WHERE id=?').get(job.id) as {inputSnapshotJson:string}).inputSnapshotJson);
assert.equal(snapshot.spec.shots[0].file, alternative);
assert.equal(filmBinding(db, binding.groupId)!.previewRevision, 0);
const oldHash = sha256(path.join(delivery, `${spec.project.baseName}.mp4`));
// Conflict, symlink and archive error branches must preserve both the original and foreign files.
fs.writeFileSync(path.join(delivery, `${spec.project.baseName}-v2-封面.jpg`), 'foreign');
assert.throws(() => publishFilmPair(binding, 2, render.outputs.video, render.outputs.cover));
assert.equal(sha256(path.join(delivery, `${spec.project.baseName}.mp4`)), oldHash);
assert.ok(!fs.existsSync(path.join(delivery, `${spec.project.baseName}-v2.mp4`)));
fs.unlinkSync(path.join(delivery, `${spec.project.baseName}-v2-封面.jpg`));
const markerDir = path.join(delivery, '.creative-studio', binding.id);
fs.renameSync(delivery, delivery + '-offline');
assert.throws(() => verifyDeliveryDirectory(binding), { code: 'film_delivery_unavailable' });
fs.renameSync(delivery + '-offline', delivery);
fs.renameSync(markerDir, markerDir + '-saved'); fs.symlinkSync(markerDir + '-saved', markerDir, process.platform === 'win32' ? 'junction' : 'dir');
assert.throws(() => verifyDeliveryDirectory(binding), /符号链接/);
fs.unlinkSync(markerDir); fs.renameSync(markerDir + '-saved', markerDir);
const nav = path.join(storageRoot, 'run/reassembled-navigation.json');
const item = { instanceId: 'p1-integration', createdAt: Date.now(), projectId: 'p1-film', groupId: binding.groupId, shotSetId: binding.shotSetId, deliveryVersion: 1 };
fs.writeFileSync(nav, JSON.stringify(item)); assert.match(consumeFilmNavigation(root, 'p1-integration')!, /tab=final-edit/);
fs.writeFileSync(nav, JSON.stringify({ ...item, instanceId: 'foreign' })); assert.equal(consumeFilmNavigation(root, 'p1-integration'), null);
fs.writeFileSync(nav, JSON.stringify({ ...item, projectId: '../outside' })); assert.equal(consumeFilmNavigation(root, 'p1-integration'), null);
fs.writeFileSync(nav, JSON.stringify(item)); assert.equal(consumeFilmNavigation(root, 'p1-integration', item.createdAt + 31000), null);
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ root, bindingId: binding.id, groupId: binding.groupId, variantId: binding.variantId, shotSetId: binding.shotSetId, jobId: job.id, delivery, manifest: path.join(root, 'import.json') }, null, 2));
if (process.env.FILM_INTEGRATION_RENDER === '1') {
  db.prepare("UPDATE final_edit_jobs SET status='running' WHERE id=?").run(job.id);
  const row = db.prepare('SELECT id,groupId,inputSnapshotJson FROM final_edit_jobs WHERE id=?').get(job.id) as { id: string; groupId: string; inputSnapshotJson: string };
  // Deliberately block archive; rendering and new-pair publication still succeed.
  fs.writeFileSync(path.join(delivery, '旧版'), 'occupied');
  await executeFilmJob(db, storageRoot, row, new AbortController().signal);
  assert.equal(filmBinding(db, binding.groupId)!.deliveryVersion, 2);
  assert.ok(fs.existsSync(path.join(delivery, `${spec.project.baseName}.mp4`)));
  const output = JSON.parse((db.prepare('SELECT outputJson FROM final_edit_jobs WHERE id=?').get(job.id) as {outputJson:string}).outputJson);
  assert.match(output.archiveWarning, /新版已交付/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM project_artifacts WHERE sourceJobId=?').get(job.id) as {n:number}).n, 2);
  fs.unlinkSync(path.join(delivery, '旧版'));
  assert.equal(archivePriorFilm(db, filmBinding(db, binding.groupId)!, 2), null);
  assert.equal(sha256(path.join(delivery, '旧版', `${spec.project.baseName}.mp4`)), oldHash);
  assert.notEqual(sha256(path.join(delivery, `${spec.project.baseName}-v2.mp4`)), oldHash);
  await executeFilmJob(db, storageRoot, row, new AbortController().signal);
  assert.equal(filmBinding(db, binding.groupId)!.deliveryVersion, 2, 'recovery does not publish v3');
  assert.match(reviewHtml(db, binding.id), /data-delivery-version="2"/);
  assert.equal((await importFilm(db, storageRoot, manifest)).id, binding.id, 'reimport after archival stays idempotent');
  console.log('PASS actual fixed render, changed shot, published v2, archive failure/retry, job recovery');
}
db.close();
console.log('PASS registration, provenance, edit protection, direct export without confirmation, isolation, cancel, delivery conflicts, navigation identity');
