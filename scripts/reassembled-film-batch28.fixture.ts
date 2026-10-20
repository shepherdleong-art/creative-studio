// 28 independent workbench identities using explicitly reused synthetic test media, no generation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FilmImportManifest } from '../lib/final-edit/reassembled/types.ts';
import type { ProductionBegin, ProductionSync } from '../lib/final-edit/reassembled/production-types.ts';

const source = path.resolve(process.env.FILM_BATCH_SOURCE!);
assert.ok(source.includes('2026-10-19-production'));
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(source, name), 'utf8'));
assert.equal(read('result.json').ok, true); assert.equal(read('result.json').paidCalls, 0);
const base = read('import.json') as FilmImportManifest;
assert.ok(base.root.includes('synthetic'));
const parent = path.resolve('outputs/2026-10-19-film-batch28'); fs.mkdirSync(parent, { recursive: true });
const root = process.env.FILM_BATCH_RESUME ? fs.realpathSync(process.env.FILM_BATCH_RESUME) : fs.mkdtempSync(path.join(parent, 'batch28-'));
assert.ok(root.startsWith(parent + path.sep) && path.basename(root).startsWith('batch28-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const { getDb, closeDb } = await import('../lib/db.ts');
const { beginProduction, syncProduction, readProduction } = await import('../lib/final-edit/reassembled/production.ts');
const { importFilm } = await import('../lib/final-edit/reassembled/import.ts');
const db = getDb(), storage = path.join(root, 'storage');
db.prepare("INSERT OR IGNORE INTO providers(id,name,type,baseUrl,apiKey,model,enabled) VALUES ('production-image','28-film synthetic copies','openai','http://127.0.0.1:1','','synthetic-copy',0)").run();
db.prepare("INSERT OR IGNORE INTO video_providers(id,name,type,baseUrlEnv,apiKeyEnv,modelEnv,defaultModel,enabled) VALUES ('production-video','28-film synthetic copies','openai-video','','','','synthetic-local',0)").run();
const original = read('begin.json') as ProductionBegin;
const saved = db.prepare('SELECT requestJson FROM final_edit_film_productions').all() as { requestJson: string }[];
if (process.env.FILM_BATCH_RESUME) assert.equal(saved.length, 1);
const begin: ProductionBegin = process.env.FILM_BATCH_RESUME ? JSON.parse(saved[0].requestJson) : { ...original, requestId: randomUUID(), films: Array.from({ length: 28 }, (_, i) => ({ key: String(i + 1).padStart(2, '0'), title: `同产品合成验收第 ${i + 1} 条`, importKey: randomUUID(), clips: base.shots.map(s => s.id) })) };
const production = beginProduction(db, begin);
assert.equal(production.films.length, 28);
assert.deepEqual(beginProduction(db, begin), production);
const template = read('sync.json') as ProductionSync;
const rendered = JSON.parse(fs.readFileSync(path.join(base.root, base.renderManifestFile), 'utf8'));
console.log(`EVIDENCE_ROOT=${root}`);
for (const film of production.films) {
  if (film.bindingId) { console.log(`EXISTING ${film.key}/28`); continue; }
  const space = fs.statfsSync(root);
  assert.ok(space.bavail * space.bsize >= 512 * 1024 * 1024, 'Stop before the next import: less than 512 MiB free');
  const sync: ProductionSync = { ...template, requestId: randomUUID(), expectedRevision: 0 };
  if (film.revision === 0) await syncProduction(db, storage, film.id, sync);
  else { assert.equal(film.revision, 1); assert.deepEqual(film.snapshot, template.snapshot); }
  const directory = path.join(root, '客户交付', film.key); fs.mkdirSync(directory, { recursive: true });
  const copyIfMissing = (from: string, to: string) => { if (fs.existsSync(to)) assert.deepEqual(fs.readFileSync(to), fs.readFileSync(from)); else fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); };
  copyIfMissing(rendered.outputs.video, path.join(directory, `${base.delivery.baseName}.mp4`));
  copyIfMissing(rendered.outputs.cover, path.join(directory, `${base.delivery.baseName}-封面.jpg`));
  const manifest: FilmImportManifest = { ...base, projectId: production.projectId, importKey: film.importKey, title: film.title, production: { itemId: film.id, expectedRevision: 1 }, delivery: { ...base.delivery, directory } };
  const binding = await importFilm(db, storage, manifest);
  assert.equal(binding.groupId, film.groupId); assert.equal(binding.shotSetId, film.shotSetId);
  // Release only the regenerable 20-frame raw diagnostic after its checks pass.
  const raw = path.join(storage, binding.managedRootRelative, '.workbench/import-check/cover-frames.rgb');
  const actual = fs.realpathSync(raw);
  assert.ok(actual.startsWith(root + path.sep) && !fs.lstatSync(raw).isSymbolicLink());
  const report = path.join(path.dirname(raw), 'checks.json');
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).ok, true);
  assert.equal(fs.statSync(raw).size, 93312000);
  fs.appendFileSync(path.join(root, 'released-raw-checks.jsonl'), JSON.stringify({ path: actual, size: 93312000, sha256: createHash('sha256').update(fs.readFileSync(raw)).digest('hex'), checks: report }) + '\n');
  fs.unlinkSync(raw);
  console.log(`READY ${film.key}/28`);
}
const complete = readProduction(db, production.id);
assert.ok(complete.films.every(f => f.bindingId && !f.conflict));
assert.equal(new Set(complete.films.map(f => f.groupId)).size, 28);
assert.equal(new Set(complete.films.map(f => f.shotSetId)).size, 28);
assert.equal((db.prepare("SELECT COUNT(*) n FROM jobs WHERE status!='succeeded'").get() as { n: number }).n, 0);
assert.equal((db.prepare("SELECT COUNT(*) n FROM video_jobs WHERE status!='succeeded'").get() as { n: number }).n, 0);
fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ ok: true, paidCalls: 0, syntheticMediaReusedForNavigationTest: true, root, production: complete }, null, 2));
closeDb();
console.log('PASS 28 distinct completed workbench identities prepared, no supplier calls');
