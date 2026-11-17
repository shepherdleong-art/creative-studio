import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { parsePackagingConfig } from '../media-core/packaging-vars.ts';
import { resolvePackagingDir } from '../media-core/packaging-runtime.ts';
import type { PackagingStickerPlanningAsset } from '../media-core/packaging-sticker-planner.ts';
import {
  PackagingStickerError,
  validatePackagingStickerDefaults,
  validatePackagingStickers,
  type PackagingStickerDefaults,
  type PackagingStickerInstance,
} from '../media-core/packaging-stickers.ts';
import {
  assertPackagingStickerVariantTarget,
  planPackagingStickerVariants,
  type PackagingStickerVariantIdRequest,
} from '../media-core/packaging-sticker-variants.ts';
import { BatchDomainError } from './errors.ts';

export interface BatchPackagingStickerSnapshot {
  stickers?: PackagingStickerInstance[];
  stickerDefaults?: PackagingStickerDefaults;
}

export interface BatchStickerCopyTarget {
  planId: string;
  expectedOutputVersionId: string;
  expectedEditRevision: number;
}

export interface BatchStickerCopyInput {
  sourcePlanId: string;
  targets: readonly BatchStickerCopyTarget[];
}

export interface BatchStickerRestoreTarget extends BatchStickerCopyTarget {
  snapshot: BatchPackagingStickerSnapshot;
}

export interface BatchStickerRestoreInput {
  targets: readonly BatchStickerRestoreTarget[];
}

export interface BatchStickerTargetMutationResult {
  planId: string;
  outputVersionId: string;
  beforeEditRevision: number;
  afterEditRevision: number;
  reviewCleared: boolean;
  before: BatchPackagingStickerSnapshot;
  after: BatchPackagingStickerSnapshot;
}

export interface BatchStickerMutationResult {
  targets: BatchStickerTargetMutationResult[];
}

export interface BatchStickerCopyDependencies {
  random?: () => number;
  createId?: (request: PackagingStickerVariantIdRequest) => string;
}

interface LineageRow {
  batchVersionId: string;
  currentVersionId: string | null;
  arrangementJson: string | null;
  inputState: 'draft' | 'frozen';
  controlState: 'running' | 'paused' | 'stopped';
  batchCurrentVersionId: string | null;
}

interface OutputContext {
  planId: string;
  batchVersionId: string;
  outputVersionId: string;
  editRevision: number;
  bodyFrames: number;
  arrangement: Record<string, unknown>;
  packaging: Record<string, unknown>;
  config: ReturnType<typeof parsePackagingConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readEditRevision(arrangement: Record<string, unknown>): number {
  const value = Number(arrangement.editRevision);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function readBodyFrames(arrangement: Record<string, unknown>): number {
  const clips = Array.isArray(arrangement.clips) ? arrangement.clips : [];
  const last = clips.at(-1);
  const lastClip = isRecord(last) ? last : null;
  const visualDurationUs = lastClip ? Number(lastClip.timelineEndUs) : 0;
  const narration = isRecord(arrangement.narration) ? Number(arrangement.narration.durationUs) : 0;
  const durationUs = Math.max(
    Number.isFinite(visualDurationUs) && visualDurationUs > 0 ? visualDurationUs : 0,
    Number.isFinite(narration) && narration > 0 ? narration : 0,
  );
  return Math.floor(durationUs / 1e6 * FINAL_EDIT_FPS + 1e-6);
}

function readLineage(db: Database.Database, projectId: string, batchId: string, planId: string): LineageRow {
  const row = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId, o.arrangementJson,
           v.inputState, b.controlState, b.currentVersionId AS batchCurrentVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    LEFT JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as LineageRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '成片计划不存在');
  return row;
}

function readOutputContext(db: Database.Database, projectId: string, batchId: string, planId: string): OutputContext {
  const lineage = readLineage(db, projectId, batchId, planId);
  if (lineage.inputState !== 'frozen') throw new BatchDomainError('conflict', '批次尚未冻结，不能复制或恢复贴纸');
  if (lineage.controlState === 'stopped') throw new BatchDomainError('conflict', '批次已停止，不能复制或恢复贴纸');
  if (!lineage.batchCurrentVersionId || lineage.batchVersionId !== lineage.batchCurrentVersionId) {
    throw new BatchDomainError('conflict', '成片计划不属于批次当前版本，不能复制或恢复贴纸');
  }
  if (!lineage.currentVersionId) throw new BatchDomainError('conflict', '成片还没有候选版本，不能复制或恢复贴纸');
  const arrangement = parseJson(lineage.arrangementJson);
  if (!isRecord(arrangement)) throw new BatchDomainError('conflict', '成片安排数据无效，不能复制或恢复贴纸');
  const packaging = isRecord(arrangement.packaging) ? arrangement.packaging : {};
  return {
    planId,
    batchVersionId: lineage.batchVersionId,
    outputVersionId: lineage.currentVersionId,
    editRevision: readEditRevision(arrangement),
    bodyFrames: readBodyFrames(arrangement),
    arrangement,
    packaging,
    config: parsePackagingConfig(packaging),
  };
}

function assertPackagingEnabled(context: OutputContext, role: '来源' | '目标'): void {
  if (!context.config.enabled) throw new BatchDomainError('conflict', `${role}成片包装未开启，不能复制或恢复贴纸`);
}

function assertExpectedVersion(context: OutputContext, target: BatchStickerCopyTarget): void {
  if (context.outputVersionId !== target.expectedOutputVersionId || context.editRevision !== target.expectedEditRevision) {
    throw new BatchDomainError('conflict', `目标成片 ${context.planId} 已有更新的正式修订，请刷新后重试`);
  }
}

function readStoredSnapshot(packaging: Record<string, unknown>, bodyFrames: number): BatchPackagingStickerSnapshot {
  const snapshot: BatchPackagingStickerSnapshot = {};
  if (hasOwn(packaging, 'stickers')) snapshot.stickers = validatePackagingStickers(packaging.stickers, bodyFrames);
  if (hasOwn(packaging, 'stickerDefaults')) snapshot.stickerDefaults = validatePackagingStickerDefaults(packaging.stickerDefaults);
  return snapshot;
}

function readRestoreSnapshot(value: unknown, bodyFrames: number): BatchPackagingStickerSnapshot {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'stickers' && key !== 'stickerDefaults')) {
    throw new BatchDomainError('invalid_input', '贴纸恢复快照只允许 stickers 与 stickerDefaults 字段');
  }
  const snapshot: BatchPackagingStickerSnapshot = {};
  if (hasOwn(value, 'stickers')) snapshot.stickers = validatePackagingStickers(value.stickers, bodyFrames);
  if (hasOwn(value, 'stickerDefaults')) snapshot.stickerDefaults = validatePackagingStickerDefaults(value.stickerDefaults);
  return snapshot;
}

function assertTargetList(sourcePlanId: string | null, targets: readonly unknown[]): void {
  if (targets.length === 0) throw new BatchDomainError('invalid_input', '至少选择一个目标成片');
  const planIds = new Set<string>();
  for (const value of targets) {
    if (!isRecord(value) || !nonEmptyString(value.planId)
      || !nonEmptyString(value.expectedOutputVersionId)
      || !Number.isSafeInteger(value.expectedEditRevision) || Number(value.expectedEditRevision) < 0) {
      throw new BatchDomainError('invalid_input', '目标成片需要有效的 planId、expectedOutputVersionId 与 expectedEditRevision');
    }
    const planId = value.planId.trim();
    if (sourcePlanId && planId === sourcePlanId) throw new BatchDomainError('invalid_input', '来源成片不能复制到自身');
    if (planIds.has(planId)) throw new BatchDomainError('invalid_input', '目标成片不能重复');
    planIds.add(planId);
  }
}

function cloneSnapshot(snapshot: BatchPackagingStickerSnapshot): BatchPackagingStickerSnapshot {
  return structuredClone(snapshot);
}

function applySnapshot(packaging: Record<string, unknown>, snapshot: BatchPackagingStickerSnapshot): void {
  delete packaging.stickers;
  delete packaging.stickerDefaults;
  if (snapshot.stickers !== undefined) packaging.stickers = structuredClone(snapshot.stickers);
  if (snapshot.stickerDefaults !== undefined) packaging.stickerDefaults = structuredClone(snapshot.stickerDefaults);
}

function writeTarget(
  db: Database.Database,
  context: OutputContext,
  before: BatchPackagingStickerSnapshot,
  after: BatchPackagingStickerSnapshot,
): BatchStickerTargetMutationResult {
  const reviewCleared = context.arrangement.review !== undefined && context.arrangement.review !== null;
  applySnapshot(context.packaging, after);
  context.arrangement.packaging = context.packaging;
  context.arrangement.editRevision = context.editRevision + 1;
  delete context.arrangement.review;
  const updated = db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ? AND planId = ?`)
    .run(JSON.stringify(context.arrangement), context.outputVersionId, context.planId);
  if (updated.changes !== 1) throw new BatchDomainError('conflict', `目标成片 ${context.planId} 写入失败，本次操作已回滚`);
  return {
    planId: context.planId,
    outputVersionId: context.outputVersionId,
    beforeEditRevision: context.editRevision,
    afterEditRevision: context.editRevision + 1,
    reviewCleared,
    before: cloneSnapshot(before),
    after: cloneSnapshot(after),
  };
}

function readPlanningAssets(): PackagingStickerPlanningAsset[] {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(resolvePackagingDir(), 'stickers', 'catalog.json'), 'utf8')) as unknown;
    if (!isRecord(catalog) || !Array.isArray(catalog.assets)) throw new Error('invalid catalog');
    return catalog.assets as PackagingStickerPlanningAsset[];
  } catch {
    throw new BatchDomainError('invalid_input', '贴纸素材目录不可用，无法复制贴纸');
  }
}

function mapStickerError(error: unknown): never {
  if (error instanceof PackagingStickerError) throw new BatchDomainError('invalid_input', error.message);
  throw error;
}

/** 在一个事务中把来源贴纸方案复制到多个当前目标；来源及目标的其他编辑字段均不改写。 */
export function copyBatchOutputStickers(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: BatchStickerCopyInput,
  dependencies: BatchStickerCopyDependencies = {},
): BatchStickerMutationResult {
  try {
    // 目录读取必须在 SQLite 事务外完成；事务中只有同步领域规划与数据库读写。
    const assets = readPlanningAssets();
    return db.transaction(() => {
      if (!nonEmptyString(input.sourcePlanId)) throw new BatchDomainError('invalid_input', '缺少来源成片 planId');
      const sourcePlanId = input.sourcePlanId.trim();
      assertTargetList(sourcePlanId, input.targets);
      const source = readOutputContext(db, projectId, batchId, sourcePlanId);
      assertPackagingEnabled(source, '来源');
      const sourceSnapshot = readStoredSnapshot(source.packaging, source.bodyFrames);
      const sourceStickers = sourceSnapshot.stickers ?? [];
      if (sourceStickers.length === 0) throw new BatchDomainError('invalid_input', '来源成片没有贴纸，无法复制');

      const contexts = input.targets.map((target) => {
        const context = readOutputContext(db, projectId, batchId, target.planId.trim());
        if (context.batchVersionId !== source.batchVersionId) throw new BatchDomainError('conflict', '来源与目标必须属于同一批次版本');
        assertExpectedVersion(context, target);
        assertPackagingEnabled(context, '目标');
        assertPackagingStickerVariantTarget({
          sourceBodyFrames: source.bodyFrames,
          targetBodyFrames: context.bodyFrames,
          sourceStickers,
        });
        return { context, before: readStoredSnapshot(context.packaging, context.bodyFrames) };
      });

      const plans = planPackagingStickerVariants({
        sourceBodyFrames: source.bodyFrames,
        sourceStickers,
        targets: contexts.map(({ context }) => ({
          targetId: context.planId,
          bodyFrames: context.bodyFrames,
          template: context.config.template,
        })),
        assets,
        random: dependencies.random ?? Math.random,
        createId: dependencies.createId ?? ((request) => `${request.kind === 'sticker' ? 'sticker' : 'group'}_${randomUUID()}`),
      });
      const results = contexts.map(({ context, before }, index) => {
        const after: BatchPackagingStickerSnapshot = {
          stickers: validatePackagingStickers(plans[index].stickers, context.bodyFrames),
          ...(sourceSnapshot.stickerDefaults === undefined ? {} : { stickerDefaults: structuredClone(sourceSnapshot.stickerDefaults) }),
        };
        return writeTarget(db, context, before, after);
      });
      return { targets: results };
    })();
  } catch (error) {
    mapStickerError(error);
  }
}

/** 按每片期望版本与修订门禁整体恢复贴纸字段；任一片冲突时不写入任何目标。 */
export function restoreBatchOutputStickers(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: BatchStickerRestoreInput,
): BatchStickerMutationResult {
  try {
    return db.transaction(() => {
      assertTargetList(null, input.targets);
      const contexts = input.targets.map((target) => {
        const context = readOutputContext(db, projectId, batchId, target.planId.trim());
        assertExpectedVersion(context, target);
        assertPackagingEnabled(context, '目标');
        return {
          context,
          before: readStoredSnapshot(context.packaging, context.bodyFrames),
          after: readRestoreSnapshot(target.snapshot, context.bodyFrames),
        };
      });
      const batchVersionId = contexts[0].context.batchVersionId;
      for (const { context } of contexts) {
        if (context.batchVersionId !== batchVersionId) throw new BatchDomainError('conflict', '恢复目标必须属于同一批次版本');
      }
      return {
        targets: contexts.map(({ context, before, after }) => writeTarget(db, context, before, after)),
      };
    })();
  } catch (error) {
    mapStickerError(error);
  }
}
