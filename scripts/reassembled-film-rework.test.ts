// FILM_P2_FIXTURE=/isolated/reassembled-P1-.../fixture.json node scripts/reassembled-film-rework.test.ts
// Service/CAS acceptance, using synthesized completions, never starts supplier queues.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ReworkCommand } from '../lib/final-edit/reassembled/rework.ts';
import { applyFilmRework, readFilmRework } from '../lib/final-edit/reassembled/rework.ts';
import { createFinalEditWorkspace } from '../lib/final-edit/workspace.ts';
import { filmBinding } from '../lib/final-edit/reassembled/store.ts';
import { sha256 } from '../lib/film-render/files.ts';
import { enqueueFilmRender, executeFilmJob } from '../lib/final-edit/reassembled/jobs.ts';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import { isReassembledShotSet } from '../lib/reassembled-shot-guard.ts';
import { deleteShotSet } from '../lib/shot-set-service.ts';

const fixture = JSON.parse(fs.readFileSync(process.env.FILM_P2_FIXTURE!, 'utf8'));
assert.ok(fixture.root.includes('reassembled-P1-') && (fixture.root.includes('2026-10-19-p2') || (process.env.FILM_P2_CONTENT === '1' && fixture.root.includes('2026-10-19-complete'))), 'Only disposable acceptance fixtures');
process.env.CREATIVE_STUDIO_DATA_ROOT = fixture.root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.resolve('packaging');
const storage = path.join(fixture.root, 'storage');
const db = new Database(path.join(fixture.root, 'data/workbench.db'));
db.pragma('foreign_keys = ON');
initFinalEditSchema(db);
const forbidden = async (): Promise<never> => { throw new Error('Paid provider forbidden'); };
const workspace = createFinalEditWorkspace({ db, storageRoot: storage, probeVideo: forbidden, analyzeVideo: forbidden, synthesize: forbidden });
const binding = filmBinding(db, fixture.groupId)!;
// Exercise protection of actual saved edits, rather than comparing two absent
// filmContent values. Keep combined acceptance's existing manual edits intact.
const initialWorkspace = workspace.load(fixture.groupId);
if (!initialWorkspace.variants[0].timeline.filmContent) {
  const content = structuredClone(initialWorkspace.reassembled!.content);
  if (content.decoration.template === 'classic') content.decoration.cover.title[0] = '人工标题必须保留';
  else content.decoration.packaging.varsOverrides.title = '人工标题必须保留';
  content.subtitles[0].text = '人工字幕必须保留';
  content.music.gainDb -= 2;
  workspace.apply({ scope: 'variant', type: 'set_film_content', variantId: binding.variantId,
    expectedRevision: initialWorkspace.variants[0].revision, content });
}
const original = workspace.load(fixture.groupId);
assert.ok(original.variants[0].timeline.filmContent, 'Rework acceptance requires saved manual content');
const clipId = original.variants[0].timeline.clips[0].id;
const otherClip = original.variants[0].timeline.clips[1].id;
const oldFiles = fs.readdirSync(fixture.delivery).filter((s: string) => /\.(mp4|jpg)$/.test(s)).map((name: string) => [name, sha256(path.join(fixture.delivery, name))]);
const initialShots = db.prepare('SELECT * FROM shots WHERE shotSetId=? ORDER BY id').all(fixture.shotSetId);
db.prepare("UPDATE providers SET apiKey='local-fixture-only',model='synthetic-image',enabled=1 WHERE id='p1-fixture'").run();
db.prepare("UPDATE video_providers SET apiKey='local-fixture-only',baseUrl='http://127.0.0.1:1',defaultModel='synthetic-video',enabled=1 WHERE id='p1-video'").run();
const view = () => readFilmRework(db, fixture.groupId, clipId);
const command = (input: Omit<ReworkCommand, 'requestId' | 'expectedRevision'>): ReworkCommand => ({ ...input, requestId: randomUUID(), expectedRevision: view().revision });
const apply = (input: ReworkCommand, actor: 'human' | 'agent' = 'human') => applyFilmRework(db, storage, fixture.groupId, clipId, input, actor);
const imageCommand = () => command({ type: 'generate_image', providerId: 'p1-fixture', model: 'synthetic-image', prompt: '仅修复本镜头背景，保留人工描述', inputImageId: view().sourceImageId, referenceImageIds: [view().currentImageId], size: '1024x1024', quality: 'standard' });
const request = imageCommand();
const first = await apply(request, 'agent');
assert.deepEqual(await apply(request, 'agent'), first, 'idempotent request creates only one task');
await assert.rejects(apply({ ...request, prompt: 'changed' }, 'agent'), { code: 'request_conflict' });
await assert.rejects(apply({ ...imageCommand(), expectedRevision: 0 }), { code: 'revision_conflict' });
await assert.rejects(apply({ ...imageCommand(), model: 'old model' }), { code: 'revision_conflict' });
assert.equal((db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n, 1);
function completeImage(jobId: string) {
  const asset = db.prepare('SELECT * FROM image_assets WHERE id=?').get(view().sourceImageId) as { path: string };
  const id = randomUUID();
  const file = path.join(storage, `${id}.jpg`); fs.copyFileSync(asset.path, file);
  db.prepare("INSERT INTO image_assets(id,projectId,role,filename,path,mimeType) VALUES (?,?,'output',?,?,'image/jpeg')").run(id, binding.projectId, `${id}.jpg`, file);
  db.prepare("UPDATE jobs SET status='succeeded',outputImageId=? WHERE id=?").run(id, jobId);
  return id;
}
const firstImage = completeImage(first.jobId!);
await assert.rejects(apply(command({ type: 'select_image', imageId: firstImage }), 'agent'), { code: 'film_manual_selection_required' });
const late = await apply(imageCommand(), 'agent');
await apply(command({ type: 'select_image', imageId: firstImage }));
const lateImage = completeImage(late.jobId!);
assert.equal(view().currentImageId, firstImage, 'late result cannot change explicit selection');
assert.ok(view().imageJobs.some(j => j.outputImageId === lateImage), 'late result remains a candidate');
const concurrent = imageCommand();
const outcomes = await Promise.allSettled([apply(concurrent), apply({ ...concurrent, requestId: randomUUID() })]);
assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
const videoRequest = command({ type: 'generate_video', providerId: 'p1-video', model: 'synthetic-video', prompt: '保留明确运镜参数', imageId: firstImage, durationSec: 8 });
await assert.rejects(apply({ ...videoRequest, imageId: view().sourceImageId }), { code: 'revision_conflict' });
const video = await apply(videoRequest);
const candidate = JSON.parse(binding.candidatesJson).find((c: { clipId: string }) => c.clipId === clipId);
const generatedFile = path.join(storage, 'p2-generated.mp4'); fs.copyFileSync(path.join(storage, binding.managedRootRelative, candidate.file), generatedFile);
db.prepare("UPDATE video_jobs SET status='succeeded',localVideoPath=?,filename='p2-generated.mp4' WHERE id=?").run(generatedFile, video.jobId);
const register = () => command({ type: 'register_video', videoJobId: video.jobId, approvedRangeSec: [0, 8] });
const foreign = JSON.parse(binding.candidatesJson).find((c: { clipId: string }) => c.clipId === otherClip);
await assert.rejects(apply({ ...register(), videoJobId: foreign.videoJobId }), /该镜头/);
await assert.rejects(apply({ ...register(), approvedRangeSec: [0, 99] }), /实际视频时长/);
await assert.rejects(apply({ ...register(), approvedRangeSec: [0, 0.1] }));
const racing = apply(register()); // Stops at asynchronous probe.
await apply(command({ type: 'select_image', imageId: lateImage }));
await assert.rejects(racing, { code: 'revision_conflict' });
assert.equal(filmBinding(db, fixture.groupId)!.candidatesJson, binding.candidatesJson);
const admitted = register();
await apply(admitted, 'agent');
assert.deepEqual(await apply(admitted, 'agent'), { revision: admitted.expectedRevision + 1, jobId: video.jobId });
assert.deepEqual(workspace.load(fixture.groupId).variants, original.variants, 'candidate registration never edits timeline');
assert.equal(filmBinding(db, fixture.groupId)!.specJson, binding.specJson);
const after = workspace.load(fixture.groupId);
const registered = JSON.parse(filmBinding(db, fixture.groupId)!.candidatesJson).find((c: { videoJobId: string }) => c.videoJobId === video.jobId);
assert.ok(after.assets.some(a => a.videoJobId === video.jobId), 'new candidate appears in fifth-step asset pool');
const clip = after.variants[0].timeline.clips.find(c => c.id === clipId)!;
workspace.apply({ scope: 'variant', variantId: binding.variantId, expectedRevision: after.variants[0].revision, type: 'replace_clip', clipId, videoJobId: video.jobId!, sourceFingerprint: registered.fingerprint, sourceInFrame: 0, sourceOutFrame: clip.sourceOutFrame - clip.sourceInFrame });
assert.throws(() => workspace.apply({ scope: 'variant', variantId: binding.variantId, expectedRevision: after.variants[0].revision, type: 'reorder_clips', orderedClipIds: [] }), { code: 'revision_conflict' });
const final = workspace.load(fixture.groupId);
assert.deepEqual(final.variants[0].timeline.filmContent, original.variants[0].timeline.filmContent, 'Upstream rework and local replacement preserve manually saved film content');
assert.deepEqual(final.variants[0].timeline.clips.filter(c => c.id !== clipId), original.variants[0].timeline.clips.filter(c => c.id !== clipId));
for (const key of ['script', 'subtitleCues', 'packaging', 'textStyles', 'coverTitle'] as const) assert.deepEqual(final[key], original[key]);
const otherShots = db.prepare('SELECT * FROM shots WHERE shotSetId=? AND id!=? ORDER BY id').all(binding.shotSetId, view().shotId);
assert.deepEqual(otherShots, (initialShots as Array<{ id: string }>).filter(s => s.id !== view().shotId));
assert.ok(isReassembledShotSet(db, binding.shotSetId));
assert.equal(deleteShotSet(db, binding.shotSetId).ok, false);
if (process.env.FILM_P2_RENDER === '1') {
  const job = enqueueFilmRender(db, { groupId: binding.groupId, variantId: binding.variantId, expectedGroupRevision: final.revision, expectedVariantRevision: final.variants[0].revision }, 'preview');
  db.prepare("UPDATE final_edit_jobs SET status='running' WHERE id=?").run(job.id);
  const row = db.prepare('SELECT id,groupId,inputSnapshotJson FROM final_edit_jobs WHERE id=?').get(job.id) as { id: string; groupId: string; inputSnapshotJson: string };
  await executeFilmJob(db, storage, row, new AbortController().signal);
  assert.equal((db.prepare('SELECT status FROM final_edit_jobs WHERE id=?').get(job.id) as { status: string }).status, 'succeeded');
}
for (const [name, hash] of oldFiles) assert.equal(sha256(path.join(fixture.delivery, name)), hash);
// A resumed agent can replay an old receipt after later human edits and a DB
// reopen. It must return the receipt without restoring its old shot/content state.
const beforeRestart = view();
const stateTables = ['shots', 'jobs', 'video_jobs', 'final_edit_film_reworks', 'final_edit_film_shots', 'final_edit_film_bindings', 'final_edit_variants'];
const snapshot = (connection: Database.Database) => stateTables.map(table => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const savedState = snapshot(db);
db.close();
const reopened = new Database(path.join(fixture.root, 'data/workbench.db'));
reopened.pragma('foreign_keys = ON');
try {
  assert.deepEqual(await applyFilmRework(reopened, storage, fixture.groupId, clipId, request, 'agent'), first);
  assert.deepEqual(await applyFilmRework(reopened, storage, fixture.groupId, clipId, admitted, 'agent'), { revision: admitted.expectedRevision + 1, jobId: video.jobId });
  assert.deepEqual(snapshot(reopened), savedState, 'Replayed receipts after restart preserve all later edits and create no tasks');
  assert.deepEqual(readFilmRework(reopened, fixture.groupId, clipId), beforeRestart, 'Provenance and shot state survive restart');
} finally { reopened.close(); }
const result = { ok: true, manualContentPreserved: !!original.variants[0].timeline.filmContent, restartReplayPreserved: true, clipId, shotId: beforeRestart.shotId, imageJobId: first.jobId, videoJobId: video.jobId, revision: beforeRestart.revision, oldFiles, checks: ['CAS', 'idempotence', 'late-result', 'agent-candidate-only', 'concurrency', 'cross-shot-denied', 'range-gate', 'async-race', 'frozen-spec', 'other-shots-unchanged', 'script-packaging-unchanged', 'old-delivery-unchanged', 'restart-replay-preserves-edits'], rendered: process.env.FILM_P2_RENDER === '1' };
fs.writeFileSync(path.join(fixture.root, 'p2-service-result.json'), JSON.stringify(result, null, 2));
console.log('PASS P2 service isolation and manual protection', result);
