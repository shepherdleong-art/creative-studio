import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { probeDurationSec } from '../ffmpeg.ts';

export const BGM_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
export interface ScannedBgmTrack { id: string; relativePath: string; fileFingerprint: string; durationUs: number }

/** 单条与批量共用曲库。失效记录退出 ready 列表，历史身份保留以供恢复和冻结产物核验。 */
export async function scanBgmTracks(db: Database.Database, storageRoot: string): Promise<ScannedBgmTrack[]> {
  const previous = db.prepare("SELECT id,relativePath,fileFingerprint,scannedAt FROM final_edit_bgm_tracks WHERE status='ready'")
    .all() as Array<{ id: string; relativePath: string; fileFingerprint: string; scannedAt: string }>;
  const root = path.join(storageRoot, 'bgm');
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (BGM_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  // 枚举失败时直接报错，不拿不完整的文件清单清退旧曲目。
  if (fs.existsSync(root)) visit(root);
  const result: ScannedBgmTrack[] = [];
  for (const file of files.sort()) {
    try {
      const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const relativePath = path.relative(storageRoot, file).split(path.sep).join('/');
      const durationUs = Math.round(await probeDurationSec(file) * 1_000_000);
      const candidateId = fingerprint.slice(0, 32);
      db.prepare(`INSERT INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, scannedAt) VALUES (?, ?, ?, ?, ?, 'ready', ?) ON CONFLICT(fileFingerprint) DO UPDATE SET relativePath=excluded.relativePath, durationUs=excluded.durationUs, format=excluded.format, status='ready', errorMessage=NULL, scannedAt=excluded.scannedAt`)
        .run(candidateId, relativePath, fingerprint, durationUs, path.extname(file).slice(1).toLowerCase(), new Date().toISOString());
      const authoritative = db.prepare(`SELECT id, relativePath, fileFingerprint, durationUs FROM final_edit_bgm_tracks
        WHERE fileFingerprint=? AND status='ready'`).get(fingerprint) as ScannedBgmTrack | undefined;
      if (!authoritative) throw new Error('BGM 扫描结果未能写入索引');
      result.push(authoritative);
    } catch (error) {
      const fingerprint = crypto.createHash('sha256').update(file).digest('hex');
      db.prepare(`INSERT OR REPLACE INTO final_edit_bgm_tracks (id, relativePath, fileFingerprint, durationUs, format, status, errorMessage, scannedAt) VALUES (?, ?, ?, 0, ?, 'failed', ?, ?)`)
        .run(fingerprint.slice(0, 32), path.relative(storageRoot, file).split(path.sep).join('/'), fingerprint, path.extname(file).slice(1), error instanceof Error ? error.message : String(error), new Date().toISOString());
    }
  }
  const readyIds = new Set(result.map(track => track.id));
  db.transaction(() => {
    const retire = db.prepare(`UPDATE final_edit_bgm_tracks SET status='failed', errorMessage=?
      WHERE id=? AND status='ready' AND relativePath=? AND fileFingerprint=? AND scannedAt=?`);
    for (const row of previous) {
      if (readyIds.has(row.id)) continue;
      // 扫描期间另一次导入/扫描更新的条目不由本次旧快照清退。
      retire.run('音乐文件已移走、被替换或无法读取，请恢复文件后重新扫描。', row.id, row.relativePath, row.fileFingerprint, row.scannedAt);
    }
  }).immediate();
  return result;
}
