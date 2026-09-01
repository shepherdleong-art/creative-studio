/**
 * 生成视频的友好展示名（D5）。
 *
 * 命名模式：`<分镜/自由素材序号>-<来源图名>-<运镜模板或自定义>-V<版次>.mp4`
 * （示例：`01-LH122K3-B1-沙发-缓慢推近-V01.mp4`）。
 *
 * 红线：
 * - 展示名与物理身份分离：物理文件名（`video-<jobId>-<时间戳>.mp4`）与
 *   `video_jobs.localVideoPath` 永不变更，播放 URL 继续使用物理 `filename`；
 * - 名称不包含供应商、不包含绝对路径、不超过 {@link MAX_VIDEO_DISPLAY_NAME_LENGTH}；
 * - 新任务在创建事务内持久化 `displayName`；旧行（`displayName IS NULL/''`）
 *   读取时用同一套 helper 按 shot 序号、来源图名、模板名与 (createdAt, id)
 *   顺序确定性派生，不回写数据库。
 */
import type Database from 'better-sqlite3';
import { sanitizeFilenameBase } from './output-filenames.ts';
import { sqliteTimestampMs } from './project-job-order.ts';

/** 展示名最大总长度（含 `.mp4` 扩展名）。 */
export const MAX_VIDEO_DISPLAY_NAME_LENGTH = 120;

export const VIDEO_DISPLAY_NAME_EXTENSION = '.mp4';

export interface VideoDisplayNameInput {
  /** 分镜/自由素材在组内的序号（shots.indexNum，两种 shot_sets.kind 同格式）；shot 缺失时为 null。 */
  shotIndexNum: number | null;
  /** 来源图名（image_assets.filename，可传完整路径，helper 只取 basename）；缺失时为 null。 */
  sourceImageName: string | null;
  /** 运镜模板名；空/缺失回退「自定义」。 */
  templateName: string | null;
  /** 同一 shot 内按 (createdAt, id) 排序的 1-based 版次。 */
  versionNumber: number;
}

/** 清洗单个名称段：复用 sanitizeFilenameBase 的非法字符/空白/长度规则，再去掉首尾连接符，空值给中文回退。 */
function sanitizeVideoNameSegment(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const sanitized = sanitizeFilenameBase(value).replace(/^[-_]+|[-_]+$/g, '');
  // sanitizeFilenameBase 对空 basename 统一返回 'image'；清洗后为空同样视为缺失。
  return sanitized === 'image' || sanitized === '' ? fallback : sanitized;
}

function formatShotSegment(shotIndexNum: number | null): string {
  if (shotIndexNum == null || !Number.isFinite(shotIndexNum) || shotIndexNum < 0) return '素材';
  return String(Math.floor(shotIndexNum)).padStart(2, '0');
}

function formatVersionSegment(versionNumber: number): string {
  const version = Number.isFinite(versionNumber) && versionNumber >= 1 ? Math.floor(versionNumber) : 1;
  return `V${String(version).padStart(2, '0')}`;
}

/** 纯命名函数：所有展示名（持久化与派生）的唯一来源。 */
export function buildVideoDisplayName(input: VideoDisplayNameInput): string {
  const shotSegment = formatShotSegment(input.shotIndexNum);
  let sourceSegment = sanitizeVideoNameSegment(input.sourceImageName, '未命名图');
  let templateSegment = sanitizeVideoNameSegment(input.templateName, '自定义');
  const versionSegment = formatVersionSegment(input.versionNumber);
  const assemble = () => `${shotSegment}-${sourceSegment}-${templateSegment}-${versionSegment}${VIDEO_DISPLAY_NAME_EXTENSION}`;
  let name = assemble();
  if (name.length > MAX_VIDEO_DISPLAY_NAME_LENGTH) {
    // 超长时先压缩来源图名段，再压缩模板段；序号与版次段保持完整。
    const overflow = name.length - MAX_VIDEO_DISPLAY_NAME_LENGTH;
    if (sourceSegment.length > overflow + 1) {
      sourceSegment = sourceSegment.slice(0, sourceSegment.length - overflow);
      name = assemble();
    }
  }
  if (name.length > MAX_VIDEO_DISPLAY_NAME_LENGTH) {
    const overflow = name.length - MAX_VIDEO_DISPLAY_NAME_LENGTH;
    if (templateSegment.length > overflow + 1) {
      templateSegment = templateSegment.slice(0, templateSegment.length - overflow);
      name = assemble();
    }
  }
  return name;
}

// ── 创建侧：新任务在插入事务内计算版次与展示名 ──

/** 同一 shot 现有视频任务数（版次基数）。必须与插入在同一事务内调用。 */
export function countVideoJobsForShot(db: Database.Database, shotId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM video_jobs WHERE shotId = ?`).get(shotId) as { count: number };
  return Number(row.count) || 0;
}

export interface VideoJobCreationNameInput {
  shotId: string;
  sourceImageId: string;
  templateId: string | null;
  versionNumber: number;
}

/**
 * 创建视频任务时计算展示名。查询 shots / image_assets / video_prompt_templates
 * 的展示字段，不产生任何写入；调用方必须在同一事务内紧接着 INSERT。
 */
export function planVideoJobDisplayName(db: Database.Database, input: VideoJobCreationNameInput): string {
  const shot = db.prepare(`SELECT indexNum FROM shots WHERE id = ?`).get(input.shotId) as { indexNum?: number } | undefined;
  const image = db.prepare(`SELECT filename FROM image_assets WHERE id = ?`).get(input.sourceImageId) as { filename?: string } | undefined;
  const template = input.templateId
    ? db.prepare(`SELECT name FROM video_prompt_templates WHERE id = ?`).get(input.templateId) as { name?: string } | undefined
    : undefined;
  return buildVideoDisplayName({
    shotIndexNum: shot?.indexNum ?? null,
    sourceImageName: image?.filename ?? null,
    templateName: template?.name ?? null,
    versionNumber: input.versionNumber,
  });
}

// ── 读取侧：旧行确定性派生 ──

export interface VideoJobDisplayNameRow {
  id: string;
  shotSetId: string | null;
  shotId: string | null;
  sourceImageId: string | null;
  templateId: string | null;
  displayName: string | null;
  createdAt: string | null;
}

interface VideoJobVersionRankRow {
  id: string;
  shotSetId: string | null;
  shotId: string | null;
  createdAt: string | null;
}

function videoVersionGroupKey(row: Pick<VideoJobVersionRankRow, 'shotId' | 'shotSetId'>): string {
  return row.shotId ?? `orphan:${row.shotSetId ?? ''}`;
}

/**
 * 按同 shot（shotId 为空的按 shotSetId 归组）内 (createdAt, id) 升序计算 1-based 版次。
 * 时间字符串经 sqliteTimestampMs 归一化，兼容 ISO `T` 与 `datetime('now')` 空格两种格式。
 */
export function rankVideoJobVersions<T extends VideoJobVersionRankRow>(jobs: T[]): Map<string, number> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const key = videoVersionGroupKey(job);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  const versions = new Map<string, number>();
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aMs = sqliteTimestampMs(a.createdAt) ?? 0;
      const bMs = sqliteTimestampMs(b.createdAt) ?? 0;
      if (aMs !== bMs) return aMs - bMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    group.forEach((job, index) => versions.set(job.id, index + 1));
  }
  return versions;
}

/**
 * 解析一批视频任务的展示名：已持久化的 `displayName` 优先；缺失的旧行按
 * shot 序号、来源图名、模板名与 (createdAt, id) 版次确定性派生，不回写数据库。
 * 视频生成 API、Mixcut context、批量 catalog 共用本函数，保证同一派生名称。
 */
export function resolveVideoJobDisplayNames(
  db: Database.Database,
  videoJobIds: Array<string>,
): Map<string, string> {
  const result = new Map<string, string>();
  const ids = [...new Set(videoJobIds.filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return result;

  const targetPlaceholders = ids.map(() => '?').join(', ');
  const targets = db.prepare(`
    SELECT id, shotSetId, shotId, sourceImageId, templateId, displayName, createdAt
    FROM video_jobs
    WHERE id IN (${targetPlaceholders})
  `).all(...ids) as VideoJobDisplayNameRow[];
  for (const row of targets) {
    if (typeof row.displayName === 'string' && row.displayName.trim()) {
      result.set(row.id, row.displayName.trim());
    }
  }
  const pending = targets.filter((row) => !result.has(row.id));
  if (pending.length === 0) return result;

  // 版次要按同 shot 的全部任务排名（含 pending/failed），不只看当前这批。
  const shotIds = [...new Set(pending.map((row) => row.shotId).filter((id): id is string => Boolean(id)))];
  const orphanShotSetIds = [...new Set(
    pending.filter((row) => !row.shotId).map((row) => row.shotSetId).filter((id): id is string => Boolean(id)),
  )];
  const siblings: VideoJobVersionRankRow[] = [];
  if (shotIds.length > 0) {
    const placeholders = shotIds.map(() => '?').join(', ');
    siblings.push(...db.prepare(`
      SELECT id, shotSetId, shotId, createdAt FROM video_jobs WHERE shotId IN (${placeholders})
    `).all(...shotIds) as VideoJobVersionRankRow[]);
  }
  if (orphanShotSetIds.length > 0) {
    const placeholders = orphanShotSetIds.map(() => '?').join(', ');
    siblings.push(...db.prepare(`
      SELECT id, shotSetId, shotId, createdAt FROM video_jobs WHERE shotId IS NULL AND shotSetId IN (${placeholders})
    `).all(...orphanShotSetIds) as VideoJobVersionRankRow[]);
  }
  const versions = rankVideoJobVersions(siblings);

  // 展示字段查表：shots.indexNum / image_assets.filename / video_prompt_templates.name。
  const lookupIds = <T extends string>(values: Array<T | null | undefined>): Array<T> =>
    [...new Set(values.filter((value): value is T => Boolean(value)))];
  const shotLookupIds = lookupIds(pending.map((row) => row.shotId));
  const imageLookupIds = lookupIds(pending.map((row) => row.sourceImageId));
  const templateLookupIds = lookupIds(pending.map((row) => row.templateId));

  const shotIndexById = new Map<string, number>();
  if (shotLookupIds.length > 0) {
    const placeholders = shotLookupIds.map(() => '?').join(', ');
    for (const row of db.prepare(`SELECT id, indexNum FROM shots WHERE id IN (${placeholders})`).all(...shotLookupIds) as Array<{ id: string; indexNum: number }>) {
      shotIndexById.set(row.id, Number(row.indexNum));
    }
  }
  const imageFilenameById = new Map<string, string>();
  if (imageLookupIds.length > 0) {
    const placeholders = imageLookupIds.map(() => '?').join(', ');
    for (const row of db.prepare(`SELECT id, filename FROM image_assets WHERE id IN (${placeholders})`).all(...imageLookupIds) as Array<{ id: string; filename: string }>) {
      imageFilenameById.set(row.id, row.filename);
    }
  }
  const templateNameById = new Map<string, string>();
  if (templateLookupIds.length > 0) {
    const placeholders = templateLookupIds.map(() => '?').join(', ');
    for (const row of db.prepare(`SELECT id, name FROM video_prompt_templates WHERE id IN (${placeholders})`).all(...templateLookupIds) as Array<{ id: string; name: string }>) {
      templateNameById.set(row.id, row.name);
    }
  }

  for (const row of pending) {
    result.set(row.id, buildVideoDisplayName({
      shotIndexNum: row.shotId ? shotIndexById.get(row.shotId) ?? null : null,
      sourceImageName: row.sourceImageId ? imageFilenameById.get(row.sourceImageId) ?? null : null,
      templateName: row.templateId ? templateNameById.get(row.templateId) ?? null : null,
      versionNumber: versions.get(row.id) ?? 1,
    }));
  }
  return result;
}
