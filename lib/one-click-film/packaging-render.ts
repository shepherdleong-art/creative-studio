import { FONT_SLOTS, FONT_SLOT_ALIASES, materializeFontBuffer } from '../media-core/packaging-font.ts';
import { resolveSystemFontFile } from '../media-core/system-fonts.ts';
import type { FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import sharp from 'sharp';
import type { TextStyle } from '../media-core/cover-types.ts';
import { countFilmFrames } from './frames.ts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../canonical-json.ts';
import { dataRoot } from '../data-root.ts';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { registerManagedFile } from '../media-core/access-context.ts';
import { createOpenAiTranscriptionAdapter, type AlignmentWordTiming } from '../media-core/adapters/alignment.ts';
import { createVolcFlashAsrAdapter } from '../media-core/adapters/volc-asr.ts';
import { scanBgmTracks } from '../media-core/bgm-catalog.ts';
import { bgmStreamLoopCount } from '../media-core/bgm-loop.ts';
import { renderVideoPackaging } from '../media-core/packaging-render.ts';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '../media-core/render-contract.ts';
import { bodyFrame, filmAudioSignature, filmStoragePath, playableFilmBody, readFilmBody, readyHdPaths, renderFilmBody, type FilmBody } from './composition.ts';
import { extractFilmPackagingPoints, listPackaging, packagingEligibility, type PackagingRecord, type TextCue } from './packaging.ts';
import { filmCaptionSvg, isUneditedFilmPointSticker, resolveFilmSubtitleStyle, packagingOverlayConfig, splitTimedSubtitle, syncFilmPointStickers, STICKERS, type Position, type StickerCue } from './packaging-edit.ts';
import { OneClickFilmError } from './errors.ts';
import { resolveFilmCoverMedia } from './cover-media.ts';
import { writeFilmCover } from './cover-render.ts';
import { resolveFilmCoverImagePath } from './cover-source.ts';
import type { OneClickFilmRun } from './store.ts';

const pending = new Map<string, Promise<void>>();
const CAPTION_RENDERER = 'single-line-v2';

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
    const startSec = Math.max(cues.at(-1)?.endSec ?? 0, group[0]!.startUs / 1e6);
    const endSec = Math.min(duration, group.at(-1)!.endUs / 1e6);
    if (text && endSec > startSec) cues.push(...splitTimedSubtitle({ id: `sub-${cues.length}`, text, startSec, endSec }, timestamps));
    group = [];
  };
  for (const word of words) {
    if (group.length && word.startUs - group.at(-1)!.endUs > 450_000) flush();
    group.push(word);
    if (group.map((item) => item.text).join('').length >= 18 || /[。！？.!?]$/.test(word.text)) flush();
  }
  flush();
  return cues;
}

async function timedSubtitles(db: Database.Database, run: OneClickFilmRun, body: FilmBody, workDir: string) {
  if (body.snapshot.soundMode === 'none') return { cues: [], words: [] };
  const whole = body.edits.find((edit) => edit.whole);
  const source = body.snapshot.narrationPath ? filmStoragePath(body.snapshot.narrationPath)
    : whole?.file ?? body.originalPath;
  if (!body.snapshot.narrationPath && !(await probeVideoMedia(source)).hasAudio) return { cues: [], words: [] };
  const configuredTranscription = createOpenAiTranscriptionAdapter();
  const adapter = configuredTranscription.configured ? configuredTranscription : createVolcFlashAsrAdapter(process.env, db);
  if (!adapter.configured) throw new Error('口播字幕需要配置豆包语音 Key 或独立语音转录服务。');
  const duration = body.frames / FINAL_EDIT_FPS;
  const audioInput = `${filmAudioSignature(body)}-${body.frames}${whole?.trim && !body.snapshot.narrationPath ? '-trimmed' : ''}`;
  // 已受理的转录可能在包装请求结束后恢复，给它留一个按音轨身份固定的输入。
  const speech = path.join(path.dirname(workDir), 'speech', `${audioInput}.wav`);
  try {
    await fs.access(speech);
  } catch {
    const scratch = path.join(workDir, 'speech.wav');
    const trimSec = body.snapshot.narrationPath ? 0 : (whole?.trim ?? 0) / FINAL_EDIT_FPS;
    await runFfmpeg(['-y', '-i', source, ...(trimSec ? ['-ss', String(trimSec)] : []),
      '-t', String(duration), '-vn', '-ac', '1', '-ar', '16000', scratch], { timeoutMs: 60_000 });
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
  const words = result.words.filter(word => Number.isFinite(word.startUs) && Number.isFinite(word.endUs) && word.endUs > word.startUs && word.text.trim())
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const cues = subtitleCues(words, duration);
  if (body.snapshot.soundMode === 'tts' && body.snapshot.narration?.trim() && !cues.length) {
    throw new Error('未能从当前旁白取得有效时间戳，请重新识别。');
  }
  return { cues, words };
}

/** Refresh the editable cues without rendering a packaged MP4. */
export function recognizeFilmPackagingSubtitles(db: Database.Database, run: OneClickFilmRun, code: string, revision: number,
  mode: 'explicit' | 'open' = 'explicit') {
  const key = `subtitles/${run.id}/${code}/${revision}/${mode}`;
  let work = pending.get(key);
  if (!work) {
    work = recognizeRevisionSubtitles(db, run, code, revision, mode === 'open').finally(() => pending.delete(key));
    pending.set(key, work);
  }
  return work;
}

function subtitleRecognitionInputs(record: PackagingRecord) {
  const { subtitles, decoration, pointCuesEdited, assetStickers } = record.options;
  return canonicalJson([record.subtitleCues, record.pointCues, subtitles, decoration, pointCuesEdited, assetStickers]);
}

async function recognizeRevisionSubtitles(db: Database.Database, run: OneClickFilmRun, code: string, revision: number, whenOpening: boolean) {
  const body = readFilmBody(db, run, code);
  const record = listPackaging(db, run).find((item) => item.entryCode === code);
  if (!body || !record || (!whenOpening && record.revision !== revision)) {
    throw new OneClickFilmError('conflict', '包装草稿已更新，请重新打开', 409);
  }
  if (whenOpening && (record.subtitlesPrepared || !record.options.subtitles)) return;
  const directory = filmStoragePath(path.join('one-click-film', 'packaging', run.id));
  await fs.mkdir(directory, { recursive: true });
  const work = await fs.mkdtemp(path.join(directory, 'subtitle-'));
  try {
    const playable = await playableFilmBody(body);
    const { cues, words } = await timedSubtitles(db, run, playable, work);
    db.transaction(() => {
      if (readFilmBody(db, run, code)?.signature !== body.signature) throw new OneClickFilmError('conflict', '成片已更新，请重新识别字幕', 409);
      const latest = whenOpening ? listPackaging(db, run).find(item => item.entryCode === code) : record;
      if (whenOpening && (!latest || latest.id !== record.id || latest.subtitlesPrepared
          || subtitleRecognitionInputs(latest) !== subtitleRecognitionInputs(record))) return;
      if (!latest) return;
      const points = latest.options.decoration && !latest.options.pointCuesEdited
        ? extractFilmPackagingPoints(db, run, code, cues, words) : latest.pointCues;
      const currentStickers = latest.options.assetStickers ?? [];
      const assetStickers = currentStickers.some(isUneditedFilmPointSticker) && !latest.options.pointCuesEdited
        ? syncFilmPointStickers(currentStickers, points, playable.frames)
        : latest.options.assetStickers;
      const saved = db.prepare(
        "UPDATE one_click_film_packaging SET subtitleCuesJson=?, pointCuesJson=?, optionsJson=?, title=?, audioSignature=?, status='pending', revision=revision+1, errorMessage=NULL, updatedAt=datetime('now') WHERE id=? AND revision=?",
      ).run(JSON.stringify(cues), JSON.stringify(points), JSON.stringify({ ...latest.options, assetStickers }), latest.title, filmAudioSignature(body), latest.id, latest.revision);
      if (!saved.changes) throw new OneClickFilmError('conflict', '包装草稿已更新，请重新打开', 409);
    }).immediate();
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

// PNGs use the same single-line SVG as the monitor. One timed image stream also
// handles gaps without opening a separate FFmpeg input for each subtitle.
async function burnCaptions(video: string, work: string, cues: TextCue[], style: TextStyle, offsetFrames: number, totalFrames: number) {
  const { width, height } = await probeVideoMedia(video);
  const frameAt = (sec: number) => Math.max(0, Math.min(totalFrames, offsetFrames + Math.ceil(sec * FINAL_EDIT_FPS - 1e-6)));
  const ranges = cues.map(cue => ({ start: frameAt(cue.startSec), end: frameAt(cue.endSec), text: cue.text }));
  const boundaries = [...new Set([0, totalFrames, ...ranges.flatMap(cue => [cue.start, cue.end])])].sort((a, b) => a - b);
  const manifest = ['ffconcat version 1.0'];
  const files = new Map<string, string>();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const caption = ranges.find(cue => start >= cue.start && start < cue.end)?.text || '';
    let name = files.get(caption);
    if (!name) {
      name = `caption-${files.size}.png`;
      await sharp(Buffer.from(filmCaptionSvg(style, caption, width, height))).png().toFile(path.join(work, name));
      files.set(caption, name);
    }
    manifest.push(`file '${name}'`, `option framerate ${FINAL_EDIT_FPS}`,
      `duration ${((boundaries[i + 1] - start) / FINAL_EDIT_FPS).toFixed(8)}`);
  }
  const track = path.join(work, 'captions.ffconcat');
  await fs.writeFile(track, manifest.join('\n') + '\n');
  const target = path.join(work, 'captioned.mp4');
  await runFfmpeg(['-y', '-i', video, '-f', 'concat', '-safe', '0', '-i', track,
    '-filter_complex', '[0:v][1:v]overlay=0:0[video]', '-map', '[video]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', target],
  { timeoutMs: 180_000 });
  await fs.rename(target, video);
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

// 团队模式只读取已公开给成员的字体目录。预览与导出共用同一个受控字体 ID。
function sharedFontId(file?: string) {
  return file?.match(/^\/api\/system-fonts\/([a-f0-9]{64})\/file$/)?.[1];
}

export function filmPreviewFontCss(config: FinalEditPackagingConfig) {
  return FONT_SLOTS.map(slot => {
    const id = sharedFontId(config[`${slot}Font`]?.file);
    return id ? `@font-face{font-family:"${FONT_SLOT_ALIASES[slot]}";src:url("/api/system-fonts/${id}/file");font-weight:100 900;}` : '';
  }).join('');
}

async function resolveRenderFonts(config: FinalEditPackagingConfig) {
  for (const slot of FONT_SLOTS) {
    const key = `${slot}Font` as const;
    const font = config[key];
    const id = sharedFontId(font?.file);
    if (!font || !id) continue;
    const file = resolveSystemFontFile(id);
    if (!file) throw new Error(`团队字体「${font.family}」已不可用，请重新选择。`);
    config[key] = { ...font, file: materializeFontBuffer(await fs.readFile(file), path.extname(file), slot) };
  }
}

async function renderPackagingRevision(db: Database.Database, run: OneClickFilmRun, record: PackagingRecord, refreshSubtitles: boolean) {
  const saved = readFilmBody(db, run, record.entryCode);
  if (!saved || !packagingEligibility(db, run, record.entryCode).ready) throw new Error('请先通过当前成片的审片');
  const body = await playableFilmBody(saved);
  const introFrames = record.options.cover ? FINAL_EDIT_INTRO_FRAMES : 0;
  const cover = resolveFilmCoverMedia(record.options.coverMedia, body);
  const imagePath = introFrames && 'assetId' in cover ? resolveFilmCoverImagePath(db, run, body, cover) : undefined;
  const useSubtitles = record.options.subtitles && body.snapshot.soundMode !== 'none';
  if (useSubtitles && record.subtitleCues.length && !refreshSubtitles && !record.subtitlesPrepared) {
    throw new Error('请先在字幕面板完成口播对时，或关闭口播字幕后再导出。');
  }
  const audioSignature = filmAudioSignature(body);
  const previousAudioSignature = db.prepare('SELECT audioSignature FROM one_click_film_packaging WHERE id=?').pluck().get(record.id);
  const directory = filmStoragePath(path.join('one-click-film', 'packaging', run.id));
  await fs.mkdir(directory, { recursive: true });
  const work = await fs.mkdtemp(path.join(directory, 'render-'));
  const finalName = path.join(directory, `${record.entryCode}-${record.revision}-${randomUUID()}.mp4`);
  try {
    const bodyFile = path.join(work, 'body.mp4');
    await renderFilmBody(body, bodyFile, body.draft ? readyHdPaths(db, run, body) : undefined);
    const offset = introFrames / FINAL_EDIT_FPS;
    const totalFrames = body.frames + introFrames;
    const totalSec = totalFrames / FINAL_EDIT_FPS;
    const subtitle = useSubtitles
      ? refreshSubtitles ? (await timedSubtitles(db, run, body, work)).cues : record.subtitleCues : [];
    const bgm = record.options.bgm ? (await listFilmBgm(db)).find((track) => !record.options.bgmId || track.id === record.options.bgmId) : undefined;
    if (record.options.bgm && !bgm) throw new Error('曲库还没有可用的配乐，请选用已有配乐或关闭 BGM。');
    const overlay = packagingOverlayConfig(record);
    const stickers = record.options.stickers?.length
      ? await writeStickerFile(work, record.options.stickers, offset, body.frames / FINAL_EDIT_FPS) : '';
    const coverPath = path.join(work, 'cover.jpg');
    if (introFrames || overlay.enabled) {
      await writeFilmCover({ bodyPath: bodyFile, cover: introFrames ? cover : resolveFilmCoverMedia(undefined, body),
        imagePath, jpgPath: coverPath });
    }
    const intro = introFrames
      ? `[1:v]trim=end_frame=${introFrames},format=yuv420p,setsar=1,setpts=PTS-STARTPTS[intro];[intro][0:v]concat=n=2:v=1:a=0[base];`
      : '';
    const video = [introFrames ? '[base]null' : '[0:v]null',
      ...(stickers ? [`subtitles=filename='${stickers}'`] : [])].join(',');
    const audio = [`[0:a]aresample=48000,adelay=${Math.round(offset * 48000)}S:all=1[a0]`];
    if (bgm) audio.push(`[${introFrames ? 2 : 1}:a]aresample=48000,volume=${record.options.bgmVolume / 100},atrim=duration=${totalSec.toFixed(8)}[music]`,
      '[a0][music]amix=inputs=2:duration=first:normalize=0[audio]');
    const videoPath = path.join(work, 'final.mp4');
    await runFfmpeg([
      '-y', '-filter_complex_threads', '1', '-i', bodyFile,
      ...(introFrames ? ['-loop', '1', '-framerate', String(FINAL_EDIT_FPS), '-i', coverPath] : []),
      ...(bgm ? ['-stream_loop', String(bgmStreamLoopCount(bgm.durationUs / 1e6, totalSec)), '-i', filmStoragePath(bgm.relativePath)] : []),
      '-filter_complex', `${intro}${video}[video];${audio.join(';')}`, '-map', '[video]', '-map', bgm ? '[audio]' : '[a0]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FINAL_EDIT_FPS),
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', videoPath,
    ], { timeoutMs: 180_000 });
    if (overlay.enabled) {
      await resolveRenderFonts(overlay);
      await renderVideoPackaging({
        videoPath, coverPath, paletteImagePath: coverPath, totalSec, staticCover: true, coverEnabled: record.options.cover,
        config: overlay,
      });
    }
    if (subtitle.length) await burnCaptions(videoPath, work, subtitle,
      resolveFilmSubtitleStyle(record.options.subtitleStyle, record.options.subtitlePosition), introFrames, totalFrames);
    const result = await probeVideoMedia(videoPath);
    if (await countFilmFrames(videoPath) !== totalFrames || bodyFrame(result.durationUs) !== totalFrames || result.fps !== FINAL_EDIT_FPS || !result.hasAudio) {
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
          title=?, pointCuesJson=?, optionsJson=json_set(optionsJson, '$.captionRenderer', ?, '$.renderedCoverMedia', json(?)),
          errorMessage=NULL, updatedAt=datetime('now') WHERE id=? AND revision=?
      `).run(relative, body.signature, useSubtitles && refreshSubtitles ? audioSignature : previousAudioSignature,
        JSON.stringify(useSubtitles ? subtitle : record.subtitleCues), record.title, JSON.stringify(record.pointCues),
        CAPTION_RENDERER, JSON.stringify(cover), record.id, record.revision);
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
  // A requested re-export can render an old caption layout into a new file. Keep
  // its previously published revision available until the replacement succeeds.
  if (record.ready) {
    const renderer = db.prepare("SELECT json_extract(optionsJson,'$.captionRenderer') FROM one_click_film_packaging WHERE id=?")
      .pluck().get(record.id);
    if (!record.options.subtitles || renderer === CAPTION_RENDERER) {
      const cover = record.options.coverMedia;
      if (record.options.cover && cover && 'assetId' in cover) {
        const body = readFilmBody(db, run, code);
        if (!body) throw new OneClickFilmError('invalid_input', '还没有生成原片');
        resolveFilmCoverImagePath(db, run, body, cover);
      }
      return;
    }
  }
  const key = `${run.id}/${record.id}/${record.revision}`;
  let work = pending.get(key);
  if (!work) {
    work = renderPackagingRevision(db, run, record, refreshSubtitles).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!record.ready) {
        db.prepare("UPDATE one_click_film_packaging SET status='failed', errorMessage=? WHERE id=? AND revision=?")
          .run(message.slice(0, 500), record.id, record.revision);
      }
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
  }
  await work;
}
