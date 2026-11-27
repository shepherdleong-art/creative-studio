import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { authorizeManagedFileRead, requireAccessContext } from '../media-core/access-context.ts';
import { filmStoragePath } from './composition.ts';
import type { FilmBody } from './composition.ts';
import { parseFilmCoverMedia, type FilmCoverMedia } from './cover-media.ts';
import { OneClickFilmError } from './errors.ts';
import type { OneClickFilmRun } from './store.ts';
import { resolveGeneratedFilmCoverPath } from './cover-assets.ts';

export function unavailableFilmCoverImage() {
  return new OneClickFilmError('invalid_input', '当前封面图片不可用');
}

export function resolveProjectCoverImagePath(db: Database.Database, projectId: string, assetId: string): string {
  try {
    if (!/^[a-z\d_-]{1,160}$/i.test(assetId)) throw unavailableFilmCoverImage();
    const access = requireAccessContext();
    access.assertAccess('project', projectId, 'read');
    const image = db.prepare(`
      SELECT COALESCE(NULLIF(originalPath, ''), path) AS path FROM image_assets
      WHERE id = ? AND projectId = ? AND role = 'input' AND usage IN ('scene_seed', 'detail_page')
    `).get(assetId, projectId) as { path: string } | undefined;
    if (!image) throw unavailableFilmCoverImage();
    access.assertAccess('image', assetId, 'read');
    const file = filmStoragePath(image.path);
    authorizeManagedFileRead(file);
    if (!fs.statSync(file).isFile()) throw unavailableFilmCoverImage();
    fs.accessSync(file, fs.constants.R_OK);
    return file;
  } catch {
    throw unavailableFilmCoverImage();
  }
}

export function resolveFilmCoverImagePath(
  db: Database.Database, run: OneClickFilmRun, body: FilmBody, cover: Extract<FilmCoverMedia, { assetId: string }>,
): string {
  if (cover.kind === 'project_image') return resolveProjectCoverImagePath(db, run.projectId, cover.assetId);
  try {
    const file = resolveGeneratedFilmCoverPath(db, run, body.entryId, cover.assetId);
    if (file) return file;
  } catch {
    throw unavailableFilmCoverImage();
  }
  throw unavailableFilmCoverImage();
}

export function validateFilmCoverSelection(db: Database.Database, run: OneClickFilmRun, body: FilmBody, value: unknown,
  inactiveSavedCover?: FilmCoverMedia) {
  if (value == null) return undefined;
  const cover = parseFilmCoverMedia(value);
  if (!cover) throw new OneClickFilmError('invalid_input', '封面底图配置无效');
  if ('assetId' in cover && !(inactiveSavedCover?.kind === cover.kind && inactiveSavedCover.assetId === cover.assetId)) {
    resolveFilmCoverImagePath(db, run, body, cover);
  }
  return cover;
}
