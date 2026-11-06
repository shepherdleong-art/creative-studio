import type Database from 'better-sqlite3';
import { ensureMediaProviderPool } from './media-provider-pool.ts';

/** Share upstream capacity with the regular image/video queues, including aliases. */
export function configuredProviderPool(db: Database.Database, kind: 'image' | 'video', providerId: string): string | null {
  const table = kind === 'image' ? 'providers' : 'video_providers';
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return null;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(providerId) as {
    baseUrl: string; apiKey: string; type: string; accessKey?: string; secretKey?: string;
  } | undefined;
  if (!row) return null;
  const credential = kind === 'video' && row.type === 'kling'
    ? `${(row.accessKey ?? '').trim()}\0${(row.secretKey ?? '').trim()}` : row.apiKey ?? '';
  return ensureMediaProviderPool(db, row.baseUrl ?? '', credential);
}
