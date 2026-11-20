import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { registerManagedFile } from '../media-core/access-context.ts';
import { createOpenAiTranscriptionAdapter, type AlignmentWordTiming } from '../media-core/adapters/alignment.ts';
import { createVolcFlashAsrAdapter } from '../media-core/adapters/volc-asr.ts';
import { scanBgmTracks } from '../media-core/bgm-catalog.ts';
import { bgmStreamLoopCount } from '../media-core/bgm-loop.ts';
import { renderVideoPackaging } from '../media-core/packaging-render.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../media-core/render-contract.ts';
import { bodyFrame, filmAudioSignature, filmStoragePath, readFilmBody, readyHdPaths, renderFilmBody, type FilmBody } from './composition.ts';
import { listPackaging, packagingEligibility, type PackagingRecord, type TextCue } from './packaging.ts';
import { DEFAULT_SUBTITLE_POSITION, packagingOverlayConfig, splitTimedSubtitle, STICKERS, type Position, type StickerCue } from './packaging-edit.ts';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';

const pending = new Map<string, Promise<void>>();

export async function listFilmBgm(db: Database.Database) {
  return (await scanBgmTracks(db, path.join(dataRoot(), 'storage'))).map((track) => ({
    ...track, name: path.basename(track.relativePath),
  }));
}

function subtitleCues(words: AlignmentWordTiming[], duration: number): TextCue[] {
  const cues: TextCue[] = [];
  let group: AlignmentWordTiming[] = [];
  const flush = () => {
    if (!group.length) return;
    let text = '';
    const timestamps = group.map((word) => {
      const value = word.text.trim();
      if (text && !(/\p{Script=Han}$/u.test(text) && /^[\p{Script=Han}，。！？；、]/u.test(value))) text += ' ';
      text += value;
      return { at: text.length, sec: word.endUs / 1e6 };
    });
    const startSec = Math.max(0, group[0]!.startUs / 1e6);
    const endSec = Math.min(duration, group.at(-1)!.endUs / 1e6);
    if (text && endSec > startSec) cues.push(...splitTimedSubtitle({ id: `sub-${cues.length}`, text, startSec, endSec }, timestamps));
    group = [];
  };
  for (const word of words) {
    group.push(word);
    if (group.map((item) => item.text).join('').length >= 18 || /[。！？.!?]$/.test(word.text)) flush();
  }
  flush();
  return cues;
}

async function timedSubtitles(db: Database.Database, run: OneClickFilmRun, body: FilmBody, workDir: string): Promise<TextCue[]> {
  if (body.snapshot.soundMode === 'none') return [];
  const source = body.snapshot.narrationPath ? filmStoragePath(body.snapshot.narrationPath)
    : body.edits.find((edit) => edit.whole)?.file ?? body.originalPath;
  if (!body.snapshot.narrationPath && !(await probeVideoMedia(source)).hasAudio) return [];
  const configuredTranscription = createOpenAiTranscriptionAdapter();
  const adapter = configuredTranscription.configured ? configuredTranscription : createVolcFlashAsrAdapter(process.env, db);
  if (!adapter.configured) throw new Error('口播字幕需要配置豆包语音 Key 或独立语音转录服务。');
  const duration = body.frames / FINAL_EDIT_FPS;
  const audioInput = `${filmAudioSignature(body)}-${body.frames}`;
  // 已受理的转录可能在包装请求结束后恢复，给它留一个按音轨身份固定的输入。
  const speech = path.join(path.dirname(workDir), 'speech', `${audioInput}.wav`);
  try {
    await fs.access(speech);
  } catch {
    const scratch = path.join(workDir, 'speech.wav');
    await runFfmpeg(['-y', '-i', source, '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', scratch], { timeoutMs: 60_000 });
    await fs.mkdir(path.dirname(speech), { recursive: true });
    await fs.rename(scratch, speech).catch(async (error: NodeJS.ErrnoException) => {
      if (!['EEXIST', 'EPERM'].includes(error.code ?? '')) throw error;
      await fs.access(speech);
    });
  }
  const result = await adapter.transcribe({
    audioPath: speech, durationUs: Math.round(duration * 1e6),
    execution: { taskId: body.jobId, step: 'one-click-film-subtitles', inputRevision: audioInput,
      scope: { resourceType: 'project', resourceId: run.projectId } },
  });
  return subtitleCues(result.words, duration);
}

/** Refresh the editable cues without rendering a packaged MP4. */
export async function recognizeFilmPackagingSubtitles(db: Database.Database, run: OneClickFilmRun, code: string, revision: number) {
  const body = readFilmBody(db, run, code);
  const record = listPackaging(db, run).find((item) => item.entryCode === code);
  if (!body || !record || record.revision !== revision) throw new OneClickFilmError('conflict', '包装草稿已更新，请重新打开', 409);
  const directory = filmStoragePath(path.join('one-click-film', 'packaging', run.id));
  await fs.mkdir(directory, { recursive: true });
  const work = await fs.mkdtemp(path.join(directory, 'subtitle-'));
  try {
    const cues = await timedSubtitles(db, run, body, work);
    if (readFilmBody(db, run, code)?.signature !== body.signature) throw new OneClickFilmError('conflict', '成片已更新，请重新识别字幕', 409);
    const saved = db.prepare(
      "UPDATE one_click_film_packaging SET subtitleCuesJson=?, audioSignature=?, status='pending', revision=revision+1, errorMessage=NULL, updatedAt=datetime('now') WHERE id=? AND revision=?",
    ).run(JSON.stringify(cues), filmAudioSignature(body), record.id, revision);
    if (!saved.changes) throw new OneClickFilmError('conflict', '包装草稿已更新，请重新打开', 409);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

function assPosition({ x, y }: Position): string {
  return '\\pos(' + Math.round(x * 5.4) + ',' + Math.round(y * 7.2) + ')';
}

async function writeStickerFile(workDir: string, stickers: StickerCue[], offset: number, duration: number): Promise<string> {
  const events = stickers.filter((sticker) => sticker.startSec < duration).map((sticker) => {
    const shape = STICKERS[sticker.kind];
    return 'Dialogue: 0,' + assTime(sticker.startSec + offset) + ',' + assTime(Math.min(sticker.endSec, duration) + offset)
      + ',Film,,0,0,0,,{\\an5' + assPosition(sticker) + '\\c&H' + shape.assColor + '&\\bord0\\shad0\\p1}' + shape.drawing + '{\\p0}';
  });
  return writeAss(workDir, 'stickers.ass', events);
}

function assTime(seconds: number): string {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:`
    + `${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

async function writeSubtitleFile(workDir: string, cues: TextCue[], offset: number, position: Position): Promise<string> {
  const events = cues.map((cue) => {
    const text = cue.text.replace(/[{}\\]/g, '').replace(/[\r\n]+/g, ' ');
    return `Dialogue: 0,${assTime(cue.startSec + offset)},${assTime(cue.endSec + offset)},Film,,0,0,0,,{${assPosition(position)}}${text}`;
  });
  return writeAss(workDir, 'captions.ass', events);
}

async function writeAss(workDir: string, name: string, events: string[]): Promise<string> {
  const file = path.join(workDir, name);
  await fs.writeFile(file, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 540', 'PlayResY: 720', 'WrapStyle: 0', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Film,Lins Sans SC,29,&H00FFFFFF,&H00FFFFFF,&H00101010,&H58000000,-1,0,0,0,100,100,0,0,1,2,0,2,26,26,62,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
  ].join('\n'), 'utf8');
  return file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");
}

async function renderPackagingRevision(db: Database.Database, run: OneClickFilmRun, record: PackagingRecord, refreshSubtitles: boolean) {
  const body = readFilmBody(db, run, record.entryCode);
  if (!body || !packagingEligibility(db, run, record.entryCode).ready) throw new Error('请先通过当前成片的审片');
  const audioSignature = filmAudioSignature(body);
  const previousAudioSignature = db.prepare('SELECT audioSignature FROM one_click_film_packaging WHERE id=?').pluck().get(record.id);
  const directory = filmStoragePath(path.join('one-click-film', 'packaging', run.id));
  await fs.mkdir(directory, { recursive: true });
  const work = await fs.mkdtemp(path.join(directory, 'render-'));
  const finalName = path.join(directory, `${record.entryCode}-${record.revision}-${randomUUID()}.mp4`);
  try {
    const bodyFile = path.join(work, 'body.mp4');
    await renderFilmBody(body, bodyFile, body.draft ? readyHdPaths(db, run, body) : undefined);
    const introFrames = record.options.cover ? FINAL_EDIT_INTRO_FRAMES : 0;
    const offset = introFrames / FINAL_EDIT_FPS;
    const totalFrames = body.frames + introFrames;
    const totalSec = totalFrames / FINAL_EDIT_FPS;
    const refreshTiming = refreshSubtitles || audioSignature !== previousAudioSignature;
    const subtitle = record.options.subtitles && body.snapshot.soundMode !== 'none'
      ? refreshTiming ? await timedSubtitles(db, run, body, work) : record.subtitleCues : [];
    const bgm = record.options.bgm ? (await listFilmBgm(db)).find((track) => !record.options.bgmId || track.id === record.options.bgmId) : undefined;
    if (record.options.bgm && !bgm) throw new Error('曲库还没有可用的配乐，请选用已有配乐或关闭 BGM。');
    const overlay = packagingOverlayConfig(record);
    const cues = subtitle.length ? await writeSubtitleFile(work, subtitle, offset, record.options.subtitlePosition ?? DEFAULT_SUBTITLE_POSITION) : '';
    const stickers = record.options.stickers?.length
      ? await writeStickerFile(work, record.options.stickers, offset, body.frames / FINAL_EDIT_FPS) : '';
    const video = [introFrames ? `tpad=start=${introFrames}:start_mode=clone` : 'null',
      ...(stickers ? [`subtitles=filename='${stickers}'`] : []),
      ...(cues && !overlay.enabled ? [`subtitles=filename='${cues}'`] : [])].join(',');
    const audio = [`[0:a]aresample=48000,adelay=${Math.round(offset * 48000)}S:all=1[a0]`];
    if (bgm) audio.push(`[1:a]aresample=48000,volume=${record.options.bgmVolume / 100},atrim=duration=${totalSec.toFixed(8)}[music]`,
      '[a0][music]amix=inputs=2:duration=first:normalize=0[audio]');
    const videoPath = path.join(work, 'final.mp4');
    await runFfmpeg([
      '-y', '-filter_complex_threads', '1', '-i', bodyFile,
      ...(bgm ? ['-stream_loop', String(bgmStreamLoopCount(bgm.durationUs / 1e6, totalSec)), '-i', filmStoragePath(bgm.relativePath)] : []),
      '-filter_complex', `[0:v]${video}[video];${audio.join(';')}`, '-map', '[video]', '-map', bgm ? '[audio]' : '[a0]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FINAL_EDIT_FPS),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath,
    ], { timeoutMs: 180_000 });
    if (overlay.enabled) {
      const coverPath = path.join(work, 'cover.jpg');
      if (record.options.cover) await runFfmpeg(['-y', '-i', bodyFile, '-frames:v', '1', '-update', '1', coverPath]);
      await renderVideoPackaging({
        videoPath, coverPath, totalSec, staticCover: true, coverEnabled: record.options.cover,
        config: overlay,
      });
      if (cues) {
        const captioned = path.join(work, 'captioned.mp4');
        await runFfmpeg(['-y', '-i', videoPath, '-vf', `subtitles=filename='${cues}'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', captioned],
        { timeoutMs: 180_000 });
        await fs.rename(captioned, videoPath);
      }
    }
    const result = await probeVideoMedia(videoPath);
    if (bodyFrame(result.durationUs) !== totalFrames || result.fps !== FINAL_EDIT_FPS || !result.hasAudio) {
      throw new Error('包装产物帧率、长度或音轨校验失败');
    }
    await fs.rename(videoPath, finalName);
    const relative = path.relative(path.join(dataRoot(), 'storage'), finalName).split(path.sep).join('/');
    db.transaction(() => {
      const current = readFilmBody(db, run, record.entryCode);
      if (current?.signature !== body.signature || !packagingEligibility(db, run, record.entryCode).ready) {
        throw new Error('渲染期间成片版本已变更，请重新包装。');
      }
      const updated = db.prepare(`
        UPDATE one_click_film_packaging SET status='ready', relativePath=?, sourceSignature=?, audioSignature=?, subtitleCuesJson=?,
          title=?, pointCuesJson=?, errorMessage=NULL, updatedAt=datetime('now') WHERE id=? AND revision=?
      `).run(relative, body.signature, audioSignature, JSON.stringify(subtitle), record.title, JSON.stringify(record.pointCues),
        record.id, record.revision);
      if (!updated.changes) throw new Error('已保存了更新的包装版本。');
      registerManagedFile({ absolutePath: finalName, mimeType: 'video/mp4',
        references: [{ resourceType: 'project', resourceId: run.projectId, role: 'derivative' }] });
    }).immediate();
  } catch (error) {
    await fs.rm(finalName, { force: true });
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

export async function renderFilmPackaging(db: Database.Database, run: OneClickFilmRun, code: string, refreshSubtitles: boolean, expectedRevision?: number): Promise<void> {
  const record = listPackaging(db, run).find((item) => item.entryCode === code);
  if (!record) throw new Error('请先准备该条包装。');
  if (expectedRevision !== undefined && record.revision !== expectedRevision) {
    throw new OneClickFilmError('conflict', '包装草稿已更新，请确认后再导出', 409);
  }
  if (record.ready) return;
  const key = `${run.id}/${record.id}/${record.revision}`;
  let work = pending.get(key);
  if (!work) {
    work = renderPackagingRevision(db, run, record, refreshSubtitles).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare("UPDATE one_click_film_packaging SET status='failed', errorMessage=? WHERE id=? AND revision=?")
        .run(message.slice(0, 500), record.id, record.revision);
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
  }
  await work;
}
