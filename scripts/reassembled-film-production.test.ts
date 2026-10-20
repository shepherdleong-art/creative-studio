// Full production-to-import acceptance against an existing synthetic render.
// No queue starts, no supplier calls; simulated successful media are explicit local copies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FilmImportManifest } from '../lib/final-edit/reassembled/types.ts';
import type { ProductionBegin, ProductionSnapshot, ProductionSync, ProductionRegistry } from '../lib/final-edit/reassembled/production-types.ts';

const base = JSON.parse(fs.readFileSync(process.env.FILM_PRODUCTION_BASE_MANIFEST!, 'utf8')) as FilmImportManifest;
assert.ok(base.root.includes('synthetic') || base.root.includes('film-e2e-'), 'Synthetic baseline only');
const parent = path.resolve('outputs/2026-10-19-production'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'production-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const { getDb, closeDb } = await import('../lib/db.ts');
const { beginProduction, syncProduction, readProduction, productionItem } = await import('../lib/final-edit/reassembled/production.ts');
const { importFilm } = await import('../lib/final-edit/reassembled/import.ts');
const { sha256 } = await import('../lib/film-render/files.ts');
const { isReassembledShotSet, isReassembledImageJob } = await import('../lib/reassembled-shot-guard.ts');
const db = getDb(), storage = path.join(root, 'storage');
db.prepare("INSERT INTO providers(id,name,type,baseUrl,apiKey,model) VALUES ('production-image','Synthetic image copies','openai','http://127.0.0.1:1','','synthetic-copy')").run();
db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel) VALUES ('production-video','Synthetic video copies','openai-video','','','','synthetic-local')").run();
const originalCounts = () => Object.fromEntries(['projects', 'jobs', 'video_jobs', 'shot_sets', 'shots', 'image_assets', 'script_drafts'].map(table => [table, (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n]));
const begin: ProductionBegin = { requestId: randomUUID(), root: base.root, project: { storeCode: 'B店', productCode: 'SYNTHETIC', productSubmodel: '', productionType: 'AI种草', editorName: 'PUIKIN', providerId: 'production-image', model: 'synthetic-copy' }, films: ['01', '02'].map(key => ({ key, title: `独立成片 ${key}`, importKey: `production-${key}-${randomUUID()}`, clips: base.shots.map(s => s.id) })) };
const started = beginProduction(db, begin), counts = originalCounts();
assert.deepEqual(beginProduction(db, begin), started); assert.deepEqual(originalCounts(), counts);
assert.throws(() => beginProduction(db, { ...begin, films: [{ ...begin.films[0], title: 'changed' }] }), { code: 'production_conflict' });
assert.equal(counts.projects, 1); assert.equal(counts.shot_sets, 2); assert.equal(counts.jobs, 0); assert.equal(counts.video_jobs, 0);
const [a, b] = started.films;
assert.ok(isReassembledShotSet(db, a.shotSetId));
const generatedFolder = `production-acceptance-${randomUUID()}`;
fs.mkdirSync(path.join(base.root, generatedFolder));
const copyImage = (name: string) => { const file = `${generatedFolder}/${name}${path.extname(base.sceneImage)}`; fs.copyFileSync(path.join(base.root, base.sceneImage), path.join(base.root, file)); return file; };
const sourceImage = copyImage('source');
const initial: ProductionSnapshot = { files: { [sourceImage]: sha256(path.join(base.root, sourceImage)) }, tasks: [{ id: 'scene-task', kind: 'scene', status: 'queued', providerId: 'production-image', model: 'synthetic-copy', prompt: 'Synthetic local copy, no supplier invocation', inputFiles: [sourceImage] }], shots: base.shots.map(s => ({ id: s.id, sourceImage, candidates: [] })) };
const command: ProductionSync = { requestId: randomUUID(), expectedRevision: 0, snapshot: initial };
assert.deepEqual(await syncProduction(db, storage, a.id, command), { itemId: a.id, revision: 1 });
assert.deepEqual(await syncProduction(db, storage, a.id, command), { itemId: a.id, revision: 1 });
assert.equal(originalCounts().jobs, 0); assert.equal(originalCounts().video_jobs, 0);
await assert.rejects(syncProduction(db, storage, b.id, command), { code: 'production_conflict' });
await assert.rejects(syncProduction(db, storage, a.id, { ...command, requestId: randomUUID() }), { code: 'production_conflict' });
const snapshot = structuredClone(initial);
snapshot.files = { ...base.files, ...initial.files };
snapshot.sceneImage = base.sceneImage;
snapshot.tasks[0] = { ...snapshot.tasks[0], status: 'succeeded', outputFile: base.sceneImage };
snapshot.shots = base.shots.map(shot => {
  const generatedImage = copyImage(`${shot.id}-image`);
  snapshot.files[generatedImage] = sha256(path.join(base.root, generatedImage));
  const imageTaskId = `${shot.id}-image-task`;
  snapshot.tasks.push({ id: imageTaskId, kind: 'shot', clipId: shot.id, status: 'succeeded', providerId: 'production-image', model: 'synthetic-copy', prompt: 'Synthetic storyboard copy', inputFiles: [sourceImage, base.sceneImage], outputFile: generatedImage });
  const candidates = shot.candidates.map(c => {
    snapshot.tasks.push({ id: c.id, kind: 'video', clipId: shot.id, status: 'succeeded', providerId: 'production-video', model: c.model, prompt: c.prompt, inputFiles: [generatedImage], outputFile: c.file });
    return { ...c, providerId: 'production-video', sourceImage, generatedImage, provenance: { imageProvider: 'production-image', imageModel: 'synthetic-copy', imagePrompt: 'Synthetic storyboard copy', imageTaskId } };
  });
  return { id: shot.id, sourceImage, generatedImage, selectedCandidateId: shot.selectedCandidateId, candidates };
});
const spec = JSON.parse(fs.readFileSync(path.join(base.root, base.specFile), 'utf8'));
snapshot.tasks.push({ id: 'script-task', kind: 'script', status: 'succeeded', providerId: 'synthetic-local', model: 'synthetic-local', prompt: 'Synthetic subtitle fixture, no LLM request', inputFiles: [] });
snapshot.script = { taskId: 'script-task', narration: spec.subtitles.map((s: { text: string }) => s.text).join('\n') };
const complete: ProductionSync = { requestId: randomUUID(), expectedRevision: 1, snapshot };
for (const malformed of [
  { ...snapshot, tasks: [null] },
  { ...snapshot, shots: [null] },
  { ...snapshot, tasks: [{ ...snapshot.tasks[0], headers: { authorization: 'must-never-persist' } }] },
  { ...snapshot, shots: [{ ...snapshot.shots[0], candidates: [null] }] },
  { ...snapshot, files: { ...snapshot.files, '../escape.png': 'a'.repeat(64) } },
]) {
  await assert.rejects(syncProduction(db, storage, a.id, { ...complete, requestId: randomUUID(), snapshot: malformed as unknown as ProductionSnapshot }), { code: 'production_invalid' });
  assert.equal(productionItem(db, a.id).revision, 1);
}
await syncProduction(db, storage, a.id, complete);
const beforeImport = originalCounts();
for (const job of db.prepare('SELECT id FROM jobs').all() as Array<{ id: string }>) assert.ok(isReassembledImageJob(db, job.id));
const audioOnly = structuredClone(snapshot);
const voiceFile = spec.audio.voices[0].file.split(path.sep).join('/');
audioOnly.tasks.push({ id: 'audio-is-not-video', kind: 'video', clipId: snapshot.shots[0].id, status: 'succeeded', providerId: 'production-video', model: 'synthetic-local', prompt: 'Reject audio-only result', inputFiles: [snapshot.shots[0].generatedImage!], outputFile: voiceFile });
await assert.rejects(syncProduction(db, storage, a.id, { requestId: randomUUID(), expectedRevision: 2, snapshot: audioOnly }), /有效画面流/);
assert.deepEqual(originalCounts(), beforeImport);
assert.equal((db.prepare("SELECT COUNT(*) n FROM jobs WHERE status!='succeeded'").get() as { n: number }).n, 0);
assert.equal((db.prepare("SELECT COUNT(*) n FROM video_jobs WHERE status!='succeeded'").get() as { n: number }).n, 0);
const ready = readProduction(db, started.id).films[0]; assert.equal(ready.conflict, false);
assert.ok(Object.values(ready.images).every(url => url.startsWith('/api/images/outputs/reassembled-productions/')));
assert.equal(ready.snapshot.script!.narration, snapshot.script.narration);
const invalid = structuredClone(snapshot); invalid.tasks[0].status = 'queued'; delete invalid.tasks[0].outputFile;
await assert.rejects(syncProduction(db, storage, a.id, { requestId: randomUUID(), expectedRevision: 2, snapshot: invalid }), { code: 'production_conflict' });
// Copy/probe is asynchronous. A real human write during it must win even though revision has not changed.
const competing = syncProduction(db, storage, b.id, { requestId: randomUUID(), expectedRevision: 0, snapshot });
db.prepare('UPDATE shot_sets SET name=? WHERE id=?').run('人工命名，禁止覆盖', b.shotSetId);
await assert.rejects(competing, { code: 'production_conflict' });
assert.equal(productionItem(db, b.id).revision, 0);
assert.equal((db.prepare('SELECT name FROM shot_sets WHERE id=?').get(b.shotSetId) as { name: string }).name, '人工命名，禁止覆盖');
assert.equal(readProduction(db, started.id).films[1].conflict, true);
const otherBefore = productionItem(db, b.id);
const delivery = path.join(root, '客户交付'); fs.mkdirSync(delivery);
const render = JSON.parse(fs.readFileSync(path.join(base.root, base.renderManifestFile), 'utf8'));
fs.copyFileSync(render.outputs.video, path.join(delivery, `${base.delivery.baseName}.mp4`));
fs.copyFileSync(render.outputs.cover, path.join(delivery, `${base.delivery.baseName}-封面.jpg`));
const manifest: FilmImportManifest = { ...base, projectId: started.projectId, importKey: a.importKey, title: a.title, sceneImage: snapshot.sceneImage!, sceneProvenance: { provider: 'production-image', model: 'synthetic-copy', prompt: snapshot.tasks[0].prompt, localTaskId: 'scene-task' }, files: snapshot.files, shots: snapshot.shots.map(({ id, selectedCandidateId, candidates }) => ({ id, selectedCandidateId: selectedCandidateId!, candidates })), delivery: { ...base.delivery, directory: delivery }, production: { itemId: a.id, expectedRevision: 2 } };
const missingIdentity = structuredClone(manifest); delete missingIdentity.production;
await assert.rejects(importFilm(db, storage, missingIdentity), { code: 'production_conflict' });
fs.writeFileSync(path.join(root, 'begin.json'), JSON.stringify(begin, null, 2));
fs.writeFileSync(path.join(root, 'initial-sync.json'), JSON.stringify(command, null, 2));
fs.writeFileSync(path.join(root, 'sync.json'), JSON.stringify(complete, null, 2));
fs.writeFileSync(path.join(root, 'import.json'), JSON.stringify(manifest, null, 2));
const binding = await importFilm(db, storage, manifest);
assert.equal(binding.shotSetId, a.shotSetId); assert.equal(binding.groupId, a.groupId); assert.equal(binding.variantId, a.variantId);
const registry = JSON.parse(productionItem(db, a.id).registryJson) as ProductionRegistry;
const importedCandidates = JSON.parse(binding.candidatesJson) as Array<{ videoJobId: string }>;
assert.deepEqual(importedCandidates.map(c => c.videoJobId).sort(), Object.values(registry.videos).map(v => v.id).sort());
assert.deepEqual(originalCounts(), beforeImport, 'Handoff cannot create duplicate project/material/task/shot/script rows');
assert.deepEqual(productionItem(db, b.id), otherBefore, 'Handoff only affects the selected film');
assert.equal((await importFilm(db, storage, manifest)).id, binding.id);
assert.deepEqual(await syncProduction(db, storage, a.id, complete), { itemId: a.id, revision: 2 }, 'Late replay returns original result only');
await assert.rejects(syncProduction(db, storage, a.id, { ...complete, requestId: randomUUID(), expectedRevision: 3 }), { code: 'production_conflict' });
// Final import performs its own asynchronous technical gate. A human write
// during that gate must also prevent handoff, preserving the human row.
const racingProduction = beginProduction(db, { requestId: randomUUID(), root: base.root, projectId: started.projectId, films: [{ key: 'race', title: '导入竞争验收', importKey: randomUUID(), clips: base.shots.map(s => s.id) }] });
const racingItem = racingProduction.films[0];
await syncProduction(db, storage, racingItem.id, { requestId: randomUUID(), expectedRevision: 0, snapshot });
const racingDelivery = path.join(root, '导入竞争交付'); fs.mkdirSync(racingDelivery);
fs.copyFileSync(render.outputs.video, path.join(racingDelivery, `${base.delivery.baseName}.mp4`));
fs.copyFileSync(render.outputs.cover, path.join(racingDelivery, `${base.delivery.baseName}-封面.jpg`));
const racingManifest = { ...manifest, importKey: racingItem.importKey, production: { itemId: racingItem.id, expectedRevision: 1 }, delivery: { ...manifest.delivery, directory: racingDelivery } };
const importing = importFilm(db, storage, racingManifest);
const racingShotId = Object.values(JSON.parse(productionItem(db, racingItem.id).shotIdsJson))[0];
db.prepare('UPDATE shots SET reviewMark=? WHERE id=?').run('manual-keep', racingShotId);
await assert.rejects(importing, { code: 'production_conflict' });
assert.equal((db.prepare('SELECT reviewMark FROM shots WHERE id=?').get(racingShotId) as { reviewMark: string }).reviewMark, 'manual-keep');
assert.equal(productionItem(db, racingItem.id).bindingId, null);
assert.equal(db.prepare('SELECT id FROM final_edit_groups WHERE id=?').get(racingItem.groupId), undefined);
const final = readProduction(db, started.id); assert.equal(final.films[0].bindingId, binding.id);
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, root, production: final, bindingId: binding.id, counts: originalCounts(), paidCalls: 0, checks: ['idempotent-begin', 'empty-execution-queues', 'stable-shot-identities', 'progress-only-queued', 'terminal-only-core-rows', 'immutable-terminal', 'request-idempotence', 'cross-film-request-denied', 'async-human-conflict', 'other-film-unchanged', 'stable-final-handoff', 'no-duplicate-objects', 'late-replay-no-overwrite', 'import-async-human-conflict'] }, null, 2));
closeDb();
console.log(`PASS production ownership, terminal sync, manual protection and final import: ${root}`);
