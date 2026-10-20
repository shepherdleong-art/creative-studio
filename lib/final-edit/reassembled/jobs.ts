import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { inputHashes, templateHashes } from '../../film-render/manifest.ts';
import { renderFilm } from '../../film-render/render.ts';
import { sha256 } from '../../film-render/files.ts';
import { FinalEditError } from '../errors.ts';
import { filmBinding } from './store.ts';
import { projectFilmTimeline } from './timeline.ts';
import { archivePriorFilm, deliveryNames, publishFilmPair, verifyDeliveryDirectory } from './delivery.ts';
import type { FilmRenderSnapshot, RegisteredCandidate } from './types.ts';
import type { RenderJobRef, VideoTimeline } from '../types.ts';
import { registerSingleArtifact } from '../project-artifacts.ts';
import { refreshFilmReview } from './review.ts';

export function enqueueFilmRender(db: Database.Database, input: { groupId: string; variantId: string; expectedGroupRevision: number; expectedVariantRevision: number }, mode: 'preview' | 'deliver'): RenderJobRef {
  return db.transaction(() => {
    const binding = filmBinding(db, input.groupId);
    if (!binding || binding.variantId !== input.variantId) throw new FinalEditError('film_not_found', '实拍成片归属不匹配', 404);
    const group = db.prepare('SELECT revision FROM final_edit_groups WHERE id=?').get(input.groupId) as { revision: number };
    const variant = db.prepare('SELECT revision,timelineJson FROM final_edit_variants WHERE id=?').get(input.variantId) as { revision: number; timelineJson: string };
    if (group.revision !== input.expectedGroupRevision || variant.revision !== input.expectedVariantRevision) throw new FinalEditError('revision_conflict', '草稿已变化，请刷新后重试', 409);
    verifyDeliveryDirectory(binding);
    const timeline = JSON.parse(variant.timelineJson) as VideoTimeline;
    const spec = projectFilmTimeline(JSON.parse(binding.specJson), timeline, JSON.parse(binding.candidatesJson) as RegisteredCandidate[]);
    const hashes = inputHashes(spec);
    const expected = JSON.parse(binding.inputHashesJson) as Record<string, string>;
    for (const [file, hash] of Object.entries(hashes)) if (expected[file] !== hash) throw new FinalEditError('film_input_changed', `已登记素材发生变化：${file}`, 409);
    const requestKey = `reassembled:${binding.id}:${mode}:${group.revision}:${variant.revision}`;
    const previous = db.prepare('SELECT id,status,inputSnapshotJson FROM final_edit_jobs WHERE requestKey=?').get(requestKey) as { id: string; status: string; inputSnapshotJson: string } | undefined;
    if (previous) return { id: previous.id, groupId: binding.groupId, variantId: binding.variantId, kind: 'render' as const, status: previous.status, target: JSON.parse(previous.inputSnapshotJson).exportTarget };
    // Only one delivery may be pending per film, so v3 cannot archive v2 before v2 is published.
    if (mode === 'deliver' && db.prepare(`SELECT 1 FROM final_edit_film_deliveries WHERE bindingId=? AND status='reserved'`).get(binding.id)) throw new FinalEditError('film_delivery_pending', '这条片子还有未完成的交付，请先重试或取消该任务', 409);
    const version = mode === 'deliver' ? (db.prepare('SELECT MAX(version) AS version FROM final_edit_film_deliveries WHERE bindingId=?').get(binding.id) as { version: number }).version + 1 : null;
    const id = randomUUID();
    const target = { taskName: spec.project.baseName, productCode: '', taskDate: '', ...deliveryNames(binding.baseName, version ?? binding.deliveryVersion), displayDirectory: binding.deliveryDir };
    const snapshot: FilmRenderSnapshot = { renderer: 'reassembled-film/1', bindingId: binding.id, mode,
      groupRevision: group.revision, variantRevision: variant.revision, variant: { id: binding.variantId, timeline },
      spec, inputHashes: hashes, templateHashes: templateHashes(spec), deliveryVersion: version,
      exportIdentity: { taskName: target.taskName, productCode: '', taskDate: '' }, exportTarget: target };
    db.prepare(`INSERT INTO final_edit_jobs (id,projectId,groupId,variantId,kind,status,phase,requestKey,inputSnapshotJson,createdAt) VALUES (?,?,?,?,?,'queued','queued',?,?,?)`).run(id, binding.projectId, binding.groupId, binding.variantId, mode === 'preview' ? 'film-preview' : 'render', requestKey, JSON.stringify(snapshot), new Date().toISOString());
    if (version !== null) db.prepare(`INSERT INTO final_edit_film_deliveries (bindingId,version,jobId,variantRevision,status,videoFilename,coverFilename) VALUES (?,?,?,?,'reserved',?,?)`).run(binding.id, version, id, variant.revision, target.videoFilename, target.coverFilename);
    return { id, groupId: binding.groupId, variantId: binding.variantId, kind: 'render' as const, status: 'queued', target };
  })();
}
export async function executeFilmJob(db: Database.Database, storageRoot: string, job: { id: string; groupId: string | null; inputSnapshotJson: string }, signal: AbortSignal) {
  const snapshot = JSON.parse(job.inputSnapshotJson) as FilmRenderSnapshot;
  const binding = filmBinding(db, job.groupId || '');
  if (!binding || binding.id !== snapshot.bindingId) throw new FinalEditError('film_not_found', '成片归属已失效', 409);
  const checkInputs = () => {
    if (JSON.stringify(inputHashes(snapshot.spec)) !== JSON.stringify(snapshot.inputHashes) || JSON.stringify(templateHashes(snapshot.spec)) !== JSON.stringify(snapshot.templateHashes)) throw new FinalEditError('film_snapshot_changed', '排队后素材或模板发生变化，已停止导出', 409);
  };
  signal.throwIfAborted(); checkInputs();
  const renderRoot = path.join(snapshot.spec.project.root, 'variants', snapshot.spec.project.variant, 'renders');
  let runDir = path.join(renderRoot, job.id);
  let rendered: Awaited<ReturnType<typeof renderFilm>> | undefined;
  if (fs.existsSync(path.join(runDir, 'render-manifest.json'))) {
    const candidate = JSON.parse(fs.readFileSync(path.join(runDir, 'render-manifest.json'), 'utf8')) as Awaited<ReturnType<typeof renderFilm>>;
    if (candidate.ok && candidate.checks.ok && candidate.specSha256 === sha256(path.join(runDir, 'spec.json')) &&
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'))) === JSON.stringify(snapshot.spec) &&
      sha256(candidate.outputs.video) === candidate.outputs.videoSha256 && sha256(candidate.outputs.cover) === candidate.outputs.coverSha256) rendered = candidate;
  }
  if (!rendered) {
    // A retry gets a fresh sibling without lengthening the job-sized name.
    // Appending a second UUID can exceed Windows media-library path limits.
    if (fs.existsSync(runDir)) runDir = path.join(renderRoot, randomUUID());
    rendered = await renderFilm({ spec: snapshot.spec, runDir, signal, onStage: event => {
      db.prepare('UPDATE final_edit_jobs SET phase=?,progress=? WHERE id=? AND status=\'running\'').run(event.stage, event.stage === 'verify' ? .85 : .25, job.id);
    } });
  }
  signal.throwIfAborted(); checkInputs();
  const relative = (file: string) => path.relative(storageRoot, file).split(path.sep).join('/');
  const output = { videoRelativePath: relative(rendered.outputs.video), coverRelativePath: relative(rendered.outputs.cover),
    videoFilename: snapshot.exportTarget.videoFilename, coverFilename: snapshot.exportTarget.coverFilename,
    displayDirectory: binding.deliveryDir, previewOnly: snapshot.mode === 'preview', archiveWarning: null as string | null };
  if (snapshot.mode === 'deliver') {
    const version = snapshot.deliveryVersion!;
    const reserved = db.prepare('SELECT jobId,status FROM final_edit_film_deliveries WHERE bindingId=? AND version=?').get(binding.id, version) as { jobId: string; status: string } | undefined;
    if (reserved?.jobId !== job.id || !['reserved', 'published'].includes(reserved.status)) throw new FinalEditError('film_reservation_lost', '交付版本预留已失效', 409);
    // A recovered older publication must never resurrect files already archived by a newer delivery.
    if (binding.deliveryVersion <= version) {
    const pair = publishFilmPair(binding, version, rendered.outputs.video, rendered.outputs.cover);
    db.transaction(() => {
      db.prepare(`UPDATE final_edit_film_deliveries SET status='published',videoSha256=?,coverSha256=? WHERE jobId=?`).run(pair.videoSha256, pair.coverSha256, job.id);
      db.prepare('UPDATE final_edit_film_bindings SET deliveryVersion=?,deliveredRevision=? WHERE id=? AND deliveryVersion<=?').run(version, snapshot.variantRevision, binding.id, version);
    })();
    output.archiveWarning = archivePriorFilm(db, binding, version);
    db.prepare('UPDATE final_edit_film_deliveries SET archiveWarning=? WHERE jobId=?').run(output.archiveWarning, job.id);
    refreshFilmReview(db, binding.id);
    }
  }
  db.transaction(() => {
    const current = db.prepare('SELECT revision FROM final_edit_variants WHERE id=?').get(binding.variantId) as { revision: number };
    if (current.revision === snapshot.variantRevision) {
      db.prepare('UPDATE final_edit_variants SET previewRelativePath=? WHERE id=?').run(output.videoRelativePath, binding.variantId);
      db.prepare('UPDATE final_edit_film_bindings SET previewRevision=? WHERE id=?').run(snapshot.variantRevision, binding.id);
    }
    if (snapshot.mode === 'deliver') {
      db.prepare('UPDATE final_edit_variants SET lastRenderedRevision=MAX(COALESCE(lastRenderedRevision,0),?) WHERE id=?').run(snapshot.variantRevision, binding.variantId);
      for (const [kind, filename, file, mime] of [
        ['final_video', output.videoFilename, output.videoRelativePath, 'video/mp4'],
        ['final_cover', output.coverFilename, output.coverRelativePath, 'image/jpeg'],
      ]) registerSingleArtifact(db, { id: `final-edit:${job.id}:${kind}`, projectId: binding.projectId, kind, displayName: filename, relativePath: file, mimeType: mime, sourceJobId: job.id, createdAt: new Date().toISOString() });
    }
    db.prepare(`UPDATE final_edit_jobs SET status='succeeded',phase='succeeded',progress=1,outputJson=?,finishedAt=? WHERE id=?`).run(JSON.stringify(output), new Date().toISOString(), job.id);
  })();
}
