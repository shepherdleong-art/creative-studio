import type Database from 'better-sqlite3';

/** 冻结的 BGM 池条目:身份 + 受管相对路径 + 内容指纹,全部在锁定时快照。 */
export interface BatchBgmPoolEntry {
  trackId: string;
  relativePath: string;
  fileFingerprint: string;
  durationUs: number;
}

/** 曲库列表项(UI 展示与手动指定用)。 */
export interface BatchBgmTrackView {
  id: string;
  relativePath: string;
  filename: string;
  durationUs: number;
}

export const BATCH_MUSIC_POOL_KEY = 'batchMusicPool';
export const BATCH_MUSIC_SELECTION_KEY = 'batchMusicSelection';

/**
 * 读取当前可用曲库(与单条模式共用 storage/bgm/ 与 final_edit_bgm_tracks)。
 * 曲库表不存在(旧库尚未初始化)时按空曲库处理,由调用方决定是否拦截启动。
 */
export function readBatchBgmPool(db: Database.Database): BatchBgmPoolEntry[] {
  try {
    const rows = db.prepare(`
      SELECT id AS trackId, relativePath, fileFingerprint, durationUs
      FROM final_edit_bgm_tracks
      WHERE status = 'ready'
      ORDER BY relativePath, id
    `).all() as Array<{ trackId: string; relativePath: string; fileFingerprint: string; durationUs: number }>;
    return rows.filter((row) => (
      row.trackId && row.relativePath && row.fileFingerprint
    ));
  } catch {
    return [];
  }
}

/** 曲库列表视图:文件名从相对路径推导,供 UI 展示与手动指定。 */
export function listBatchBgmTracks(db: Database.Database): BatchBgmTrackView[] {
  return readBatchBgmPool(db).map(({ trackId, relativePath, durationUs }) => ({
    id: trackId,
    relativePath,
    filename: relativePath.split(/[\\/]/).filter(Boolean).at(-1) || relativePath,
    durationUs,
  }));
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
      ? [{ trackId, relativePath, fileFingerprint, durationUs: Number(record.durationUs) || 0 }]
      : [];
  });
}

export interface BatchMusicSelection {
  mode: 'auto' | 'manual';
  trackIds: string[];
}

/** 从 defaultsJson 解析手动 BGM 指定;缺省为全库自动。 */
export function readBatchMusicSelection(defaultsJson: unknown): BatchMusicSelection {
  if (!defaultsJson || typeof defaultsJson !== 'object' || Array.isArray(defaultsJson)) {
    return { mode: 'auto', trackIds: [] };
  }
  const raw = (defaultsJson as Record<string, unknown>)[BATCH_MUSIC_SELECTION_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mode: 'auto', trackIds: [] };
  const record = raw as Record<string, unknown>;
  const mode = record.mode === 'manual' ? 'manual' : 'auto';
  const trackIds = Array.isArray(record.trackIds)
    ? record.trackIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
  return { mode, trackIds };
}

/**
 * 分配用的曲目范围:手动指定时只在冻结池 ∩ 指定范围内取,
 * 自动模式用整个冻结池。冻结池是权威(曲目在锁定时已快照)。
 */
export function resolveAllocationMusicTrackIds(defaultsJson: unknown): string[] {
  const selection = readBatchMusicSelection(defaultsJson);
  const poolIds = new Set(readFrozenMusicPool(defaultsJson).map(({ trackId }) => trackId));
  const requested = selection.mode === 'manual' ? selection.trackIds.filter((id) => poolIds.has(id)) : [];
  return requested.length > 0 ? requested : [...poolIds];
}
