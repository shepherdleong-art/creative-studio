import type Database from 'better-sqlite3';
import type { FilmBody } from './composition.ts';
import { parseFilmCoverMedia, type FilmCoverMedia } from './cover-media.ts';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';

export const resolveFilmCoverImagePath: (
  db: Database.Database, run: OneClickFilmRun, body: FilmBody, cover: Extract<FilmCoverMedia, { assetId: string }>,
) => string = () => {
  throw new OneClickFilmError('invalid_input', '当前封面图片不可用');
};

export function validateFilmCoverSelection(db: Database.Database, run: OneClickFilmRun, body: FilmBody, value: unknown) {
  if (value == null) return undefined;
  const cover = parseFilmCoverMedia(value);
  if (!cover) throw new OneClickFilmError('invalid_input', '封面底图配置无效');
  if ('assetId' in cover) resolveFilmCoverImagePath(db, run, body, cover);
  return cover;
}
