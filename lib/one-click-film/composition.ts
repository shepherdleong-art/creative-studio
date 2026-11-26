import { countFilmFrames } from './frames.ts';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { registerManagedFile } from '../media-core/access-context.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { assertNoStorageSymlink } from '../media-core/storage-path.ts';
import { OneClickFilmError } from './errors.ts';
import { videoJobFileUrl } from './generation.ts';
import { candidateFits } from './rework.ts';
import type { OneClickFilmRun } from './store.ts';

export function filmStoragePath(value: string): string {
  const root = path.resolve(dataRoot(), 'storage');
  // Older jobs use a POSIX /storage prefix even under Windows.
  const relative = value.replace(/^[/\\]?storage[/\\]/, '');
  return assertNoStorageSymlink(root, relative, { allowAbsolute: true });
}

export function bodyFrame(us: number): number {
  return Math.round(us * FINAL_EDIT_FPS / 1_000_000);
}

export interface FilmBody {
  entryId: string;
  entryCode: string;
  jobId: string;
  originalVideoJobId: string;
  originalPath: string;
  frames: number;
  reviewDurationUs?: number;
  draft: boolean;
  snapshot: { analysisId?: string; productName?: string; soundMode?: 'native' | 'tts' | 'none'; narration?: string; narrationPath?: string; scriptRevision?: number; promptText?: string };
  edits: Array<{ id: string; videoJobId: string; file: string; start: number; end: number; trim: number; whole: boolean }>;
  signature: string;
  approved: boolean;
  hdApproved: boolean;
}

export function readFilmBody(db: Database.Database, run: OneClickFilmRun, entryCode: string): FilmBody | null {
  const row = db.prepare(`
    SELECT r.id, r.entryId, r.durationUs, r.approvedAt, r.hdApprovedSignature, v.videoJobId, v.scriptSnapshotJson,
      j.localVideoPath, j.filmGenerationStage FROM one_click_film_reviews r
    JOIN one_click_film_video_jobs v ON v.id=r.videoJobId JOIN video_jobs j ON j.id=v.videoJobId
    JOIN one_click_film_entries e ON e.id=r.entryId
    WHERE r.runId=? AND r.entryCode=? AND r.supersededAt IS NULL AND e.retired=0 AND j.status='succeeded'
  `).get(run.id, entryCode) as {
    id: string; entryId: string; durationUs: number; approvedAt: string | null; hdApprovedSignature: string | null;
    videoJobId: string; scriptSnapshotJson: string; localVideoPath: string; filmGenerationStage: string | null;
  } | undefined;
  if (!row?.localVideoPath) return null;
  const edits = (db.prepare(`
    SELECT id, videoJobId, localVideoPath, replaceStartUs, replaceEndUs, trimStartUs, shotId FROM one_click_film_candidates
    WHERE runId=? AND reviewJobId=? AND adoptedAt IS NOT NULL ORDER BY replaceStartUs,shotId
  `).all(run.id, row.id) as Array<{
    id: string; videoJobId: string; localVideoPath: string; replaceStartUs: number; replaceEndUs: number;
    trimStartUs: number; shotId: string;
  }>).map((edit) => ({
    id: edit.id, videoJobId: edit.videoJobId, file: filmStoragePath(edit.localVideoPath),
    start: bodyFrame(edit.replaceStartUs), end: bodyFrame(edit.replaceEndUs), trim: bodyFrame(edit.trimStartUs),
    whole: edit.shotId === 'whole',
  }));
  const snapshot = JSON.parse(row.scriptSnapshotJson) as FilmBody['snapshot'];
  const signature = createHash('sha256').update(JSON.stringify([row.videoJobId, row.durationUs, edits])).digest('hex');
  return {
    entryId: row.entryId, entryCode, jobId: row.id, originalVideoJobId: row.videoJobId,
    originalPath: filmStoragePath(row.localVideoPath), frames: bodyFrame(row.durationUs), reviewDurationUs: row.durationUs,
    approved: Boolean(row.approvedAt), snapshot, edits, signature,
    draft: row.filmGenerationStage === 'draft', hdApproved: row.hdApprovedSignature === signature,
  };
}

// Earlier reviews stored the container duration, including any extra audio at the end.
// Keep the stored edit/approval signature, but resolve playback against the original pictures.
const originalLengths = new Map<string, Promise<number>>();

async function playableFrames(file: string, reviewDurationUs: number, signal?: AbortSignal): Promise<number> {
  const requested = bodyFrame(reviewDurationUs);
  const media = await probeVideoMedia(file, { signal });
  signal?.throwIfAborted();
  if (!media.hasAudio || !media.videoDurationUs || media.durationUs !== reviewDurationUs
      || bodyFrame(media.videoDurationUs) >= requested) return requested;
  const decoded = await countFilmFrames(file, signal);
  // A truncated or undecodable source must still fail validation.
  return decoded > 0 && decoded === bodyFrame(media.videoDurationUs) ? decoded : requested;
}

export async function playableFilmBody(body: FilmBody, signal?: AbortSignal): Promise<FilmBody> {
  signal?.throwIfAborted();
  if (body.reviewDurationUs === undefined) return body;
  const original = await fs.stat(body.originalPath).catch(error => {
    // A whole-film replacement can still play if the original has since been removed.
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  signal?.throwIfAborted();
  if (!original) return body;
  const { size, mtimeMs } = original;
  const key = JSON.stringify([body.originalPath, size, mtimeMs, body.reviewDurationUs]);
  let length = originalLengths.get(key);
  if (!length) {
    if (originalLengths.size >= 128) originalLengths.delete(originalLengths.keys().next().value!);
    length = playableFrames(body.originalPath, body.reviewDurationUs, signal).catch(error => {
      originalLengths.delete(key);
      throw error;
    });
    originalLengths.set(key, length);
  }
  const frames = await length;
  const edits = body.edits.map(edit => edit.end === body.frames ? { ...edit, end: frames } : edit);
  return { ...body, frames, edits, reviewDurationUs: undefined };
}

export function sourceIdsForBody(body: FilmBody): string[] {
  const whole = body.edits.find((edit) => edit.whole);
  const replacements = body.edits.filter((edit) => !edit.whole);
  const usesBase = replacements.reduce((frames, edit) => frames + edit.end - edit.start, 0) < body.frames;
  return [...new Set([...(usesBase ? [whole?.videoJobId ?? body.originalVideoJobId] : []), ...replacements.map((edit) => edit.videoJobId)])];
}

export function filmAudioSignature(body: FilmBody): string {
  const source = body.edits.find((edit) => edit.whole);
  return createHash('sha256').update(JSON.stringify([
    body.snapshot.soundMode, body.snapshot.narrationPath,
    body.snapshot.narrationPath ? null : [source?.videoJobId ?? body.originalVideoJobId, source?.trim ?? 0],
  ])).digest('hex');
}

export function bodyWithCandidate(db: Database.Database, run: OneClickFilmRun, candidateId: string, trimStartUs?: number): FilmBody {
  const candidate = db.prepare(`
    SELECT * FROM one_click_film_candidates WHERE runId=? AND id=? AND status='ready' AND framesVerified=1
  `).get(run.id, candidateId) as {
    id: string; entryCode: string; reviewJobId: string; videoJobId: string; localVideoPath: string;
    replaceStartUs: number; replaceEndUs: number; trimStartUs: number; durationUs: number; shotId: string; reviewSourceId: string | null;
  } | undefined;
  const body = candidate ? readFilmBody(db, run, candidate.entryCode) : null;
  if (!candidate || !body || body.jobId !== candidate.reviewJobId) throw new OneClickFilmError('not_found', '候选不属于当前剪辑', 404);
  const whole = candidate.shotId === 'whole';
  if (!whole && candidate.reviewSourceId !== (body.edits.find((edit) => edit.whole)?.id ?? null)) {
    throw new OneClickFilmError('invalid_input', '候选基于旧版本，请恢复该版本后再比较');
  }
  const start = bodyFrame(candidate.replaceStartUs);
  const end = bodyFrame(candidate.replaceEndUs);
  const inPoint = trimStartUs ?? candidate.trimStartUs;
  if (!candidateFits(candidate, inPoint)) throw new OneClickFilmError('invalid_input', '候选截取范围无法覆盖当前镜头');
  const trim = bodyFrame(inPoint);
  const edits = [
    ...body.edits.filter((edit) => !whole && (edit.whole || edit.end <= start || edit.start >= end)),
    { id: candidate.id, videoJobId: candidate.videoJobId, file: filmStoragePath(candidate.localVideoPath),
      start, end, trim, whole },
  ].sort((a, b) => a.start - b.start);
  return { ...body, edits, signature: createHash('sha256').update(JSON.stringify([body.signature, edits])).digest('hex') };
}

export function readyHdPaths(db: Database.Database, run: OneClickFilmRun, body: FilmBody): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of sourceIdsForBody(body)) {
    const file = db.prepare(`
      SELECT localVideoPath FROM one_click_film_hd_sources
      WHERE runId=? AND entryId=? AND sourceVideoJobId=? AND status='ready'
    `).pluck().get(run.id, body.entryId, id);
    if (typeof file === 'string' && file) result.set(id, filmStoragePath(file));
  }
  return result;
}

export function filmBodyPictureSegments(body: FilmBody, hd?: Map<string, string>) {
  const availablePath = (id: string, draftPath: string) => {
    if (!hd) return draftPath;
    const source = hd.get(id);
    if (!source) throw new OneClickFilmError('invalid_input', '仍有采用的样片来源未转高清');
    return source;
  };
  const segments: Array<{ file: string; start: number; count: number }> = [];
  const whole = body.edits.find((edit) => edit.whole);
  const baseId = whole?.videoJobId ?? body.originalVideoJobId;
  const basePath = whole?.file ?? body.originalPath;
  const baseTrim = whole?.trim ?? 0;
  let position = 0;
  for (const edit of body.edits.filter((item) => !item.whole)) {
    if (edit.start < position || edit.end <= edit.start || edit.end > body.frames) {
      throw new OneClickFilmError('invalid_input', '采用的镜头区间无效');
    }
    if (edit.start > position) segments.push({
      file: availablePath(baseId, basePath), start: position + baseTrim, count: edit.start - position,
    });
    segments.push({ file: availablePath(edit.videoJobId, edit.file), start: edit.trim, count: edit.end - edit.start });
    position = edit.end;
  }
  if (position < body.frames) segments.push({
    file: availablePath(baseId, basePath), start: position + baseTrim, count: body.frames - position,
  });
  return { segments, continuousSound: basePath, baseTrim };
}

/** Use 24 fps source frames for every cut. Audio comes from one continuous input. */
export async function renderFilmBody(body: FilmBody, output: string, hd?: Map<string, string>): Promise<void> {
  body = await playableFilmBody(body);
  const { segments, continuousSound, baseTrim } = filmBodyPictureSegments(body, hd);
  const soundProbe = await probeVideoMedia(continuousSound);
  const first = await probeVideoMedia(segments[0]!.file);
  if (first.width < 2 || first.height < 2) throw new Error('无法读取成片画面');
  const width = first.width - first.width % 2;
  const height = first.height - first.height % 2;
  const paths = [...new Set([...segments.map((segment) => segment.file), continuousSound])];
  const filters = segments.map(({ file, start, count }, index) =>
    `[${paths.indexOf(file)}:v]fps=${FINAL_EDIT_FPS},trim=start_frame=${start}:end_frame=${start + count},setpts=PTS-STARTPTS,`
    + `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`);
  const sec = (body.frames / FINAL_EDIT_FPS).toFixed(8);
  filters.push(`${segments.map((_, index) => `[v${index}]`).join('')}concat=n=${segments.length}:v=1:a=0[video]`);
  const narration = body.snapshot.narrationPath ? filmStoragePath(body.snapshot.narrationPath) : null;
  const samplesPerFrame = 48_000 / FINAL_EDIT_FPS;
  const soundTrim = `atrim=start_sample=${baseTrim * samplesPerFrame}`;
  // When video and two audio inputs share a filter graph, amix can drop the tail
  // of a source with shorter packets. Align both inputs to the same sample count and packet size.
  const audioLength = narration
    ? `apad,atrim=end_sample=${body.frames * samplesPerFrame},asetnsamples=n=1024:p=0,asetpts=N/SR/TB`
    : `asetpts=PTS-STARTPTS,apad,atrim=duration=${sec}`;
  if (soundProbe.hasAudio) filters.push(`[${paths.indexOf(continuousSound)}:a]aresample=48000,${soundTrim},${audioLength}[sourceaudio]`);
  else filters.push(`anullsrc=r=48000:cl=stereo,${audioLength}[sourceaudio]`);
  if (narration) {
    filters.push(`[${paths.length}:a]aresample=48000,${audioLength}[narration];[sourceaudio][narration]amix=inputs=2:duration=first:normalize=0[audio]`);
  }
  await runFfmpeg([
    '-y', '-filter_complex_threads', '1', ...paths.flatMap((file) => ['-i', file]), ...(narration ? ['-i', narration] : []),
    '-filter_complex', filters.join(';'), '-map', '[video]', '-map', narration ? '[audio]' : '[sourceaudio]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FINAL_EDIT_FPS),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
  ], { timeoutMs: 180_000 });
  const result = await probeVideoMedia(output);
  if (await countFilmFrames(output) !== body.frames || bodyFrame(result.durationUs) !== body.frames || !result.hasAudio) throw new Error('合成结果时长或音轨校验失败');
}

const pending = new Map<string, Promise<string>>();

export async function getFilmPreview(db: Database.Database, run: OneClickFilmRun, body: FilmBody, highDefinition = false): Promise<string> {
  return videoJobFileUrl(await getFilmPreviewPath(db, run, body, highDefinition))!;
}

export async function getFilmPreviewPath(db: Database.Database, run: OneClickFilmRun, body: FilmBody, highDefinition = false): Promise<string> {
  if (!body.edits.length && !body.snapshot.narrationPath && !highDefinition) return body.originalPath;
  body = await playableFilmBody(body);
  const hd = highDefinition ? readyHdPaths(db, run, body) : undefined;
  const signature = createHash('sha256').update(JSON.stringify(['verified-frames-v1', body.signature, body.frames, hd ? [...hd] : null])).digest('hex');
  const directory = filmStoragePath(path.join('one-click-film', 'previews', run.id));
  const output = path.join(directory, `${signature}.mp4`);
  let work = pending.get(output);
  if (!work) {
    work = (async () => {
      try { await fs.access(output); }
      catch {
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `${randomUUID()}.mp4`);
        try {
          await renderFilmBody(body, temporary, hd);
          await fs.rename(temporary, output);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      registerManagedFile({ absolutePath: output, mimeType: 'video/mp4',
        references: [{ resourceType: 'project', resourceId: run.projectId, role: 'derivative' }] });
      return output;
    })().finally(() => pending.delete(output));
    pending.set(output, work);
  }
  return work;
}
