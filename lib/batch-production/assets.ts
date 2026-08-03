import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * 素材来源类型的唯一权威定义。module4 是模块 4 产物来源,
 * managed 是项目托管副本,linked 是用户原文件链接。
 * 所有调用方(media-catalog 等)从这里导入,不得各自维护。
 */
export type BatchAssetSourceKind = 'module4' | 'managed' | 'linked';
/**
 * batch_assets.sourceKind 记录级列的类型(数据库 CHECK 只允许 linked|managed)。
 * 它是首个来源写入的兼容字段;多来源的权威数据在 batch_asset_sources。
 */
export type BatchAssetRecordSourceKind = 'linked' | 'managed';
export type BatchAssetMediaKind = 'video' | 'image';
export type BatchAssetStatus = 'online' | 'offline' | 'archived';
export type BatchAssetAnalysisStatus = 'ready' | 'failed';

export interface BatchAssetRow {
  id: string;
  projectId: string;
  sourceKind: BatchAssetRecordSourceKind;
  locationJson: string;
  contentFingerprint: string;
  mediaKind: BatchAssetMediaKind;
  mediaJson: string;
  status: BatchAssetStatus;
  currentAnalysisId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchAssetAnalysisRow {
  id: string;
  assetId: string;
  analyzerVersion: string;
  providerId: string;
  model: string;
  analysisJson: string;
  status: BatchAssetAnalysisStatus;
  errorCode: string | null;
  errorMessage: string | null;
  analyzedAt: string | null;
  createdAt: string;
}

export interface CreateBatchAssetInput {
  projectId: string;
  sourceKind: BatchAssetSourceKind;
  /** 首个来源的定位线索,写入记录级兼容字段;多来源权威数据在 batch_asset_sources */
  locationJson: unknown;
  /** 内容身份,不依赖路径;同项目内相同指纹视为同一素材 */
  contentFingerprint: string;
  mediaKind: BatchAssetMediaKind;
  mediaJson?: unknown;
  now?: () => Date;
}

function recordSourceKindOf(sourceKind: BatchAssetSourceKind): BatchAssetRecordSourceKind {
  // 记录级 CHECK 只允许 linked|managed;module4 作为首个来源时归入 managed。
  // 权威的来源类型仍保留在 batch_asset_sources.sourceKind。
  return sourceKind === 'linked' ? 'linked' : 'managed';
}

export interface CreateBatchAnalysisInput {
  assetId: string;
  analyzerVersion: string;
  providerId: string;
  model: string;
  analysisJson?: unknown;
  now?: () => Date;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 登记项目素材。素材身份是内容指纹,不依赖文件名和路径:
 * 同项目内相同指纹复用同一素材记录;同名但内容不同的文件(指纹不同)
 * 则成为新素材。
 *
 * 新来源一律通过 batch_asset_sources 登记:同指纹已存在素材时,本函数
 * 只返回既有身份,不更新记录级的 sourceKind/locationJson,避免后登记的
 * 来源覆盖首个来源的主位置。
 */
export function createAsset(db: Database.Database, input: CreateBatchAssetInput): string {
  const createdAt = nowIso(input.now);
  const existing = db.prepare(`
    SELECT id FROM batch_assets
    WHERE projectId = ? AND contentFingerprint = ?
  `).get(input.projectId, input.contentFingerprint) as { id: string } | undefined;
  if (existing) {
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_assets
      (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, mediaJson, status, currentAnalysisId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'online', NULL, ?, ?)
  `).run(
    id,
    input.projectId,
    recordSourceKindOf(input.sourceKind),
    JSON.stringify(input.locationJson),
    input.contentFingerprint,
    input.mediaKind,
    JSON.stringify(input.mediaJson ?? {}),
    createdAt,
    createdAt,
  );
  return id;
}

export function getAsset(db: Database.Database, projectId: string, assetId: string): (BatchAssetRow & {
  locationJson: unknown;
  mediaJson: unknown;
}) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_assets WHERE id = ? AND projectId = ?
  `).get(assetId, projectId) as BatchAssetRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    locationJson: JSON.parse(row.locationJson),
    mediaJson: JSON.parse(row.mediaJson),
  };
}

export function listProjectAssets(db: Database.Database, projectId: string): BatchAssetRow[] {
  return db.prepare(`
    SELECT * FROM batch_assets WHERE projectId = ? ORDER BY createdAt, id
  `).all(projectId) as BatchAssetRow[];
}

function updateAssetStatus(
  db: Database.Database,
  projectId: string,
  assetId: string,
  status: BatchAssetStatus,
  now?: () => Date,
): void {
  const result = db.prepare(`
    UPDATE batch_assets SET status = ?, updatedAt = ? WHERE id = ? AND projectId = ?
  `).run(status, nowIso(now), assetId, projectId);
  if (result.changes === 0) {
    throw new Error('素材不存在');
  }
}

/** 链接素材移动或改名后标记为离线;重新定位并核验为同一内容后恢复 */
export function markAssetOffline(db: Database.Database, projectId: string, assetId: string, now?: () => Date): void {
  updateAssetStatus(db, projectId, assetId, 'offline', now);
}

/** 被历史批次引用的素材普通移除进入归档:不再参与新批次,历史仍可追溯 */
export function markAssetArchived(db: Database.Database, projectId: string, assetId: string, now?: () => Date): void {
  updateAssetStatus(db, projectId, assetId, 'archived', now);
}

/** 重新定位并核验内容身份后恢复使用 */
export function restoreAssetOnline(db: Database.Database, projectId: string, assetId: string, now?: () => Date): void {
  updateAssetStatus(db, projectId, assetId, 'online', now);
}

/**
 * 按来源聚合素材的可用状态并写回主记录:
 * - 用户归档(archived)是管理选择,不被来源状态覆盖;
 * - 至少一个来源 healthy 时素材可用(online);
 * - 所有来源 offline 或 changed 时素材不可用(offline);
 * 来源的健康状态各自保留在 batch_asset_sources。
 */
export function syncAssetStatusFromSources(
  db: Database.Database,
  assetId: string,
  now?: () => Date,
): BatchAssetStatus {
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT status FROM batch_assets WHERE id = ?
    `).get(assetId) as { status: BatchAssetStatus } | undefined;
    if (!current) {
      throw new Error('素材不存在');
    }
    if (current.status === 'archived') {
      return current.status;
    }
    const sources = db.prepare(`
      SELECT health FROM batch_asset_sources WHERE assetId = ?
    `).all(assetId) as Array<{ health: string }>;
    const next: BatchAssetStatus = sources.some(({ health }) => health === 'healthy') ? 'online' : 'offline';
    if (next !== current.status) {
      db.prepare(`
        UPDATE batch_assets SET status = ?, updatedAt = ? WHERE id = ?
      `).run(next, nowIso(now), assetId);
    }
    return next;
  })();
}

/**
 * 记录一份素材分析版本。分析版本属于素材、可被多个批次复用;
 * 同一素材可有多份分析(内容变化或分析能力升级形成新版)。
 * 创建新分析不会自动改写素材的当前分析指向。
 */
export function createAnalysisVersion(db: Database.Database, input: CreateBatchAnalysisInput): string {
  const createdAt = nowIso(input.now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_asset_analysis
      (id, assetId, analyzerVersion, providerId, model, analysisJson, status, analyzedAt, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
  `).run(
    id,
    input.assetId,
    input.analyzerVersion,
    input.providerId,
    input.model,
    JSON.stringify(input.analysisJson ?? {}),
    createdAt,
    createdAt,
  );
  return id;
}

export function listAnalysisVersions(db: Database.Database, assetId: string): BatchAssetAnalysisRow[] {
  return db.prepare(`
    SELECT * FROM batch_asset_analysis WHERE assetId = ? ORDER BY createdAt, id
  `).all(assetId) as BatchAssetAnalysisRow[];
}

/**
 * 原子地创建一份分析版本并切换素材当前分析指向。
 * 返回真实的分析版本 id;调用方必须原样使用它(不是 lastInsertRowid)。
 */
export function createAnalysisVersionAndSetCurrent(
  db: Database.Database,
  input: CreateBatchAnalysisInput,
): string {
  return db.transaction(() => {
    const id = createAnalysisVersion(db, input);
    db.prepare(`
      UPDATE batch_assets SET currentAnalysisId = ?, updatedAt = ? WHERE id = ?
    `).run(id, nowIso(input.now), input.assetId);
    return id;
  })();
}

/**
 * 显式更新素材当前使用的分析版本。
 * 先校验分析版本存在且属于该素材,再在同一事务内更新指向;
 * 校验失败时不会留下任何脏数据。
 */
export function setAssetCurrentAnalysis(
  db: Database.Database,
  projectId: string,
  assetId: string,
  analysisId: string,
  now?: () => Date,
): void {
  db.transaction(() => {
    const asset = db.prepare(`
      SELECT 1 FROM batch_assets WHERE id = ? AND projectId = ?
    `).get(assetId, projectId);
    if (!asset) {
      throw new Error('素材不存在');
    }
    const analysis = db.prepare(`
      SELECT 1 FROM batch_asset_analysis WHERE id = ? AND assetId = ?
    `).get(analysisId, assetId);
    if (!analysis) {
      throw new Error('分析版本不属于该素材');
    }
    db.prepare(`
      UPDATE batch_assets
      SET currentAnalysisId = ?, updatedAt = ?
      WHERE id = ? AND projectId = ?
    `).run(analysisId, nowIso(now), assetId, projectId);
  })();
}
