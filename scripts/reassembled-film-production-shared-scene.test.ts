// A real production may use its one selected scene as opening and closing video input.
// Reuse synthetic receipts to verify this without inventing duplicate image generations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProductionBegin, ProductionSync, ProductionRegistry } from '../lib/final-edit/reassembled/production-types.ts';

const source = path.resolve(process.env.FILM_SHARED_SCENE_SOURCE!);
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(source, name), 'utf8'));
assert.equal(read('result.json').paidCalls, 0);
const parent = path.resolve('outputs/2026-10-19-real-handoff'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'shared-scene-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
const { getDb, closeDb } = await import('../lib/db.ts');
const { beginProduction, syncProduction, productionItem } = await import('../lib/final-edit/reassembled/production.ts');
const db = getDb();
db.prepare("INSERT INTO providers(id,name,type,baseUrl,apiKey,model,enabled) VALUES ('production-image','synthetic receipts','openai','http://127.0.0.1:1','','synthetic-copy',0)").run();
db.prepare("INSERT INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled) VALUES ('production-video','synthetic receipts','openai-video','','','','synthetic-local',0)").run();
const begin = read('begin.json') as ProductionBegin;
begin.requestId = randomUUID(); begin.films = [{ ...begin.films[0], importKey: randomUUID() }];
const production = beginProduction(db, begin), film = production.films[0];
const sync = read('sync.json') as ProductionSync;
sync.requestId = randomUUID(); sync.expectedRevision = 0;
const s = sync.snapshot, scene = s.tasks.find(t => t.kind === 'scene' && t.outputFile === s.sceneImage)!;
const selected = [s.shots[0], s.shots.at(-1)!];
for (const shot of selected) {
  s.tasks = s.tasks.filter(t => !(t.kind === 'shot' && t.clipId === shot.id));
  shot.sourceImage = scene.inputFiles[0]; shot.generatedImage = scene.outputFile;
  for (const c of shot.candidates) {
    c.sourceImage = shot.sourceImage; c.generatedImage = shot.generatedImage!;
    c.provenance = { imageProvider: scene.providerId, imageModel: scene.model, imagePrompt: scene.prompt, imageTaskId: scene.id };
    s.tasks.find(t => t.id === c.id)!.inputFiles = [scene.outputFile!];
  }
}
const snapshot = () => JSON.stringify({
  item: productionItem(db, film.id),
  jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
  videos: db.prepare('SELECT * FROM video_jobs ORDER BY id').all(),
  shots: db.prepare('SELECT * FROM shots ORDER BY id').all(),
});
try {
  const before = snapshot();
  for (const mutate of [
    (bad: ProductionSync) => { delete bad.snapshot.sceneImage; },
    (bad: ProductionSync) => { bad.snapshot.shots[0].candidates[0].provenance.imageTaskId = 'invented-scene-task'; },
    (bad: ProductionSync) => {
      const target = bad.snapshot.shots[0], other = bad.snapshot.shots[1];
      const image = bad.snapshot.tasks.find(t => t.kind === 'shot' && t.clipId === other.id)!;
      target.generatedImage = image.outputFile;
      for (const c of target.candidates) { c.generatedImage = image.outputFile!; c.provenance = { imageProvider: image.providerId, imageModel: image.model, imagePrompt: image.prompt, imageTaskId: image.id }; bad.snapshot.tasks.find(t => t.id === c.id)!.inputFiles = [image.outputFile!]; }
    },
  ]) {
    const bad = structuredClone(sync); bad.requestId = randomUUID(); mutate(bad);
    await assert.rejects(syncProduction(db, path.join(root, 'storage'), film.id, bad), { code: 'production_invalid' });
    assert.equal(snapshot(), before);
  }
  await syncProduction(db, path.join(root, 'storage'), film.id, sync);
  const saved = snapshot(); await syncProduction(db, path.join(root, 'storage'), film.id, sync); assert.equal(snapshot(), saved);
  const registry = JSON.parse(productionItem(db, film.id).registryJson) as ProductionRegistry;
  assert.equal((db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n, s.tasks.filter(t => t.kind === 'scene' || t.kind === 'shot').length);
  const shots = db.prepare('SELECT id,latestJobId,latestGeneratedImageId FROM shots WHERE shotSetId=? ORDER BY indexNum').all(film.shotSetId) as Array<{ id: string; latestJobId: string; latestGeneratedImageId: string }>;
  for (const shot of [shots[0], shots.at(-1)!]) {
    assert.equal(shot.latestJobId, registry.jobs[scene.id]);
    assert.equal(shot.latestGeneratedImageId, registry.images[scene.outputFile!].id);
    assert.ok(db.prepare('SELECT 1 FROM shot_result_candidates WHERE shotId=? AND jobId=? AND imageAssetId=?').get(shot.id, shot.latestJobId, shot.latestGeneratedImageId));
  }
  const bad = structuredClone(sync); bad.requestId = randomUUID(); bad.expectedRevision = 1; bad.snapshot.tasks.find(t => t.id === scene.id)!.prompt += 'changed';
  await assert.rejects(syncProduction(db, path.join(root, 'storage'), film.id, bad), { code: 'production_conflict' }); assert.equal(snapshot(), saved);
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, paidCalls: 0, sharedSceneShots: selected.map(t => t.id), imageTasks: Object.keys(registry.jobs).length, duplicateTaskCreated: false, forgedOrCrossShotRejected: true, terminalImmutable: true, replayUnchanged: true }, null, 2));
  console.log('PASS selected scene reused with real task identity, no duplicate jobs, invalid provenance rejected:', root);
} finally { closeDb(); }
