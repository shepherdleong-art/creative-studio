import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { probeDurationSec } from '../ffmpeg.ts';
import type { FinalEditBgmTrackView } from './types.ts';

export const FINAL_EDIT_BGM_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
]);

export async function scanFinalEditBgm(db: Database.Database, storageRoot: string) {
  const root = path.join(storageRoot, 'bgm');
  if (!fs.existsSync(root)) return [] as Array<{ id: string; relativePath: string; fileFingerprint: string; durationUs: number }>;
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (FINAL_EDIT_BGM_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  visit(root);
  const result: Array<{ id: string; relativePath: string; fileFingerprint: string; durationUs: number }> = [];
  for (const file of files.sort()) {
    try {
      const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const relativePath = path.relative(storageRoot, file).split(path.sep).join('/');
      const durationUs = Math.round(await probeDurationSec(file) * 1_000_000);
      const candidateId = fingerprint.slice(0, 32);
      db.prepare(`INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt) VALUES (?, ?, ?, ?, ?, 'ready', ?) ON CONFLICT(fileFingerprint) DO UPDATE SET relativePath=excluded.relativePath, durationUs=excluded.durationUs, format=excluded.format, status='ready', errorMessage=NULL, scannedAt=excluded.scannedAt`).run(candidateId, relativePath, fingerprint, durationUs, path.extname(file).slice(1).toLowerCase(), new Date().toISOString());
      const authoritative = db.prepare(`
        SELECT id, relativePath, fileFingerprint, durationUs
        FROM final_edit_bgm_tracks
        WHERE fileFingerprint=? AND status='ready'
      `).get(fingerprint) as { id: string; relativePath: string; fileFingerprint: string; durationUs: number } | undefined;
      if (!authoritative) throw new Error('BGM 扫描结果未能写入索引');
      result.push(authoritative);
    } catch (error) {
      const fingerprint = crypto.createHash('sha256').update(file).digest('hex');
      db.prepare(`INSERT OR REPLACE INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, errorMessage, scannedAt) VALUES (?, ?, ?, 0, ?, 'failed', ?, ?)`).run(fingerprint.slice(0, 32), path.relative(storageRoot, file).split(path.sep).join('/'), fingerprint, path.extname(file).slice(1), error instanceof Error ? error.message : String(error), new Date().toISOString());
    }
  }
  return result;
}

export function finalEditBgmFilename(relativePath: string): string {
  return relativePath.split(/[\\/]/).filter(Boolean).at(-1) || relativePath;
}

export function listReadyFinalEditBgmTracks(
  db: Database.Database,
): FinalEditBgmTrackView[] {
  const rows = db.prepare(`
    SELECT id, relativePath, durationUs
    FROM final_edit_bgm_tracks
    WHERE status='ready'
    ORDER BY relativePath
  `).all() as Array<{
    id: string;
    relativePath: string;
    durationUs: number;
  }>;
  return rows.map((row) => ({
    ...row,
    filename: finalEditBgmFilename(row.relativePath),
  }));
}
