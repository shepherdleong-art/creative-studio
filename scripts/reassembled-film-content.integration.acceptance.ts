// FILM_CONTENT_FIXTURE must be a fresh isolated fixture from reassembled-film.integration.acceptance.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createFinalEditWorkspace } from '../lib/final-edit/workspace.ts';
import { filmBinding } from '../lib/final-edit/reassembled/store.ts';
import { enqueueFilmRender, executeFilmJob } from '../lib/final-edit/reassembled/jobs.ts';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_CONTENT_FIXTURE!, 'utf8'));
assert.ok(fixture.root.includes('2026-10-19-complete') && fixture.root.includes('reassembled-P1-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = fixture.root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const db = new Database(path.join(fixture.root, 'data/workbench.db'));
const storageRoot = path.join(fixture.root, 'storage');
const forbidden = async (): Promise<never> => { throw new Error('Provider calls forbidden in this test'); };
const workspace = createFinalEditWorkspace({ db, storageRoot, probeVideo: forbidden, analyzeVideo: forbidden, synthesize: forbidden });
const load = () => workspace.load(fixture.groupId);
const before = load(), binding = filmBinding(db, fixture.groupId)!;
const variant = before.variants[0];
const content = structuredClone(before.reassembled!.content);
if (content.decoration.template === 'classic') {
  content.decoration.cover.title = ['人工修改保留', '本条成片编辑验收'];
  if (content.decoration.callouts[0]) content.decoration.callouts[0].title = '人工修订标注';
} else {
  content.decoration.packaging.varsOverrides.title = '人工修改保留';
  content.decoration.packaging.varsOverrides.subtitle = '本条成片编辑验收';
  content.decoration.packaging.layouts = { [content.decoration.template]: { cover: { title: { x: 45, y: 30, scale: .8 } } } };
}
content.subtitles[0].text = '本地人工字幕';
content.music.gainDb -= 2;
const command = { scope: 'variant' as const, type: 'set_film_content' as const, variantId: variant.id, expectedRevision: variant.revision, content };
workspace.apply(command);
assert.deepEqual(load().variants[0].timeline.clips, variant.timeline.clips);
assert.equal(load().subtitleCues[0].text, '本地人工字幕');
assert.throws(() => workspace.apply(command), { code: 'revision_conflict' });
const edited = load();
const invalid = structuredClone(content); invalid.music.gainDb = 999;
assert.throws(() => workspace.apply({ ...command, expectedRevision: edited.variants[0].revision, content: invalid }), { code: 'film_content_invalid' });
assert.equal(load().variants[0].revision, edited.variants[0].revision);
workspace.apply({ scope: 'variant', type: 'restore_revision', variantId: variant.id, expectedRevision: edited.variants[0].revision, revision: variant.revision });
assert.deepEqual(load().reassembled!.content, before.reassembled!.content);
assert.deepEqual(load().variants[0].timeline, variant.timeline);
workspace.apply({ scope: 'variant', type: 'restore_revision', variantId: variant.id, expectedRevision: load().variants[0].revision, revision: edited.variants[0].revision });
assert.deepEqual(load().reassembled!.content, content);
assert.equal(filmBinding(db, fixture.groupId)!.specJson, binding.specJson);
assert.equal(filmBinding(db, fixture.groupId)!.inputHashesJson, binding.inputHashesJson);
assert.deepEqual(load().script, before.script);
const current = load();
const job = enqueueFilmRender(db, { groupId: current.id, variantId: variant.id, expectedGroupRevision: current.revision, expectedVariantRevision: current.variants[0].revision }, 'preview');
const snapshot = db.prepare('SELECT inputSnapshotJson FROM final_edit_jobs WHERE id=?').get(job.id) as { inputSnapshotJson: string };
const frozen = JSON.parse(snapshot.inputSnapshotJson);
assert.equal(frozen.spec.template.id === 'classic' ? frozen.spec.classic.cover.title[0] : frozen.spec.packaging.varsOverrides.title, '人工修改保留');
assert.equal(frozen.spec.subtitles[0].text, '本地人工字幕');
assert.equal(frozen.spec.audio.music.gainDb, content.music.gainDb);
if (process.env.FILM_CONTENT_RENDER === '1') {
  db.prepare("UPDATE final_edit_jobs SET status='running' WHERE id=?").run(job.id);
  await executeFilmJob(db, storageRoot, { id: job.id, groupId: current.id, ...snapshot }, new AbortController().signal);
  const result = db.prepare('SELECT status,outputJson FROM final_edit_jobs WHERE id=?').get(job.id) as { status: string; outputJson: string };
  assert.equal(result.status, 'succeeded');
  fs.writeFileSync(path.join(fixture.root, 'content-service-result.json'), JSON.stringify({ ok: true, fixture, revision: current.variants[0].revision, output: JSON.parse(result.outputJson) }, null, 2));
}
db.close();
console.log('PASS persisted content, CAS, invalid input atomicity, timeline/source/script isolation, restore/redo and immutable render snapshot');
