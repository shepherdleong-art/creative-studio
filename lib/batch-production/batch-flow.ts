import type Database from 'better-sqlite3';
import { BatchDomainError } from './errors.ts';
import { createOutputPlansForSnapshot, listOutputPlans } from './plans.ts';
import { resolveColorSnapshot, type ColorSnapshotInput } from './lut-catalog.ts';
import { syncProjectScripts } from './script-catalog.ts';
import { snapshotScriptIntoBatch } from './scripts.ts';
import {
  addAssetToPool,
  createBatchProductionVersion,
  getBatchVersionOwner,
  listPoolItems,
  updateBatchProductionStatus,
  type BatchProductionStatus,
  type ColorSnapshotV1,
} from './versions.ts';
import { colorSnapshotIdentity, upgradeColorSnapshot } from './color-pipeline.ts';

export interface BatchScriptSelection {
  scriptId: string;
  /** 该脚本的生成份数,决定成片计划数量 */
  copyCount: number;
}

export interface BatchAssetSelection {
  assetId: string;
  /** 该素材在本批次采用的素材分析版本 */
  analysisId: string;
  /** 关闭或引用一个已验证 LUT 的完整色彩快照;省略等同于关闭。
   *  接受旧格式 {lutId} 或新格式 ColorSnapshotV1,服务端一律按项目内受管
   *  LUT 解析成完整快照(§4.2):lutId 非空时指纹必须非空且与受管内容一致,
   *  空字符串绕过被禁止。是冻结输入的一部分,与"是否已生成代理"无关。 */
  colorSnapshot?: ColorSnapshotInput;
}

export interface BatchSnapshotInput {
  scriptSelections: BatchScriptSelection[];
  assetSelections: BatchAssetSelection[];
  defaultsJson?: unknown;
  now?: () => Date;
}

export interface BatchSnapshotResult {
  batchVersionId: string;
  inputState: 'draft' | 'frozen';
  /** 本次确认的全部成片计划数(份数总和) */
  totalPlans: number;
  planIds: string[];
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function assertPositiveCopyCount(copyCount: number): void {
  if (!Number.isInteger(copyCount) || copyCount < 1) {
    throw new BatchDomainError('invalid_input', '生成份数必须是正整数');
  }
}

function validateSelections(
  db: Database.Database,
  projectId: string,
  currentVersionId: string | null,
  input: BatchSnapshotInput,
): void {
  for (const { scriptId } of input.scriptSelections) {
    const script = db.prepare(`
      SELECT projectId, sourceKind, ownerBatchVersionId, sourceAvailable
      FROM batch_scripts WHERE id = ?
    `).get(scriptId) as {
      projectId: string;
      sourceKind: 'script_draft' | 'external';
      ownerBatchVersionId: string | null;
      sourceAvailable: number;
    } | undefined;
    if (!script) throw new BatchDomainError('not_found', '项目脚本不存在');
    if (script.projectId !== projectId) {
      throw new BatchDomainError('invalid_input', '脚本不属于该批次所在项目');
    }
    if (script.sourceKind === 'script_draft' && script.sourceAvailable !== 1) {
      throw new BatchDomainError('conflict', '项目脚本的上游来源已不可用');
    }
    if (script.sourceKind === 'external' && script.ownerBatchVersionId !== currentVersionId) {
      throw new BatchDomainError('conflict', '外部文案不属于当前批次版本');
    }
  }

  const seenAssets = new Set<string>();
  for (const { assetId, analysisId } of input.assetSelections) {
    if (seenAssets.has(assetId)) {
      throw new BatchDomainError('invalid_input', '同一素材不能重复选择');
    }
    seenAssets.add(assetId);
    const asset = db.prepare(`SELECT projectId, status FROM batch_assets WHERE id = ?`).get(assetId) as {
      projectId: string;
      status: 'online' | 'offline' | 'archived';
    } | undefined;
    if (!asset) throw new BatchDomainError('not_found', '素材不存在');
    if (asset.projectId !== projectId) {
      throw new BatchDomainError('invalid_input', '素材不属于该批次所在项目');
    }
    if (asset.status !== 'online') {
      throw new BatchDomainError('conflict', asset.status === 'archived' ? '归档素材不能进入新批次' : '离线素材不能进入新批次');
    }
    const analysis = db.prepare(`SELECT assetId, status FROM batch_asset_analysis WHERE id = ?`).get(analysisId) as {
      assetId: string;
      status: 'ready' | 'failed';
    } | undefined;
    if (!analysis) throw new BatchDomainError('not_found', '分析版本不存在');
    if (analysis.assetId !== assetId) {
      throw new BatchDomainError('invalid_input', '分析版本不属于该素材');
    }
    if (analysis.status !== 'ready') {
      throw new BatchDomainError('conflict', '素材分析尚未完成,不能确认批次快照');
    }
    // LUT 完整身份的校验由 resolveColorSnapshot 统一完成(见 createBatchSnapshot),
    // 这里只做素材与分析归属的静态校验。
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** 当前来源内容也属于整体输入；上游已变化时不能把旧快照误判为幂等确认。 */
function matchesCurrentInput(
  db: Database.Database,
  batchVersionId: string,
  input: BatchSnapshotInput,
): boolean {
  const version = db.prepare(`
    SELECT defaultsJson FROM batch_production_versions WHERE id = ?
  `).get(batchVersionId) as { defaultsJson: string } | undefined;
  if (!version || canonicalJson(parseJsonOrRaw(version.defaultsJson)) !== canonicalJson(input.defaultsJson ?? {})) {
    return false;
  }

  const snapshots = db.prepare(`
    SELECT sourceScriptId, copyCount, title, bodyText, sourceVersion,
           targetDurationSec, narrationConfigJson, coverTitleJson, shotSetId, contentRevision
    FROM batch_script_snapshots WHERE batchVersionId = ?
  `).all(batchVersionId) as Array<{
    sourceScriptId: string;
    copyCount: number;
    title: string;
    bodyText: string;
    sourceVersion: string;
    targetDurationSec: number;
    narrationConfigJson: string;
    coverTitleJson: string;
    shotSetId: string;
    contentRevision: string;
  }>;
  if (snapshots.length !== input.scriptSelections.length) return false;
  const snapshotBySource = new Map(snapshots.map((snapshot) => [snapshot.sourceScriptId, snapshot]));
  for (const selection of input.scriptSelections) {
    const snapshot = snapshotBySource.get(selection.scriptId);
    if (!snapshot || snapshot.copyCount !== selection.copyCount) return false;
    const source = db.prepare(`
      SELECT title, bodyText, sourceVersion, targetDurationSec, narrationConfigJson,
             coverTitleJson, shotSetId, contentRevision, sourceAvailable
      FROM batch_scripts WHERE id = ?
    `).get(selection.scriptId) as {
      title: string;
      bodyText: string;
      sourceVersion: string;
      targetDurationSec: number;
      narrationConfigJson: string;
      coverTitleJson: string;
      shotSetId: string;
      contentRevision: string;
      sourceAvailable: number;
    } | undefined;
    if (!source || source.sourceAvailable !== 1) return false;
    if (
      snapshot.title !== source.title
      || snapshot.bodyText !== source.bodyText
      || snapshot.sourceVersion !== source.sourceVersion
      || snapshot.targetDurationSec !== source.targetDurationSec
      || canonicalJson(parseJsonOrRaw(snapshot.narrationConfigJson)) !== canonicalJson(parseJsonOrRaw(source.narrationConfigJson))
      || canonicalJson(parseJsonOrRaw(snapshot.coverTitleJson)) !== canonicalJson(parseJsonOrRaw(source.coverTitleJson))
      || snapshot.shotSetId !== source.shotSetId
      || snapshot.contentRevision !== source.contentRevision
    ) return false;
  }

  // 色彩快照(LUT 引用或关闭)是整体输入身份的一部分(§4.2):变化必须形成新版本,
  // 不能被当成相同输入幂等合并。代理是否已生成不参与这个比较。
  const selectedAssets = [...input.assetSelections]
    .map(({ assetId, analysisId, colorSnapshot }) => (
      `${assetId}\u0000${analysisId}\u0000${canonicalJson(colorSnapshotIdentity(upgradeColorSnapshot(colorSnapshot ?? { lutId: null })))}`
    ))
    .sort();
  const storedAssets = (db.prepare(`
    SELECT assetId, analysisId, colorJson FROM batch_asset_pool_items WHERE batchVersionId = ?
  `).all(batchVersionId) as Array<{ assetId: string; analysisId: string; colorJson: string }>)
    .map(({ assetId, analysisId, colorJson }) => (
      `${assetId}\u0000${analysisId}\u0000${canonicalJson(colorSnapshotIdentity(upgradeColorSnapshot(parseJsonOrRaw(colorJson))))}`
    ))
    .sort();
  if (canonicalJson(storedAssets) !== canonicalJson(selectedAssets)) return false;

  const planCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM batch_output_plans WHERE batchVersionId = ?
  `).get(batchVersionId) as { n: number }).n;
  return planCount === input.scriptSelections.reduce((sum, selection) => sum + selection.copyCount, 0);
}

/**
 * 为批次建立一次可检查的 draft 整体输入:
 * 脚本快照(按各自份数)、素材池(锁定素材与分析版本)、成片计划(份数总和 = N 张卡片)。
 *
 * - 完全相同的整体输入幂等返回既有版本与稳定计划;输入变化才形成新版本,
 *   旧版本及其结果永远保留。真正冻结发生在 start。
 * - 整个确认过程在单个事务内完成:任一脚本/素材/计划失败,全部回滚,
 *   不留半成品版本。
 * - 失败重试属于既有计划下的任务尝试,不调用本 seam,不会新增计划。
 */
export function createBatchSnapshot(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: BatchSnapshotInput,
): BatchSnapshotResult {
  const createdAt = nowIso(input.now);
  if (!input.scriptSelections || input.scriptSelections.length === 0) {
    throw new BatchDomainError('invalid_input', '至少选择一份脚本');
  }
  if (!input.assetSelections || input.assetSelections.length === 0) {
    throw new BatchDomainError('invalid_input', '至少选择一份素材并锁定分析版本');
  }
  const seenScripts = new Set<string>();
  for (const selection of input.scriptSelections) {
    assertPositiveCopyCount(selection.copyCount);
    if (seenScripts.has(selection.scriptId)) {
      throw new BatchDomainError('invalid_input', '同一脚本不能重复选择');
    }
    seenScripts.add(selection.scriptId);
  }
  const totalCopyCount = input.scriptSelections.reduce((sum, { copyCount }) => sum + copyCount, 0);

  return db.transaction(() => {
    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions
      WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) {
      throw new BatchDomainError('not_found', '批次不存在');
    }
    validateSelections(db, projectId, batch.currentVersionId, input);

    // 服务端按项目内受管 LUT 解析完整色彩快照:客户端只提交 lutId,
    // 指纹、色彩链版本、插值策略与 SDR 合同一律由服务端补齐并校验;
    // lutId 非空时指纹不可能为空(空字符串绕过在此被拒绝)。
    const resolvedAssetSelections = input.assetSelections.map(({ assetId, analysisId, colorSnapshot }) => ({
      assetId,
      analysisId,
      colorSnapshot: resolveColorSnapshot(db, projectId, colorSnapshot),
    }));
    const resolvedInput: BatchSnapshotInput = {
      scriptSelections: input.scriptSelections,
      assetSelections: resolvedAssetSelections,
      defaultsJson: input.defaultsJson,
      now: input.now,
    };

    if (batch.currentVersionId && matchesCurrentInput(db, batch.currentVersionId, resolvedInput)) {
      const planIds = listOutputPlans(db, batch.currentVersionId).map(({ id }) => id);
      const owner = getBatchVersionOwner(db, batch.currentVersionId);
      const inputState: BatchSnapshotResult['inputState'] = owner?.inputState ?? 'draft';
      return {
        batchVersionId: batch.currentVersionId,
        inputState,
        totalPlans: planIds.length,
        planIds,
      };
    }

    // 决定批次版本:当前版本仍是未确认 draft(无脚本快照)时复用,否则新建。
    // 复用时必须把本次确认的份数与默认设置写回版本,避免版本账本与实际计划不一致。
    let batchVersionId: string;
    if (batch.currentVersionId) {
      const owner = getBatchVersionOwner(db, batch.currentVersionId);
      const hasSnapshots = db.prepare(`
        SELECT 1 FROM batch_script_snapshots WHERE batchVersionId = ? LIMIT 1
      `).get(batch.currentVersionId);
      if (owner && owner.inputState === 'draft' && !hasSnapshots) {
        batchVersionId = batch.currentVersionId;
        db.prepare(`
          UPDATE batch_production_versions SET copyCount = ?, defaultsJson = ? WHERE id = ?
        `).run(totalCopyCount, JSON.stringify(input.defaultsJson ?? {}), batchVersionId);
      } else {
        batchVersionId = createBatchProductionVersion(db, batchId, {
          copyCount: totalCopyCount,
          defaultsJson: input.defaultsJson ?? {},
          now: input.now,
        });
        db.prepare(`
          UPDATE batch_productions SET status = 'draft', updatedAt = ? WHERE id = ?
        `).run(createdAt, batchId);
      }
    } else {
      batchVersionId = createBatchProductionVersion(db, batchId, {
        copyCount: totalCopyCount,
        defaultsJson: input.defaultsJson ?? {},
        now: input.now,
      });
    }

    const planIds: string[] = [];
    for (const { scriptId, copyCount } of input.scriptSelections) {
      const snapshotId = snapshotScriptIntoBatch(db, batchVersionId, {
        scriptId,
        copyCount,
        now: input.now,
      });
      planIds.push(...createOutputPlansForSnapshot(db, batchVersionId, snapshotId, input.now));
    }

    for (const { assetId, analysisId, colorSnapshot } of resolvedAssetSelections) {
      addAssetToPool(db, batchVersionId, { assetId, analysisId, colorSnapshot, now: input.now });
    }

    return {
      batchVersionId,
      inputState: 'draft' as const,
      totalPlans: planIds.length,
      planIds,
    };
  })();
}

/**
 * 把批次整体投入生产:批次进入 running,当前版本永久冻结。
 * 启动前必须校验当前版本存在且仍为 draft,并且已有脚本快照与对应成片计划;
 * 空批次或没有输入快照的批次不能被标记为 running(避免虚假运行态)。
 */
export function startBatchProduction(
  db: Database.Database,
  projectId: string,
  batchId: string,
  now?: () => Date,
  options: { allowUnavailableAssets?: boolean } = {},
): void {
  db.transaction(() => {
    const batch = db.prepare(`
      SELECT currentVersionId FROM batch_productions
      WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { currentVersionId: string | null } | undefined;
    if (!batch) {
      throw new BatchDomainError('not_found', '批次不存在');
    }
    if (!batch.currentVersionId) {
      throw new BatchDomainError('conflict', '批次还没有任何输入快照,不能启动');
    }
    const version = db.prepare(`
      SELECT inputState, copyCount FROM batch_production_versions WHERE id = ?
    `).get(batch.currentVersionId) as { inputState: 'draft' | 'frozen'; copyCount: number } | undefined;
    if (!version) {
      throw new BatchDomainError('not_found', '批次版本不存在');
    }
    if (version.inputState !== 'draft') {
      throw new BatchDomainError('conflict', '当前批次版本已经冻结,不能重复启动');
    }
    const snapshotSummary = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(copyCount), 0) AS expectedPlans
      FROM batch_script_snapshots WHERE batchVersionId = ?
    `).get(batch.currentVersionId) as { n: number; expectedPlans: number };
    if (snapshotSummary.n === 0) {
      throw new BatchDomainError('conflict', '批次还没有脚本快照,不能启动');
    }
    const poolCount = db.prepare(`
      SELECT COUNT(*) AS n FROM batch_asset_pool_items WHERE batchVersionId = ?
    `).get(batch.currentVersionId) as { n: number };
    if (poolCount.n === 0) {
      throw new BatchDomainError('conflict', '批次素材池为空,不能启动');
    }
    const unavailablePoolItem = db.prepare(`
      SELECT assets.status
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      WHERE pool.batchVersionId = ? AND assets.status <> 'online'
      LIMIT 1
    `).get(batch.currentVersionId) as { status: 'offline' | 'archived' } | undefined;
    if (unavailablePoolItem && !options.allowUnavailableAssets) {
      throw new BatchDomainError(
        'conflict',
        unavailablePoolItem.status === 'archived' ? '批次包含已归档素材,不能启动' : '批次包含离线素材,不能启动',
      );
    }
    const planCount = db.prepare(`
      SELECT COUNT(*) AS n FROM batch_output_plans WHERE batchVersionId = ?
    `).get(batch.currentVersionId) as { n: number };
    const perSnapshotPlanMismatch = db.prepare(`
      SELECT 1
      FROM batch_script_snapshots snapshots
      LEFT JOIN batch_output_plans plans ON plans.scriptSnapshotId = snapshots.id
      WHERE snapshots.batchVersionId = ?
      GROUP BY snapshots.id, snapshots.copyCount
      HAVING COUNT(plans.id) <> snapshots.copyCount
      LIMIT 1
    `).get(batch.currentVersionId);
    if (
      planCount.n !== snapshotSummary.expectedPlans
      || planCount.n !== version.copyCount
      || perSnapshotPlanMismatch
    ) {
      throw new BatchDomainError('conflict', `成片计划数量不完整:应有 ${snapshotSummary.expectedPlans} 张,实际 ${planCount.n} 张`);
    }

    // start 是输入冻结点。先在同一事务内把第 3 步权威草稿同步进项目脚本目录，
    // 再读取最新值，避免用户未重新打开准备区时把旧确认内容静默锁死。
    syncProjectScripts(db, projectId, now);

    // 确认与开跑之间仍可更新的上游脚本在这里读取最新值，
    // 并与版本冻结置于同一事务，避免把旧确认内容静默锁死。
    const snapshotSources = db.prepare(`
      SELECT snapshots.id AS snapshotId,
             scripts.projectId, scripts.sourceKind, scripts.ownerBatchVersionId,
             scripts.title, scripts.bodyText, scripts.sourceVersion,
             scripts.targetDurationSec, scripts.narrationConfigJson,
             scripts.coverTitleJson, scripts.shotSetId, scripts.contentRevision,
             scripts.sourceAvailable
      FROM batch_script_snapshots snapshots
      JOIN batch_scripts scripts ON scripts.id = snapshots.sourceScriptId
      WHERE snapshots.batchVersionId = ?
    `).all(batch.currentVersionId) as Array<{
      snapshotId: string;
      projectId: string;
      sourceKind: 'script_draft' | 'external';
      ownerBatchVersionId: string | null;
      title: string;
      bodyText: string;
      sourceVersion: string;
      targetDurationSec: number;
      narrationConfigJson: string;
      coverTitleJson: string;
      shotSetId: string;
      contentRevision: string;
      sourceAvailable: number;
    }>;
    if (snapshotSources.length !== snapshotSummary.n) {
      throw new BatchDomainError('conflict', '批次脚本来源不完整,不能启动');
    }
    for (const source of snapshotSources) {
      if (source.projectId !== projectId) {
        throw new BatchDomainError('invalid_input', '批次脚本来源不属于该项目');
      }
      if (source.sourceKind === 'script_draft' && source.sourceAvailable !== 1) {
        throw new BatchDomainError('conflict', '项目脚本的上游来源已不可用');
      }
      if (source.sourceKind === 'external' && source.ownerBatchVersionId !== batch.currentVersionId) {
        throw new BatchDomainError('conflict', '外部文案不属于当前批次版本');
      }
      db.prepare(`
        UPDATE batch_script_snapshots
        SET title = ?, bodyText = ?, sourceVersion = ?, targetDurationSec = ?,
            narrationConfigJson = ?, coverTitleJson = ?, shotSetId = ?, contentRevision = ?
        WHERE id = ? AND batchVersionId = ?
      `).run(
        source.title,
        source.bodyText,
        source.sourceVersion,
        source.targetDurationSec,
        source.narrationConfigJson,
        source.coverTitleJson,
        source.shotSetId,
        source.contentRevision,
        source.snapshotId,
        batch.currentVersionId,
      );
    }
    // 素材分析必须在 snapshot 前由项目素材分析入口排队并完成。start 只
    // 冻结已锁定的 analysisId，不再为素材池重复创建 asset_prepare 任务。
    updateBatchProductionStatus(db, projectId, batchId, 'running', now);
  })();
}

export interface BatchSnapshotDetail {
  batch: {
    id: string;
    name: string;
    status: BatchProductionStatus;
  };
  version: {
    id: string;
    versionNumber: number;
    copyCount: number;
    inputState: 'draft' | 'frozen';
  };
  scriptSnapshots: Array<{
    id: string;
    sourceScriptId: string;
    title: string;
    bodyText: string;
    sourceVersion: string;
    coverTitle: { primary: string; secondary: string };
    copyCount: number;
    shotSetId: string;
    contentRevision: string;
  }>;
  assetPool: Array<{
    id: string;
    assetId: string;
    analysisId: string;
    colorSnapshot: ColorSnapshotV1;
  }>;
  outputPlans: Array<{
    id: string;
    seq: number;
  }>;
}

/** 批次详情(当前版本):版本、脚本快照、素材池与成片计划,供卡片检查。 */
export function getBatchSnapshotDetail(
  db: Database.Database,
  projectId: string,
  batchId: string,
): BatchSnapshotDetail {
  const batch = db.prepare(`
    SELECT id, name, status FROM batch_productions
    WHERE id = ? AND projectId = ? AND deletedAt IS NULL
  `).get(batchId, projectId) as { id: string; name: string; status: BatchProductionStatus } | undefined;
  if (!batch) {
    throw new BatchDomainError('not_found', '批次不存在');
  }
  const currentVersionId = (db.prepare(`
    SELECT currentVersionId FROM batch_productions WHERE id = ?
  `).get(batchId) as { currentVersionId: string | null }).currentVersionId;
  if (!currentVersionId) {
    throw new BatchDomainError('conflict', '批次还没有版本');
  }
  const version = db.prepare(`
    SELECT id, versionNumber, copyCount, inputState FROM batch_production_versions WHERE id = ?
  `).get(currentVersionId) as {
    id: string;
    versionNumber: number;
    copyCount: number;
    inputState: 'draft' | 'frozen';
  };
  const scriptSnapshotRows = db.prepare(`
    SELECT id, sourceScriptId, title, bodyText, sourceVersion, coverTitleJson,
           copyCount, shotSetId, contentRevision
    FROM batch_script_snapshots WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(currentVersionId) as Array<{
    id: string;
    sourceScriptId: string;
    title: string;
    bodyText: string;
    sourceVersion: string;
    coverTitleJson: string;
    copyCount: number;
    shotSetId: string;
    contentRevision: string;
  }>;
  const scriptSnapshots = scriptSnapshotRows.map(({ coverTitleJson, ...snapshot }) => {
    let primary = '';
    let secondary = '';
    try {
      const parsed = JSON.parse(coverTitleJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        primary = typeof record.primary === 'string' ? record.primary : '';
        secondary = typeof record.secondary === 'string' ? record.secondary : '';
      }
    } catch {
      // 历史无效标题 JSON 不阻塞批次详情；正文与普通标题仍可追溯。
    }
    return { ...snapshot, coverTitle: { primary, secondary } };
  });
  const assetPool = listPoolItems(db, currentVersionId).map(({ id, assetId, analysisId, colorJson }) => ({
    id,
    assetId,
    analysisId,
    colorSnapshot: upgradeColorSnapshot(parseJsonOrRaw(colorJson)),
  }));
  const outputPlans = listOutputPlans(db, currentVersionId).map(({ id, seq }) => ({ id, seq }));
  return {
    batch,
    version: { ...version, inputState: version.inputState },
    scriptSnapshots,
    assetPool,
    outputPlans,
  };
}
