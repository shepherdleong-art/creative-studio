import type Database from 'better-sqlite3';

/** 冻结的 BGM 池条目:身份 + 受管相对路径 + 内容指纹,全部在锁定时快照。 */
export interface BatchBgmPoolEntry {
  trackId: string;
  relativePath: string;
  fileFingerprint: string;
}

export const BATCH_MUSIC_POOL_KEY = 'batchMusicPool';

/**
 * 读取当前可用曲库(与单条模式共用 storage/bgm/ 与 final_edit_bgm_tracks)。
 * 曲库表不存在(旧库尚未初始化)时按空曲库处理,由调用方决定是否拦截启动。
 */
export function readBatchBgmPool(db: Database.Database): BatchBgmPoolEntry[] {
  try {
    const rows = db.prepare(`
      SELECT id AS trackId, relativePath, fileFingerprint
      FROM final_edit_bgm_tracks
      WHERE status = 'ready'
      ORDER BY relativePath, id
    `).all() as Array<{ trackId: string; relativePath: string; fileFingerprint: string }>;
    return rows.filter((row) => (
      row.trackId && row.relativePath && row.fileFingerprint
    ));
  } catch {
    return [];
  }
}

/**
 * 把锁定时刻的曲库池冻结进批次版本的 defaultsJson。之后所有分配/重分配
 * 都只读这份冻结池,曲库后续增减不会改变已锁定批次的 BGM 分配。
 */
export function freezeBatchMusicPool(
  db: Database.Database,
  batchVersionId: string,
  pool: BatchBgmPoolEntry[],
): void {
  db.prepare(`
    UPDATE batch_production_versions
    SET defaultsJson = json_set(defaultsJson, ?, json(?))
    WHERE id = ?
  `).run(`$.${BATCH_MUSIC_POOL_KEY}`, JSON.stringify(pool), batchVersionId);
}

/** 从冻结的 defaultsJson 解析曲库池;没有冻结池时返回空数组。 */
export function readFrozenMusicPool(defaultsJson: unknown): BatchBgmPoolEntry[] {
  if (!defaultsJson || typeof defaultsJson !== 'object' || Array.isArray(defaultsJson)) return [];
  const pool = (defaultsJson as Record<string, unknown>)[BATCH_MUSIC_POOL_KEY];
  if (!Array.isArray(pool)) return [];
  return pool.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const trackId = typeof record.trackId === 'string' ? record.trackId : '';
    const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
    const fileFingerprint = typeof record.fileFingerprint === 'string' ? record.fileFingerprint : '';
    return trackId && relativePath && fileFingerprint
      ? [{ trackId, relativePath, fileFingerprint }]
      : [];
  });
}
