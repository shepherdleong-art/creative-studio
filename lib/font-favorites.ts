import type Database from 'better-sqlite3';
import { fontIdentity, normalizeFavorites } from './media-core/font-identity.ts';

export function listFontFavorites(db: Database.Database, ownerUserId?: string): string[] {
  const table = ownerUserId ? 'team_font_favorites' : 'font_favorites';
  const where = ownerUserId ? 'AND userId = ?' : '';
  const params = ownerUserId ? [ownerUserId] : [];
  return (db.prepare(`SELECT family FROM ${table} WHERE favorite = 1 ${where} ORDER BY updatedAt DESC, identity`).all(...params) as Array<{ family: string }>).map((row) => row.family);
}

export function isFontFamily(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function importFontFavorites(db: Database.Database, families: string[], ownerUserId?: string): string[] {
  return db.transaction(() => {
    const table = ownerUserId ? 'team_font_favorites' : 'font_favorites';
    const where = ownerUserId ? 'WHERE userId = ?' : '';
    const params = ownerUserId ? [ownerUserId] : [];
    const row = db.prepare(`SELECT MIN(updatedAt) AS oldest FROM ${table} ${where}`).get(...params) as { oldest: number | null };
    const start = row.oldest ?? Date.now();
    const insert = ownerUserId
      ? db.prepare('INSERT OR IGNORE INTO team_font_favorites (userId, identity, family, favorite, updatedAt) VALUES (?, ?, ?, 1, ?)')
      : db.prepare('INSERT OR IGNORE INTO font_favorites (identity, family, favorite, updatedAt) VALUES (?, ?, 1, ?)');
    normalizeFavorites(families).forEach((family, index) => {
      if (ownerUserId) insert.run(ownerUserId, fontIdentity(family), family, start - index - 1);
      else insert.run(fontIdentity(family), family, start - index - 1);
    });
    return listFontFavorites(db, ownerUserId);
  }).immediate();
}

export function setFontFavorite(db: Database.Database, family: string, favorite: boolean, ownerUserId?: string): string[] {
  return db.transaction(() => {
    const table = ownerUserId ? 'team_font_favorites' : 'font_favorites';
    const where = ownerUserId ? 'WHERE userId = ?' : '';
    const params = ownerUserId ? [ownerUserId] : [];
    const row = db.prepare(`SELECT MAX(updatedAt) AS newest FROM ${table} ${where}`).get(...params) as { newest: number | null };
    const updatedAt = Math.max(Date.now(), (row.newest ?? 0) + 1);
    if (ownerUserId) {
      db.prepare(`INSERT INTO team_font_favorites (userId, identity, family, favorite, updatedAt) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(userId, identity) DO UPDATE SET family = excluded.family, favorite = excluded.favorite, updatedAt = excluded.updatedAt
        WHERE team_font_favorites.favorite <> excluded.favorite`).run(
        ownerUserId, fontIdentity(family), family.trim(), Number(favorite), updatedAt,
      );
    } else {
      db.prepare(`INSERT INTO font_favorites (identity, family, favorite, updatedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET family = excluded.family, favorite = excluded.favorite, updatedAt = excluded.updatedAt
        WHERE font_favorites.favorite <> excluded.favorite`).run(
        fontIdentity(family), family.trim(), Number(favorite), updatedAt,
      );
    }
    return listFontFavorites(db, ownerUserId);
  }).immediate();
}
