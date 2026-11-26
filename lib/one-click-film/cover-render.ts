import type Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { composeCoverJpg } from '../media-core/cover-compose.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { filmStoragePath, getFilmPreviewPath, readyHdPaths, sourceIdsForBody, type FilmBody } from './composition.ts';
import { resolveFilmCoverMedia, type FilmCoverMedia } from './cover-media.ts';
import { resolveFilmCoverImagePath } from './cover-source.ts';
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
  const { width, height } = await probeVideoMedia(input.bodyPath);
  const output = { width: width - width % 2, height: height - height % 2 };
  const framePath = path.join(path.dirname(input.jpgPath), 'cover-source.png');
  const coverSourcePath = input.imagePath ?? framePath;
  if ('frame' in input.cover) await extractFilmCoverFrame(input.bodyPath, input.cover.frame, framePath);
  await composeCoverJpg({ coverSourcePath, output, framing: input.cover.framing, jpgPath: input.jpgPath });
}

const coverPreviews = new Map<string, Promise<Buffer>>();

export async function previewFilmCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody, media?: FilmCoverMedia) {
  const cover = resolveFilmCoverMedia(media, body);
  const imagePath = 'assetId' in cover ? resolveFilmCoverImagePath(db, run, body, cover) : undefined;
  const hdReady = body.draft && readyHdPaths(db, run, body).size === sourceIdsForBody(body).length;
  const bodyPath = await getFilmPreviewPath(db, run, body, hdReady);
  const imageStat = imagePath ? await fs.stat(imagePath) : undefined;
  const key = JSON.stringify([bodyPath, 'frame' in cover ? cover.frame : null, cover.framing, imagePath, imageStat?.mtimeMs]);
  const cached = coverPreviews.get(key);
  if (cached) {
    coverPreviews.delete(key);
    coverPreviews.set(key, cached);
    return cached;
  }
  const pending = (async () => {
    const directory = filmStoragePath(path.join('one-click-film', 'previews', run.id));
    await fs.mkdir(directory, { recursive: true });
    const work = await fs.mkdtemp(path.join(directory, 'cover-'));
    try {
      const jpgPath = path.join(work, 'cover.jpg');
      await writeFilmCover({ bodyPath, cover, imagePath, jpgPath });
      return await fs.readFile(jpgPath);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  })();
  coverPreviews.set(key, pending);
  if (coverPreviews.size > 24) coverPreviews.delete(coverPreviews.keys().next().value!);
  return pending.catch(error => {
    if (coverPreviews.get(key) === pending) coverPreviews.delete(key);
    throw error;
  });
}
