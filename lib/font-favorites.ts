import type Database from 'better-sqlite3';
import { fontIdentity, normalizeFavorites } from './media-core/font-identity.ts';

export function listFontFavorites(db: Database.Database): string[] {
  return (db.prepare('SELECT family FROM font_favorites WHERE favorite = 1 ORDER BY updatedAt DESC, identity').all() as Array<{ family: string }>).map((row) => row.family);
}

export function isFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function importFontFavorites(db: Database.Database, families: string[]): string[] {
  return db.transaction(() => {
    const row = db.prepare('SELECT MIN(updatedAt) AS oldest FROM font_favorites').get() as { oldest: number | null };
    const start = row.oldest ?? Date.now();
    const insert = db.prepare('INSERT OR IGNORE INTO font_favorites (identity, family, favorite, updatedAt) VALUES (?, ?, 1, ?)');
    normalizeFavorites(families).forEach((family, index) => insert.run(fontIdentity(family), family, start - index - 1));
    return listFontFavorites(db);
  }).immediate();
}

export function setFontFavorite(db: Database.Database, family: string, favorite: boolean): string[] {
  return db.transaction(() => {
    const row = db.prepare('SELECT MAX(updatedAt) AS newest FROM font_favorites').get() as { newest: number | null };
    db.prepare(`INSERT INTO font_favorites (identity, family, favorite, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(identity) DO UPDATE SET family = excluded.family, favorite = excluded.favorite, updatedAt = excluded.updatedAt
      WHERE font_favorites.favorite <> excluded.favorite`).run(
      fontIdentity(family), family.trim(), Number(favorite), Math.max(Date.now(), (row.newest ?? 0) + 1),
    );
    return listFontFavorites(db);
  }).immediate();
}
