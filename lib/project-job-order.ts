/**
 * 场景结果（图片 jobs）的稳定排序（D4）。
 *
 * 排序规则只在这里实现一次，服务端读取路由使用，前端 ResultGallery 保留入参顺序：
 * - 有 `createdAt` 的任务：时间降序（最新创建批次在前），同一次创建请求内按
 *   `creationIndex` 升序（用户提交顺序从左到右），再用 `creationSequence`
 *   （rowid 投影）稳定打破平局；
 * - 没有 `createdAt` 的历史行：优先用旧 `submittedAt/startedAt/finishedAt`
 *   （取第一个可用值）降序，最后按 `creationSequence` 降序兜底。
 * - 任务状态、供应商完成速度、UUID 一律不参与排序；轮询刷新只更新状态，
 *   不改变位置。
 *
 * SQLite 时间字符串同时存在 ISO `T` 与历史 `datetime('now')` 空格两种格式，
 * 比较前统一归一化，不依赖两种字符串的字典序。
 */

export interface ProjectJobOrderRow {
  id: string;
  createdAt?: string | null;
  creationIndex?: number | null;
  /** 仅用于历史兼容的 rowid 投影；不是任务身份。 */
  creationSequence?: number | null;
  submittedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/** 归一化 SQLite 时间字符串为毫秒时间戳；空值或无法解析返回 null。 */
export function sqliteTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let normalized = value.trim();
  if (!normalized.includes('T')) normalized = normalized.replace(' ', 'T');
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized = `${normalized}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function legacyTimestampMs(row: ProjectJobOrderRow): number | null {
  return sqliteTimestampMs(row.submittedAt)
    ?? sqliteTimestampMs(row.startedAt)
    ?? sqliteTimestampMs(row.finishedAt);
}

export function compareProjectJobsByCreation(a: ProjectJobOrderRow, b: ProjectJobOrderRow): number {
  const aCreated = sqliteTimestampMs(a.createdAt);
  const bCreated = sqliteTimestampMs(b.createdAt);
  if (aCreated != null || bCreated != null) {
    if (aCreated != null && bCreated != null && aCreated !== bCreated) return bCreated - aCreated;
    if (aCreated != null && bCreated == null) return -1;
    if (aCreated == null && bCreated != null) return 1;
    // 同一次创建请求（同一 createdAt）：creationIndex 升序，creationSequence 稳定打破平局。
    const aIndex = a.creationIndex ?? 0;
    const bIndex = b.creationIndex ?? 0;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return (a.creationSequence ?? 0) - (b.creationSequence ?? 0);
  }
  // 历史行：旧时间列（submittedAt → startedAt → finishedAt）降序，creationSequence 降序兜底。
  const aLegacy = legacyTimestampMs(a);
  const bLegacy = legacyTimestampMs(b);
  if (aLegacy != null && bLegacy != null && aLegacy !== bLegacy) return bLegacy - aLegacy;
  if (aLegacy != null && bLegacy == null) return -1;
  if (aLegacy == null && bLegacy != null) return 1;
  return (b.creationSequence ?? 0) - (a.creationSequence ?? 0);
}

/** 就地稳定排序：返回同一数组引用，便于服务端路由直接落 JSON。 */
export function sortProjectJobsByCreation<T extends ProjectJobOrderRow>(rows: T[]): T[] {
  return rows.sort(compareProjectJobsByCreation);
}
