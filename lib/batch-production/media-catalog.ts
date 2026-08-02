import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { probeVideoMedia, type VideoMediaProbe } from '../ffmpeg.ts';
import { assertNoStorageSymlink, resolveStoragePath, toStorageRelativePath } from '../final-edit/storage-path.ts';
import {
  isDetectedVideoContainerCompatible,
  SUPPORTED_VIDEO_MIME_BY_EXTENSION,
} from '../video-file-format.ts';
import {
  createAsset,
  syncAssetStatusFromSources,
  type BatchAssetSourceKind,
} from './assets.ts';

export type BatchAssetSourceHealth = 'healthy' | 'offline' | 'changed';

/** 模块 4 产物来源的权威定位(可判别结构,不靠字段名猜测) */
export interface Module4SourceLocation {
  kind: 'module4';
  videoJobId: string;
  shotSetId: string;
  /** 相对 storageRoot 的受控产物路径(与 video_jobs.localVideoPath 一致) */
  relativePath: string;
}

/** 项目托管副本来源的权威定位:相对 dataRoot() 的受控路径 */
export interface ManagedSourceLocation {
  kind: 'managed';
  /** 相对 dataRoot() 的受控路径 */
  relativePath: string;
}

/** 用户原文件链接来源的权威定位:用户文件绝对路径 */
export interface LinkedSourceLocation {
  kind: 'linked';
  /** 用户文件绝对路径(项目永不删除、移动、改写该文件) */
  absolutePath: string;
}

export type BatchAssetSourceLocation = Module4SourceLocation | ManagedSourceLocation | LinkedSourceLocation;

export interface BatchAssetSourceRow {
  id: string;
  assetId: string;
  sourceKind: BatchAssetSourceKind;
  locationJson: string;
  health: BatchAssetSourceHealth;
  createdAt: string;
}

/** 来源视图:locationJson 已解析为可判别结构 */
export interface BatchAssetSourceView {
  id: string;
  assetId: string;
  sourceKind: BatchAssetSourceKind;
  locationJson: BatchAssetSourceLocation;
  health: BatchAssetSourceHealth;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

export function storageRootOf(): string {
  return path.join(dataRoot(), 'storage');
}

function managedRelativeDirectory(projectId: string): string {
  return path.join('storage', 'batch-media', projectId);
}

/** 完整内容核验:顺序读取整个文件计算 SHA-256(V1 的正确性基准)。 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/** 校验文件扩展名、普通文件属性和真实视频容器。 */
async function inspectVideoFile(filePath: string): Promise<VideoMediaProbe> {
  if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()]) {
    throw new Error('仅支持 MP4、MOV、AVI、WebM 视频文件');
  }
  if (!existsSync(filePath)) {
    throw new Error('文件不存在');
  }
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('文件不是安全的普通文件');
  }
  const media = await probeVideoMedia(filePath);
  if (media.errorMessage || media.durationUs <= 0 || media.width <= 0 || media.height <= 0) {
    throw new Error('无法读取视频容器或媒体信息');
  }
  if (!isDetectedVideoContainerCompatible(filePath, media.format)) {
    throw new Error('视频内容与文件扩展名不一致');
  }
  return media;
}

/** 素材库路径安全:防 `..`、越界与符号链接(与单条混剪共用同一套规则) */
function resolveSafeDataRootPath(relativePath: string): string {
  const resolved = resolveStoragePath(dataRoot(), relativePath);
  assertNoStorageSymlink(dataRoot(), relativePath);
  return resolved;
}

function resolveSafeStoragePath(relativeOrAbsolute: string): string {
  const storageRoot = storageRootOf();
  const resolved = resolveStoragePath(storageRoot, relativeOrAbsolute, { allowAbsolute: true });
  assertNoStorageSymlink(storageRoot, relativeOrAbsolute, { allowAbsolute: true });
  return resolved;
}

/** 把来源位置解析成文件系统绝对路径(按可判别 kind,不猜测) */
export function resolveSourceFilePath(location: BatchAssetSourceLocation): string {
  switch (location.kind) {
    case 'module4':
      return resolveSafeStoragePath(location.relativePath);
    case 'managed':
      return resolveSafeDataRootPath(location.relativePath);
    case 'linked':
      return location.absolutePath;
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 兼容已发布 v10（没有 kind 字段）的来源位置，并输出当前判别结构。 */
function parseSourceLocation(sourceKind: BatchAssetSourceKind, locationJson: string): BatchAssetSourceLocation {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(locationJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // 损坏位置会归一为空路径，并在健康核验时标记 offline。
  }
  if (sourceKind === 'module4') {
    return {
      kind: 'module4',
      videoJobId: stringField(raw.videoJobId) ?? '',
      shotSetId: stringField(raw.shotSetId) ?? '',
      relativePath: stringField(raw.relativePath) ?? '',
    };
  }
  if (sourceKind === 'managed') {
    const relativePath = stringField(raw.relativePath) ?? '';
    // v10 的 managedRoot 由调用方传入，但正式约定是 dataRoot()/storage/batch-media；
    // 当时只保存了相对该根的 projectId/filename。带 kind 的新数据则已经保存
    // 相对 dataRoot() 的完整路径，不能再次补前缀。
    return {
      kind: 'managed',
      relativePath: raw.kind === 'managed'
        ? relativePath
        : path.join('storage', 'batch-media', relativePath),
    };
  }
  return { kind: 'linked', absolutePath: stringField(raw.absolutePath) ?? '' };
}

function sourceLocationKey(location: BatchAssetSourceLocation): string {
  if (location.kind === 'module4') return `module4:${location.videoJobId}`;
  if (location.kind === 'managed') return `managed:${path.normalize(location.relativePath)}`;
  return `linked:${path.resolve(location.absolutePath)}`;
}

function insertSource(
  db: Database.Database,
  assetId: string,
  sourceKind: BatchAssetSourceKind,
  location: BatchAssetSourceLocation,
  createdAt: string,
): void {
  const locationJson = JSON.stringify(location);
  const existing = db.prepare(`
    SELECT id FROM batch_asset_sources WHERE assetId = ? AND sourceKind = ? AND locationJson = ?
  `).get(assetId, sourceKind, locationJson) as { id: string } | undefined;
  if (existing) {
    return;
  }
  const legacyMatch = (db.prepare(`
    SELECT id, locationJson FROM batch_asset_sources WHERE assetId = ? AND sourceKind = ?
  `).all(assetId, sourceKind) as Array<{ id: string; locationJson: string }>).find((row) => (
    sourceLocationKey(parseSourceLocation(sourceKind, row.locationJson)) === sourceLocationKey(location)
  ));
  if (legacyMatch) {
    db.prepare(`
      UPDATE batch_asset_sources SET locationJson = ?, health = 'healthy' WHERE id = ?
    `).run(locationJson, legacyMatch.id);
    return;
  }
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES (?, ?, ?, ?, 'healthy', ?)
  `).run(randomUUID(), assetId, sourceKind, locationJson, createdAt);
}

/**
 * 按内容指纹复用素材身份并追加来源。同项目同指纹只建一份素材;
 * 重复来源(相同 kind + 位置)幂等返回,不新增行、不触发 UNIQUE 冲突。
 */
function resolveAssetId(
  db: Database.Database,
  projectId: string,
  sourceKind: BatchAssetSourceKind,
  location: BatchAssetSourceLocation,
  /** 完整 SHA-256(hex),由调用方在事务外计算 */
  fingerprint: string,
  mediaJson: unknown,
  createdAt: string,
): string {
  return db.transaction(() => {
    const assetId = createAsset(db, {
      projectId,
      sourceKind,
      locationJson: location,
      contentFingerprint: `sha256:${fingerprint}`,
      mediaKind: 'video',
      mediaJson,
      now: () => new Date(createdAt),
    });
    insertSource(db, assetId, sourceKind, location, createdAt);
    return assetId;
  }).immediate();
}

interface Module4VideoJobRow {
  id: string;
  projectId: string;
  shotSetId: string | null;
  status: string;
  localVideoPath: string | null;
  filename: string | null;
}

/**
 * 登记第 4 步成功视频为项目素材(模块 4 Adapter)。
 * 只信任数据库记录:videoJobId 必须存在、属于该项目、处于成功状态;
 * shotSetId、产物路径全部以记录为准,不允许调用方伪造或跨项目/跨分镜组。
 * 只引用现有产物文件,不复制、不移动、不越权删除模块 4 文件。
 */
export async function registerModule4Video(
  db: Database.Database,
  input: { videoJobId: string },
): Promise<{ assetId: string; projectId: string }> {
  const row = db.prepare(`
    SELECT id, projectId, shotSetId, status, localVideoPath, filename
    FROM video_jobs WHERE id = ?
  `).get(input.videoJobId) as Module4VideoJobRow | undefined;
  if (!row) {
    throw new Error('视频任务不存在');
  }
  if (row.status !== 'succeeded') {
    throw new Error('视频任务尚未成功,不能登记为素材');
  }
  if (!row.localVideoPath) {
    throw new Error('视频任务没有产物文件');
  }
  if (!row.shotSetId) {
    throw new Error('视频任务没有分镜组归属');
  }
  const shotSet = db.prepare(`
    SELECT 1 FROM shot_sets WHERE id = ? AND projectId = ?
  `).get(row.shotSetId, row.projectId);
  if (!shotSet) {
    throw new Error('视频任务的分镜组不属于当前项目');
  }
  const absolutePath = resolveSafeStoragePath(row.localVideoPath);
  const media = await inspectVideoFile(absolutePath);
  const createdAt = nowIso();
  const fingerprint = await computeFileSha256(absolutePath);
  const location: Module4SourceLocation = {
    kind: 'module4',
    videoJobId: row.id,
    shotSetId: row.shotSetId,
    relativePath: toStorageRelativePath(storageRootOf(), absolutePath),
  };
  const assetId = resolveAssetId(db, row.projectId, 'module4', location, fingerprint, {
    durationSec: media.durationUs / 1_000_000,
    filename: row.filename ?? row.id,
    width: media.width,
    height: media.height,
    format: media.format ?? '',
  }, createdAt);
  return { assetId, projectId: row.projectId };
}

/**
 * 登记用户原文件位置为链接来源(链接 Adapter)。
 * 素材身份是内容指纹;用户原文件永远只被引用,任何项目操作都不删除它。
 */
export async function registerLinkedSource(
  db: Database.Database,
  projectId: string,
  input: {
    filePath: string;
    displayName?: string;
    now?: () => Date;
  },
): Promise<string> {
  const media = await inspectVideoFile(input.filePath);
  const createdAt = nowIso(input.now);
  const fingerprint = await computeFileSha256(input.filePath);
  const location: LinkedSourceLocation = {
    kind: 'linked',
    absolutePath: path.resolve(input.filePath),
  };
  return resolveAssetId(db, projectId, 'linked', location, fingerprint, {
    displayName: input.displayName ?? path.basename(input.filePath),
    durationSec: media.durationUs / 1_000_000,
    width: media.width,
    height: media.height,
    format: media.format ?? '',
  }, createdAt);
}

/**
 * 把用户选择的文件安全复制进项目数据根作为托管副本(托管 Adapter)。
 * 托管目录由 dataRoot() 推导,数据库保存相对 dataRoot() 的受控路径;
 * 源文件不动。目标已存在时重新核验完整 SHA-256,内容不一致禁止复用。
 */
export async function registerManagedCopy(
  db: Database.Database,
  projectId: string,
  input: {
    sourcePath: string;
    now?: () => Date;
  },
): Promise<string> {
  const media = await inspectVideoFile(input.sourcePath);
  const createdAt = nowIso(input.now);
  const fingerprint = await computeFileSha256(input.sourcePath);
  const extension = path.extname(input.sourcePath).toLowerCase();
  const relativePath = path.join(managedRelativeDirectory(projectId), `${fingerprint}${extension}`);
  const targetPath = resolveSafeDataRootPath(relativePath);
  if (existsSync(targetPath)) {
    // 目标已存在:重新核验完整 SHA-256,内容不一致不能静默复用
    const existingFingerprint = await computeFileSha256(targetPath);
    if (existingFingerprint !== fingerprint) {
      throw new Error('托管目标已存在但内容不一致,拒绝复用');
    }
  } else {
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(input.sourcePath, targetPath);
  }
  const location: ManagedSourceLocation = { kind: 'managed', relativePath };
  return resolveAssetId(db, projectId, 'managed', location, fingerprint, {
    durationSec: media.durationUs / 1_000_000,
    width: media.width,
    height: media.height,
    format: media.format ?? '',
  }, createdAt);
}

export function listAssetSources(db: Database.Database, assetId: string): BatchAssetSourceView[] {
  const rows = db.prepare(`
    SELECT * FROM batch_asset_sources WHERE assetId = ? ORDER BY createdAt, id
  `).all(assetId) as BatchAssetSourceRow[];
  return rows.map((row) => ({
    id: row.id,
    assetId: row.assetId,
    sourceKind: row.sourceKind,
    locationJson: parseSourceLocation(row.sourceKind, row.locationJson),
    health: row.health,
    createdAt: row.createdAt,
  }));
}

/**
 * 核验素材各来源的健康状态并聚合主素材可用状态:
 * 文件不存在标记 offline;内容与登记指纹不一致标记 changed(禁止冒充旧素材);
 * 至少一个来源 healthy 时素材可用,全部离线/变化时素材不可用。
 */
export async function verifyAssetSources(db: Database.Database, assetId: string): Promise<void> {
  const rows = listAssetSources(db, assetId);
  const assetFingerprint = (db.prepare(`
    SELECT contentFingerprint FROM batch_assets WHERE id = ?
  `).get(assetId) as { contentFingerprint: string } | undefined)?.contentFingerprint;
  for (const row of rows) {
    let health: BatchAssetSourceHealth = 'offline';
    try {
      const filePath = resolveSourceFilePath(row.locationJson);
      if (filePath && existsSync(filePath) && lstatSync(filePath).isFile()) {
        const fingerprint = await computeFileSha256(filePath);
        health = assetFingerprint === `sha256:${fingerprint}` ? 'healthy' : 'changed';
      }
    } catch {
      health = 'offline';
    }
    if (health !== row.health) {
      db.prepare(`UPDATE batch_asset_sources SET health = ? WHERE id = ?`).run(health, row.id);
    }
  }
  syncAssetStatusFromSources(db, assetId);
}

/**
 * 重新定位用户原文件(链接 Adapter)。
 * 必须用完整 SHA-256 核验新文件:内容相同才更新来源位置并恢复 healthy;
 * 内容不同拒绝替换(只能作为新素材登记)。
 */
export async function relocateLinkedSource(
  db: Database.Database,
  projectId: string,
  assetId: string,
  input: {
    sourceId: string;
    newFilePath: string;
    now?: () => Date;
  },
): Promise<void> {
  const asset = db.prepare(`
    SELECT contentFingerprint FROM batch_assets WHERE id = ? AND projectId = ?
  `).get(assetId, projectId) as { contentFingerprint: string } | undefined;
  if (!asset) {
    throw new Error('素材不存在');
  }
  const source = db.prepare(`
    SELECT s.id
    FROM batch_asset_sources s
    JOIN batch_assets a ON a.id = s.assetId
    WHERE s.id = ? AND s.assetId = ? AND s.sourceKind = 'linked' AND a.projectId = ?
  `).get(input.sourceId, assetId, projectId) as { id: string } | undefined;
  if (!source) {
    throw new Error('链接来源不存在或不属于该素材');
  }
  await inspectVideoFile(input.newFilePath);
  const fingerprint = await computeFileSha256(input.newFilePath);
  if (asset.contentFingerprint !== `sha256:${fingerprint}`) {
    throw new Error('新位置文件内容与素材不一致,不能静默替换;如需使用新内容请登记为新素材');
  }
  const location: LinkedSourceLocation = {
    kind: 'linked',
    absolutePath: path.resolve(input.newFilePath),
  };
  const locationJson = JSON.stringify(location);
  db.transaction(() => {
    const duplicate = db.prepare(`
      SELECT id FROM batch_asset_sources
      WHERE assetId = ? AND sourceKind = 'linked' AND locationJson = ? AND id <> ?
    `).get(assetId, locationJson, source.id) as { id: string } | undefined;
    if (duplicate) {
      db.prepare(`DELETE FROM batch_asset_sources WHERE id = ?`).run(source.id);
    } else {
      db.prepare(`
        UPDATE batch_asset_sources SET locationJson = ?, health = 'healthy' WHERE id = ?
      `).run(locationJson, source.id);
    }
  }).immediate();
  syncAssetStatusFromSources(db, assetId, input.now);
}
