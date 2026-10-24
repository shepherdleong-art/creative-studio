import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { type ColorSnapshotV1, type ColorSnapshotIdentity } from './color-pipeline.ts';
import { fingerprintsEqual } from './fingerprint.ts';
import { isBatchAssetEligible } from './media-catalog.ts';

export type BatchProductionStatus = 'draft' | 'running' | 'partially_completed' | 'completed' | 'failed';

export interface BatchProductionRow {
  id: string;
  projectId: string;
  name: string;
  status: BatchProductionStatus;
  currentVersionId: string | null;
  progressJson: string;
  deletedAt: string | null;
  /** 归档时间(独立维度,不影响状态与产物);NULL 表示未归档 */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchProductionVersionRow {
  id: string;
  batchId: string;
  versionNumber: number;
  copyCount: number;
  defaultsJson: string;
  inputState: 'draft' | 'frozen';
  /** Phase E 当前激活的联合分配运行；可重新指向历史确定性运行。 */
  currentAllocationRunId: string | null;
  frozenAt: string | null;
  createdAt: string;
}

export interface BatchAssetPoolItemRow {
  id: string;
  batchVersionId: string;
  assetId: string;
  analysisId: string;
  selectionState: string;
  /** 该素材在本批次版本采用的完整色彩快照(V1),序列化 JSON */
  colorJson: string;
  createdAt: string;
}

/**
 * @deprecated 使用 ColorPipeline 的 ColorSnapshotV1 代替。
 * 旧类型只有 lutId,缺少 LUT 内容指纹、色彩链版本、插值策略和 SDR 合同。
 * 保留仅用于向后兼容旧测试和迁移代码。
 */
export interface BatchColorSnapshot {
  lutId: string | null;
}

export type { ColorSnapshotV1, ColorSnapshotIdentity };

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
    SELECT * FROM batch_productions WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as BatchProductionRow | undefined;
  if (!row) return undefined;
  return { ...row, progressJson: JSON.parse(row.progressJson) };
}

export function listProjectBatchProductions(
  db: Database.Database,
  projectId: string,
  options: { includeArchived?: boolean } = {},
): BatchProductionRow[] {
  return db.prepare(`
    SELECT * FROM batch_productions
    WHERE projectId = ? AND deletedAt IS NULL
      AND (${options.includeArchived ? '1' : 'archivedAt IS NULL'})
    ORDER BY createdAt, id
  `).all(projectId) as BatchProductionRow[];
}

/**
 * 归档/恢复批次:archivedAt 是独立维度,不影响 status、成片与已导出文件。
 * 归档批次从默认列表消失;恢复后原样回到列表,产物完好。
 */
export function setBatchProductionArchived(
  db: Database.Database,
  projectId: string,
  batchId: string,
  archived: boolean,
  now?: () => Date,
): void {
  const updatedAt = nowIso(now);
  const result = db.prepare(`
    UPDATE batch_productions
    SET archivedAt = ?, updatedAt = ?
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).run(archived ? updatedAt : null, updatedAt, batchId, projectId);
  if (result.changes === 0) {
    throw new Error('批次不存在');
  }
}

export function updateBatchProductionStatus(
  db: Database.Database,
  projectId: string,
  batchId: string,
  status: BatchProductionStatus,
  now?: () => Date,
): void {
  const updatedAt = nowIso(now);
  db.transaction(() => {
    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions
      WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) {
      throw new Error('批次不存在');
    }
    if (status !== 'draft' && batch.currentVersionId) {
      db.prepare(`
        UPDATE batch_production_versions
        SET inputState = 'frozen', frozenAt = COALESCE(frozenAt, ?)
        WHERE id = ? AND inputState = 'draft'
      `).run(updatedAt, batch.currentVersionId);
    }
    db.prepare(`
      UPDATE batch_productions SET status = ?, updatedAt = ? WHERE id = ?
    `).run(status, updatedAt, batchId);
  })();
}

/** 从正常批次列表移除工作单，历史版本与正式产物继续保留。 */
export function deleteBatchProduction(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
): void {
  const deletedAt = nowIso(now);
  const result = db.prepare(`
    UPDATE batch_productions
    SET deletedAt = ?, updatedAt = ?
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).run(deletedAt, deletedAt, batchId, projectId);
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
    const batch = db.prepare(`
      SELECT id FROM batch_productions WHERE id = ? AND deletedAt IS NULL
    `).get(batchId);
    if (!batch) {
      throw new Error('批次不存在');
    }
    const existing = db.prepare(`
      SELECT MAX(versionNumber) AS maxVersion FROM batch_production_versions WHERE batchId = ?
    `).get(batchId) as { maxVersion: number | null };
    const next = (existing.maxVersion ?? 0) + 1;
    const id = randomUUID();
    db.prepare(`
      UPDATE batch_production_versions
      SET inputState = 'frozen', frozenAt = COALESCE(frozenAt, ?)
      WHERE batchId = ? AND inputState = 'draft'
    `).run(createdAt, batchId);
    db.prepare(`
      INSERT INTO batch_production_versions
        (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
      VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?)
    `).run(id, batchId, next, input.copyCount, JSON.stringify(input.defaultsJson ?? {}), createdAt);
    db.prepare(`
      UPDATE batch_productions
      SET currentVersionId = ?, status = 'draft', progressJson = '{}', updatedAt = ?
      WHERE id = ?
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
 * 查出一个批次版本所属的批次、项目与批次状态;返回 undefined 表示版本不存在。
 */
export function getBatchVersionOwner(
  db: Database.Database,
  batchVersionId: string,
): {
  batchId: string;
  projectId: string;
  status: BatchProductionStatus;
  inputState: 'draft' | 'frozen';
} | undefined {
  return db.prepare(`
    SELECT p.id AS batchId, p.projectId AS projectId, p.status AS status, v.inputState AS inputState
    FROM batch_production_versions v
    JOIN batch_productions p ON p.id = v.batchId
    WHERE v.id = ? AND p.deletedAt IS NULL
  `).get(batchVersionId) as {
    batchId: string;
    projectId: string;
    status: BatchProductionStatus;
    inputState: 'draft' | 'frozen';
  } | undefined;
}

export function assertBatchVersionEditable(
  db: Database.Database,
  batchVersionId: string,
): NonNullable<ReturnType<typeof getBatchVersionOwner>> {
  const owner = getBatchVersionOwner(db, batchVersionId);
  if (!owner) {
    throw new Error('批次版本不存在');
  }
  if (owner.inputState !== 'draft') {
    throw new Error('批次版本的输入已冻结,修改整体输入必须创建新版本');
  }
  return owner;
}

/**
 * 把一个素材及其采用的分析版本放入批次版本的素材池。
 * 池条目锁定引用:素材归档不影响历史批次追溯;同版本不能重复加入同一素材;
 * 素材必须与批次属于同一项目;批次版本一旦开跑就永久冻结,不能再追加。
 */
export function addAssetToPool(
  db: Database.Database,
  batchVersionId: string,
  input: {
    assetId: string;
    analysisId: string;
    selectionState?: string;
    /** 关闭或引用一个已验证 LUT 的完整色彩快照;省略等同于关闭 */
    colorSnapshot?: ColorSnapshotV1;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const owner = assertBatchVersionEditable(db, batchVersionId);
    const asset = db.prepare(`
      SELECT projectId FROM batch_assets WHERE id = ?
    `).get(input.assetId) as { projectId: string } | undefined;
    if (!asset) {
      throw new Error('素材不存在');
    }
    if (asset.projectId !== owner.projectId) {
      throw new Error('素材不属于该批次所在项目');
    }
    if (!isBatchAssetEligible(db, input.assetId)) {
      throw new Error('素材对应的视频已剔除,不能加入批次素材池');
    }
    const analysis = db.prepare(`
      SELECT assetId, status FROM batch_asset_analysis WHERE id = ?
    `).get(input.analysisId) as { assetId: string; status: 'ready' | 'failed' } | undefined;
    if (!analysis) {
      throw new Error('分析版本不存在');
    }
    if (analysis.assetId !== input.assetId) {
      throw new Error('分析版本不属于该素材');
    }
    if (analysis.status !== 'ready') {
      throw new Error('素材分析尚未完成,不能加入批次素材池');
    }
    const colorSnapshot: ColorSnapshotV1 = input.colorSnapshot ?? {
      lutId: null,
      lutFingerprint: '',
      colorPipelineVersion: 'color-v1',
      interpolation: 'trilinear',
      outputContract: 'sdr-v1',
    };
    if (colorSnapshot.lutId !== null) {
      const lut = db.prepare(`
        SELECT projectId, status, contentFingerprint FROM batch_luts WHERE id = ?
      `).get(colorSnapshot.lutId) as { projectId: string; status: 'active' | 'archived'; contentFingerprint: string } | undefined;
      if (!lut) {
        throw new Error('LUT 不存在');
      }
      if (lut.projectId !== owner.projectId) {
        throw new Error('LUT 不属于该批次所在项目');
      }
      if (lut.status !== 'active') {
        throw new Error('归档的 LUT 不能进入新的批次选择');
      }
      // 完整冻结合同:引用 LUT 时指纹必须非空、非 unresolved 标记且与受管内容一致。
      // 空字符串绕过在这里被禁止——不允许"引用了 LUT 却没锁定内容"的模糊快照。
      if (
        !colorSnapshot.lutFingerprint
        || colorSnapshot.lutFingerprint.startsWith('unresolved:')
        || !fingerprintsEqual(colorSnapshot.lutFingerprint, lut.contentFingerprint)
      ) {
        throw new Error('色彩快照中的 LUT 指纹缺失或与受管内容不一致');
      }
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?
    `).get(batchVersionId, input.assetId);
    if (duplicate) {
      throw new Error('同一批次版本不能重复加入同一素材');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, batchVersionId, input.assetId, input.analysisId, input.selectionState ?? 'selected', JSON.stringify(colorSnapshot), createdAt);
    return id;
  })();
}

export function listPoolItems(db: Database.Database, batchVersionId: string): BatchAssetPoolItemRow[] {
  return db.prepare(`
    SELECT * FROM batch_asset_pool_items WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as BatchAssetPoolItemRow[];
}
