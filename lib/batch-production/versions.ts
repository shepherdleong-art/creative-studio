import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type BatchProductionStatus = 'draft' | 'running' | 'partially_completed' | 'completed' | 'failed';

export interface BatchProductionRow {
  id: string;
  projectId: string;
  name: string;
  status: BatchProductionStatus;
  currentVersionId: string | null;
  progressJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface BatchProductionVersionRow {
  id: string;
  batchId: string;
  versionNumber: number;
  copyCount: number;
  defaultsJson: string;
  createdAt: string;
}

export interface BatchAssetPoolItemRow {
  id: string;
  batchVersionId: string;
  assetId: string;
  analysisId: string;
  selectionState: string;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/** 创建一次批量生产工作单(批次) */
export function createBatchProduction(
  db: Database.Database,
  projectId: string,
  name: string,
  now?: () => Date,
): string {
  const createdAt = nowIso(now);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES (?, ?, ?, 'draft', NULL, '{}', ?, ?)
  `).run(id, projectId, name, createdAt, createdAt);
  return id;
}

export function getBatchProduction(
  db: Database.Database,
  projectId: string,
  batchId: string,
): (BatchProductionRow & { progressJson: unknown }) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_productions WHERE id = ? AND projectId = ?
  `).get(batchId, projectId) as BatchProductionRow | undefined;
  if (!row) return undefined;
  return { ...row, progressJson: JSON.parse(row.progressJson) };
}

export function listProjectBatchProductions(db: Database.Database, projectId: string): BatchProductionRow[] {
  return db.prepare(`
    SELECT * FROM batch_productions WHERE projectId = ? ORDER BY createdAt, id
  `).all(projectId) as BatchProductionRow[];
}

export function updateBatchProductionStatus(
  db: Database.Database,
  projectId: string,
  batchId: string,
  status: BatchProductionStatus,
  now?: () => Date,
): void {
  const result = db.prepare(`
    UPDATE batch_productions SET status = ?, updatedAt = ? WHERE id = ? AND projectId = ?
  `).run(status, nowIso(now), batchId, projectId);
  if (result.changes === 0) {
    throw new Error('批次不存在');
  }
}

/**
 * 创建一次已确认的整体输入(批次版本):素材池、脚本快照、生成份数和默认设置
 * 在开跑后形成快照。修改整体输入时必须创建新版本,旧版本及其结果保留。
 */
export function createBatchProductionVersion(
  db: Database.Database,
  batchId: string,
  input: {
    copyCount: number;
    defaultsJson?: unknown;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  const versionNumber = db.transaction(() => {
    const existing = db.prepare(`
      SELECT MAX(versionNumber) AS maxVersion FROM batch_production_versions WHERE batchId = ?
    `).get(batchId) as { maxVersion: number | null };
    const next = (existing.maxVersion ?? 0) + 1;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, batchId, next, input.copyCount, JSON.stringify(input.defaultsJson ?? {}), createdAt);
    db.prepare(`
      UPDATE batch_productions SET currentVersionId = ?, updatedAt = ? WHERE id = ?
    `).run(id, createdAt, batchId);
    return id;
  })();
  return versionNumber;
}

export function getBatchVersion(
  db: Database.Database,
  batchId: string,
  versionId: string,
): (BatchProductionVersionRow & { defaultsJson: unknown }) | undefined {
  const row = db.prepare(`
    SELECT * FROM batch_production_versions WHERE id = ? AND batchId = ?
  `).get(versionId, batchId) as BatchProductionVersionRow | undefined;
  if (!row) return undefined;
  return { ...row, defaultsJson: JSON.parse(row.defaultsJson) };
}

export function listBatchVersions(db: Database.Database, batchId: string): BatchProductionVersionRow[] {
  return db.prepare(`
    SELECT * FROM batch_production_versions WHERE batchId = ? ORDER BY versionNumber
  `).all(batchId) as BatchProductionVersionRow[];
}

/**
 * 把一个素材及其采用的分析版本放入批次版本的素材池。
 * 池条目锁定引用:素材归档不影响历史批次追溯;同版本不能重复加入同一素材。
 */
export function addAssetToPool(
  db: Database.Database,
  batchVersionId: string,
  input: {
    assetId: string;
    analysisId: string;
    selectionState?: string;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const version = db.prepare(`
      SELECT 1 FROM batch_production_versions WHERE id = ?
    `).get(batchVersionId);
    if (!version) {
      throw new Error('批次版本不存在');
    }
    const analysis = db.prepare(`
      SELECT assetId FROM batch_asset_analysis WHERE id = ?
    `).get(input.analysisId) as { assetId: string } | undefined;
    if (!analysis) {
      throw new Error('分析版本不存在');
    }
    if (analysis.assetId !== input.assetId) {
      throw new Error('分析版本不属于该素材');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?
    `).get(batchVersionId, input.assetId);
    if (duplicate) {
      throw new Error('同一批次版本不能重复加入同一素材');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, batchVersionId, input.assetId, input.analysisId, input.selectionState ?? 'selected', createdAt);
    return id;
  })();
}

export function listPoolItems(db: Database.Database, batchVersionId: string): BatchAssetPoolItemRow[] {
  return db.prepare(`
    SELECT * FROM batch_asset_pool_items WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as BatchAssetPoolItemRow[];
}
