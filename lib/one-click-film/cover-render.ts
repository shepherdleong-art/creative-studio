import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { composeCoverJpg } from '../media-core/cover-compose.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { filmStoragePath, getFilmPreviewPath, readyHdPaths, sourceIdsForBody, type FilmBody } from './composition.ts';
import { resolveFilmCoverMedia, type FilmCoverMedia } from './cover-media.ts';
import { resolveFilmCoverImagePath, resolveProjectCoverImagePath, unavailableFilmCoverImage } from './cover-source.ts';
import type { OneClickFilmRun } from './store.ts';

/** Extract by picture number on the same 24 fps clock used by the composition. */
export async function extractFilmCoverFrame(videoPath: string, frame: number, output: string, preview = false) {
  const scale = preview ? ",scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease" : '';
  await runFfmpeg(['-y', '-i', videoPath, '-vf', `fps=${FINAL_EDIT_FPS},select=eq(n\\,${frame})${scale}`,
    '-frames:v', '1', '-threads', '1', '-update', '1', output], { timeoutMs: 30_000 });
}

export async function writeFilmCover(input: {
  bodyPath: string;
  cover: FilmCoverMedia;
  imagePath?: string;
  jpgPath: string;
}) {
  const coverSourcePath = 'frame' in input.cover ? path.join(path.dirname(input.jpgPath), 'cover-source.png') : input.imagePath;
  if (!coverSourcePath) throw unavailableFilmCoverImage();
  const { width, height } = await probeVideoMedia(input.bodyPath);
  const output = { width: width - width % 2, height: height - height % 2 };
  if ('frame' in input.cover) await extractFilmCoverFrame(input.bodyPath, input.cover.frame, coverSourcePath);
  try {
    await composeCoverJpg({ coverSourcePath, output, framing: input.cover.framing, jpgPath: input.jpgPath });
  } catch (error) {
    if ('assetId' in input.cover) throw unavailableFilmCoverImage();
    throw error;
  }
}

const coverPreviews = new Map<string, Promise<Buffer>>();

function previewBodyPath(db: Database.Database, run: OneClickFilmRun, body: FilmBody) {
  const hdReady = body.draft && readyHdPaths(db, run, body).size === sourceIdsForBody(body).length;
  return getFilmPreviewPath(db, run, body, hdReady);
}

async function withCoverWorkDir<T>(run: OneClickFilmRun, write: (work: string) => Promise<T>): Promise<T> {
  const directory = filmStoragePath(path.join('one-click-film', 'previews', run.id));
  await fs.mkdir(directory, { recursive: true });
  const work = await fs.mkdtemp(path.join(directory, 'cover-'));
  try { return await write(work); }
  finally { await fs.rm(work, { recursive: true, force: true }); }
}

export async function readCoverThumbnail(imagePath: string, maxSide: number) {
  try {
    const image = sharp(imagePath).rotate();
    const { autoOrient: { width, height } } = await image.metadata();
    const jpeg = await image.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
    return { jpeg, width, height };
  } catch {
    throw unavailableFilmCoverImage();
  }
}

export function previewProjectCoverThumbnail(db: Database.Database, projectId: string, assetId: string) {
  return readCoverThumbnail(resolveProjectCoverImagePath(db, projectId, assetId), 240);
}

/** Uncropped proxy for responsive dragging. Keep original oriented dimensions for crop rounding. */
export async function previewFilmCoverFramingSource(db: Database.Database, run: OneClickFilmRun, body: FilmBody, media?: FilmCoverMedia) {
  const cover = resolveFilmCoverMedia(media, body);
  if ('assetId' in cover) return readCoverThumbnail(resolveFilmCoverImagePath(db, run, body, cover), 960);
  const bodyPath = await previewBodyPath(db, run, body);
  return withCoverWorkDir(run, async work => {
    const framePath = path.join(work, 'cover-source.png');
    await extractFilmCoverFrame(bodyPath, cover.frame, framePath);
    return readCoverThumbnail(framePath, 960);
  });
}

export async function previewFilmCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody, media?: FilmCoverMedia) {
  const cover = resolveFilmCoverMedia(media, body);
  const imagePath = 'assetId' in cover ? resolveFilmCoverImagePath(db, run, body, cover) : undefined;
  const bodyPath = await previewBodyPath(db, run, body);
  const imageStat = imagePath ? await fs.stat(imagePath).catch(() => { throw unavailableFilmCoverImage(); }) : undefined;
  const key = JSON.stringify([bodyPath, 'frame' in cover ? cover.frame : null, cover.framing, imagePath, imageStat?.mtimeMs]);
  const cached = coverPreviews.get(key);
  if (cached) {
    coverPreviews.delete(key);
    coverPreviews.set(key, cached);
    return cached;
  }
  const pending = withCoverWorkDir(run, async work => {
    const jpgPath = path.join(work, 'cover.jpg');
    await writeFilmCover({ bodyPath, cover, imagePath, jpgPath });
    return fs.readFile(jpgPath);
  });
  coverPreviews.set(key, pending);
  if (coverPreviews.size > 24) coverPreviews.delete(coverPreviews.keys().next().value!);
  return pending.catch(error => {
    if (coverPreviews.get(key) === pending) coverPreviews.delete(key);
    throw error;
  });
}
