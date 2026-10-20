import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { currentFilmContent, filmPackaging, filmSubtitleCues } from './editor.ts';
import { filmPreviewAudio } from './preview-audio.ts';
import { projectFile } from '../../film-render/files.ts';
import type { FilmBinding } from './types.ts';
import type { RenderSpec } from '../../film-render/types.ts';
import type { VideoTimeline } from '../types.ts';
import { FinalEditError } from '../errors.ts';

/** One-way, idempotent adoption. Keeps the original binding/deliveries and a full before snapshot. */
export function adoptFilmIntoMixcut(db: Database.Database, storageRoot: string, groupId: string): void {
  const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE groupId=?').get(groupId) as FilmBinding | undefined;
  if (!binding) return;
  const group = db.prepare('SELECT * FROM final_edit_groups WHERE id=?').get(groupId) as Record<string, unknown>;
  const variant = db.prepare('SELECT * FROM final_edit_variants WHERE id=?').get(binding.variantId) as Record<string, unknown>;
  const timeline = JSON.parse(String(variant.timelineJson)) as VideoTimeline;
  if (timeline.importedFilmEditor === 'mixcut') return;
  if (db.prepare("SELECT 1 FROM final_edit_jobs WHERE groupId=? AND status IN ('running','queued')").get(groupId)) {
    throw new FinalEditError('film_job_pending', '请等待当前成片任务完成后再打开精剪', 409);
  }
  const spec = JSON.parse(binding.specJson) as RenderSpec;
  const content = currentFilmContent(spec, timeline);
  if (content.decoration.template === 'classic') {
    throw new FinalEditError('classic_edit_not_supported', '此历史成片使用 classic 包装，尚不能无损转为四模板精剪草稿', 409);
  }
  const narration = filmPreviewAudio(db, groupId);
  if (!narration) throw new FinalEditError('audio_file_missing', '原片配音缺失');
  const musicPath = projectFile(spec.project.root, spec.audio.music.file);
  const fingerprint = createHash('sha256').update(fs.readFileSync(musicPath)).digest('hex');
  const trackId = `film-${fingerprint}`;
  const bgm = { trackId, gainDb: content.music.gainDb, loop: true, fadeInSec: content.music.fadeInSec, fadeOutSec: content.music.fadeOutSec };
  const cues = filmSubtitleCues(content);
  const packaging = filmPackaging(content);
  const stamp = new Date().toISOString();
  const nextTimeline: VideoTimeline = { ...timeline, importedFilmEditor: 'mixcut' };
  delete nextTimeline.filmContent;
  // Full imported state is retained in an audit revision, in addition to immutable binding.specJson.
  db.transaction(() => {
    const current = db.prepare('SELECT revision FROM final_edit_variants WHERE id=?').get(binding.variantId) as { revision: number };
    const currentGroup = db.prepare('SELECT revision FROM final_edit_groups WHERE id=?').get(groupId) as { revision: number };
    if (current.revision !== Number(variant.revision) || currentGroup.revision !== Number(group.revision)) throw new FinalEditError('revision_conflict', '草稿已变化，请重新打开', 409);
    db.prepare(`INSERT OR IGNORE INTO final_edit_bgm_tracks (id,relativePath,fileFingerprint,durationUs,format,status,scannedAt) VALUES (?,?,?,?,?,'ready',?)`)
      .run(trackId, path.relative(storageRoot, musicPath).split(path.sep).join('/'), fingerprint, Math.round(spec.canvas.frames / 24 * 1e6), path.extname(musicPath).slice(1), stamp);
    const actualTrack = db.prepare('SELECT id FROM final_edit_bgm_tracks WHERE fileFingerprint=?').get(fingerprint) as { id: string };
    bgm.trackId = actualTrack.id;
    const revision = current.revision + 1;
    db.prepare(`INSERT INTO final_edit_revisions (scopeKind,scopeId,revision,stateJson,commandJson,createdAt) VALUES ('variant',?,?,?,?,?)`)
      .run(binding.variantId, revision, JSON.stringify({ timeline: nextTimeline, bgm, cover: JSON.parse(String(variant.coverJson)), issues: [] }),
        JSON.stringify({ type: 'adopt_into_mixcut', originalGroup: group, originalVariant: variant }), stamp);
    db.prepare(`UPDATE final_edit_variants SET timelineJson=?,bgmJson=?,revision=?,updatedAt=? WHERE id=?`)
      .run(JSON.stringify(nextTimeline), JSON.stringify(bgm), revision, stamp, binding.variantId);
    db.prepare(`UPDATE final_edit_groups SET narrationAudioPath=?,narrationDurationUs=?,subtitleStateJson=?,packagingJson=?,coverTitleJson=?,narrationConfigJson=?,revision=revision+1,updatedAt=? WHERE id=?`)
      .run(narration, Math.round(timeline.bodyFrames / 24 * 1e6), JSON.stringify(cues), JSON.stringify(packaging),
        JSON.stringify({ enabled: false, primary: { id: 'primary', text: packaging.varsOverrides.title || '', textSource: 'manual' }, secondary: { id: 'secondary', text: packaging.varsOverrides.subtitle || '', textSource: 'manual' } }),
        JSON.stringify({ providerId: '', voice: '原片配音', speed: 1, playbackRate: 1, gainDb: 0 }), stamp, groupId);
  })();
}
