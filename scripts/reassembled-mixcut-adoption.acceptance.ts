// FILM_EDITOR_DB points to an imported-film fixture. Database writes use a temporary backup;
// the usual immutable narration cache may be populated beside fixture media.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { adoptFilmIntoMixcut } from '../lib/final-edit/reassembled/adopt.ts';
import { createFinalEditWorkspace } from '../lib/final-edit/workspace.ts';
import { filmBinding } from '../lib/final-edit/reassembled/store.ts';
import { readPcmWav } from '../lib/film-render/wav.ts';
import { reviewHtml, refreshFilmReview, refreshMixcutReview } from '../lib/final-edit/reassembled/review.ts';
import { verifyDeliveryDirectory } from '../lib/final-edit/reassembled/delivery.ts';
import type { FilmBinding } from '../lib/final-edit/reassembled/types.ts';
import { requiresReassembledUpstreamRework } from '../lib/reassembled-shot-guard.ts';

assert.ok(process.env.FILM_EDITOR_DB, 'Set FILM_EDITOR_DB to a fixture database; source is opened read-only.');
const source = new Database(process.env.FILM_EDITOR_DB!, { readonly: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixcut-adoption-'));
await source.backup(path.join(root, 'test.db'));
const db = new Database(path.join(root, 'test.db'));
source.close();
const storageRoot = process.env.FILM_EDITOR_STORAGE || path.resolve(path.dirname(process.env.FILM_EDITOR_DB!), '..', 'storage');
process.env.CREATIVE_STUDIO_DATA_ROOT = path.dirname(storageRoot);
const classic = process.env.FILM_EDITOR_TEMPLATE === 'classic';
// Reconstruct an imported classic in the disposable DB from its audit snapshot.
// This also lets an already-adopted real project serve as a read-only media fixture.
if (classic) {
  const row = (db.prepare('SELECT * FROM final_edit_film_bindings').all() as FilmBinding[]).find(item => JSON.parse(item.specJson).template.id === 'classic');
  if (row) {
    const audit = db.prepare("SELECT commandJson FROM final_edit_revisions WHERE scopeId=? AND json_extract(commandJson,'$.type')='adopt_into_mixcut' ORDER BY revision DESC LIMIT 1").get(row.variantId) as { commandJson: string } | undefined;
    if (audit) {
      const original = JSON.parse(audit.commandJson);
      const timeline = JSON.parse(original.originalVariant.timelineJson);
      delete timeline.importedFilmEditor;
      delete timeline.filmContent;
      db.prepare('UPDATE final_edit_variants SET timelineJson=? WHERE id=?').run(JSON.stringify(timeline), row.variantId);
    }
  }
}
const binding = (db.prepare('SELECT * FROM final_edit_film_bindings').all() as FilmBinding[]).find(row => {
  const variant = db.prepare('SELECT timelineJson FROM final_edit_variants WHERE id=?').get(row.variantId) as { timelineJson: string };
  return (JSON.parse(row.specJson).template.id === 'classic') === classic && !JSON.parse(variant.timelineJson).importedFilmEditor;
})!;
assert.ok(binding, 'Fixture needs a film matching FILM_EDITOR_TEMPLATE.');
const forbidden = async (): Promise<never> => { throw new Error('External generation is forbidden'); };
const workspace = createFinalEditWorkspace({ db, storageRoot, probeVideo: forbidden, analyzeVideo: forbidden, synthesize: forbidden });
const before = workspace.load(binding.groupId);
assert.equal(requiresReassembledUpstreamRework(db, binding.shotSetId), true);
if (classic) {
  assert.throws(() => adoptFilmIntoMixcut(db, storageRoot, binding.groupId), { code: 'classic_template_required' });
  assert.throws(() => adoptFilmIntoMixcut(db, storageRoot, binding.groupId, { template: 'overlay-minimal', expectedRevision: -1, expectedGroupRevision: before.revision }), { code: 'revision_conflict' });
}
adoptFilmIntoMixcut(db, storageRoot, binding.groupId, classic ? { template: 'overlay-minimal', expectedRevision: before.variants[0].revision, expectedGroupRevision: before.revision } : undefined);
let group = workspace.load(binding.groupId);
assert.equal(group.reassembled, undefined);
assert.equal(filmBinding(db, binding.groupId), undefined);
assert.deepEqual(group.variants[0].timeline.clips, before.variants[0].timeline.clips);
assert.deepEqual(group.subtitleCues, before.subtitleCues);
const decoration = before.reassembled!.content.decoration;
if (decoration.template === 'classic') {
  assert.equal(group.packaging.enabled, true);
  assert.equal(group.packaging.template, 'overlay-minimal');
  assert.equal(group.packaging.varsOverrides.title, decoration.cover.title[0]);
  assert.ok(group.packaging.pointCues?.length);
} else assert.deepEqual(group.packaging.varsOverrides, decoration.packaging.varsOverrides);
assert.equal(requiresReassembledUpstreamRework(db, binding.shotSetId), false);
assert.ok(group.variants[0].bgm.trackId);
assert.ok(group.variants[0].cover.sourceUrl?.includes('/cover-candidates/'), 'Imported still cover must load in the native player');
const audio = db.prepare('SELECT narrationAudioPath FROM final_edit_groups WHERE id=?').get(group.id) as { narrationAudioPath: string };
// No source media are rewritten.
const wav = readPcmWav(path.resolve(storageRoot, audio.narrationAudioPath));
assert.ok(wav.sampleFrames > 0);
const revision = group.variants[0].revision;
adoptFilmIntoMixcut(db, storageRoot, binding.groupId);
assert.equal(workspace.load(binding.groupId).variants[0].revision, revision);
const changeSubtitle = { scope: 'group' as const, groupId: group.id, expectedRevision: group.revision, type: 'set_subtitle_cue_text' as const, cueId: group.subtitleCues[0].id, text: '原精剪字幕保存验收' };
workspace.apply(changeSubtitle);
assert.throws(() => workspace.apply(changeSubtitle), { code: 'revision_conflict' });
group = workspace.load(group.id);
assert.equal(group.subtitleCues[0].text, changeSubtitle.text);
workspace.apply({ scope: 'group', groupId: group.id, expectedRevision: group.revision, type: 'set_packaging_config', config: { ...group.packaging, varsOverrides: { ...group.packaging.varsOverrides, title: '原精剪包装验收' } } });
group = workspace.load(group.id);
assert.equal(group.packaging.varsOverrides.title, '原精剪包装验收');
workspace.apply({ scope: 'variant', variantId: binding.variantId, expectedRevision: group.variants[0].revision, type: 'set_bgm_gain', gainDb: -18 });
group = workspace.load(group.id);
assert.equal(group.variants[0].bgm.gainDb, -18);
workspace.apply({ scope: 'variant', variantId: binding.variantId, expectedRevision: group.variants[0].revision, type: 'set_framing', clipId: group.variants[0].timeline.clips[0].id, scale: 1.1, offsetX: 0, offsetY: 0 });
group = workspace.load(group.id);
assert.equal(group.variants[0].timeline.clips[0].framing.scale, 1.1);
assert.equal((db.prepare('SELECT specJson FROM final_edit_film_bindings WHERE id=?').get(binding.id) as FilmBinding).specJson, binding.specJson);

const deliveryDir = path.join(root, 'delivery');
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
fs.mkdirSync(deliveryDir);
db.prepare('UPDATE final_edit_film_bindings SET deliveryDir=? WHERE projectId=?').run(deliveryDir, binding.projectId);
const peers = db.prepare('SELECT * FROM final_edit_film_bindings WHERE projectId=?').all(binding.projectId) as FilmBinding[];
for (const peer of peers) verifyDeliveryDirectory(peer, true);
fs.mkdirSync(path.join(root, 'storage/run'), { recursive: true });
process.env.CREATIVE_STUDIO_DESKTOP = '1';
process.env.CREATIVE_STUDIO_INSTANCE_ID = 'isolated-editor-test';
fs.writeFileSync(path.join(root, 'storage/run/electron-service.json'), JSON.stringify({ instanceId: process.env.CREATIVE_STUDIO_INSTANCE_ID, origin: 'http://127.0.0.1:12345' }));
const html = reviewHtml(db, binding.id, true);
assert.equal((html.match(/<video /g) || []).length, peers.length);
assert.ok(html.includes('preload="none"'));
const output = refreshFilmReview(db, binding.id);
assert.equal(refreshFilmReview(db, peers.at(-1)!.id), output);
assert.equal(fs.readdirSync(deliveryDir).filter(name => name.endsWith('.html')).length, 1);
// The native packaging worker publishes a separate child job. Review must follow that
// child while retaining the parent's immutable revision and cover.
const files = JSON.parse(binding.manifestJson).initialFiles as { video: string; cover: string };
const videoRelative = `${binding.managedRootRelative}/${files.video}`;
const coverRelative = `${binding.managedRootRelative}/${files.cover}`;
const insertJob = db.prepare(`INSERT INTO final_edit_jobs (id,projectId,groupId,variantId,kind,status,phase,requestKey,inputSnapshotJson,outputJson,createdAt) VALUES (?,?,?,?,?,'succeeded','succeeded',?,?,?,?)`);
insertJob.run('test-native-render', binding.projectId, group.id, binding.variantId, 'render', 'test-native-render',
  JSON.stringify({ variant: group.variants[0], variantRevision: group.variants[0].revision, groupRevision: group.revision }),
  JSON.stringify({ packagingDeferred: true, publishedCoverRelativePath: coverRelative }), '2999-01-01T00:00:00Z');
insertJob.run('test-native-packaging', binding.projectId, group.id, binding.variantId, 'packaging', 'test-native-packaging', '{}',
  JSON.stringify({ sourceRenderJobId: 'test-native-render', publishedVideoRelativePath: videoRelative }), '2999-01-01T00:00:01Z');
refreshMixcutReview(db, group.id);
const updatedHtml = fs.readFileSync(output, 'utf8');
assert.ok(updatedHtml.includes(`精剪版本 ${group.variants[0].revision}`));
assert.deepEqual(fs.readFileSync(path.join(deliveryDir, path.basename(videoRelative))), fs.readFileSync(path.join(storageRoot, videoRelative)));
assert.deepEqual(fs.readFileSync(path.join(deliveryDir, path.basename(coverRelative))), fs.readFileSync(path.join(storageRoot, coverRelative)));
db.prepare('UPDATE final_edit_film_bindings SET deliveryDir=? WHERE id=?').run(path.join(root, 'offline'), binding.id);
assert.doesNotThrow(() => refreshMixcutReview(db, group.id));
assert.ok(JSON.parse((db.prepare('SELECT outputJson FROM final_edit_jobs WHERE id=?').get('test-native-packaging') as { outputJson: string }).outputJson).reviewWarning);
console.log('PASS: adoption, idempotency, native editing/cover, revision conflict, one review, packaged export refresh, offline delivery preserves successful export.');
db.close();
