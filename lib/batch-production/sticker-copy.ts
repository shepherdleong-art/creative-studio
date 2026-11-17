import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { parsePackagingConfig, type FinalEditPackagingConfig } from '../media-core/packaging-vars.ts';
import { resolveLayoutRuntimeBundleVersion, sanitizePackagingLayoutResolution, type PackagingLayoutResolution } from '../media-core/packaging-auto-layout.ts';
import type { PackagingAutoLayoutResult } from '../media-core/packaging-auto-layout-service.ts';
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
  pointCuesLayoutVersion?: number;
  layoutRuntimeBundleVersion?: number;
  layoutResolution?: PackagingLayoutResolution;
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
  /** v2 目标的规范布局预检；在数据库事务外逐目标调用，失败则整批零写入。 */
  resolveLayout?: (input: { planId: string; config: FinalEditPackagingConfig; bodyFrames: number }) => Promise<PackagingAutoLayoutResult>;
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
  rawArrangementJson: string;
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
    rawArrangementJson: lineage.arrangementJson!,
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

const SNAPSHOT_KEYS = new Set(['stickers', 'stickerDefaults', 'pointCuesLayoutVersion', 'layoutRuntimeBundleVersion', 'layoutResolution']);

function readStoredSnapshot(packaging: Record<string, unknown>, bodyFrames: number): BatchPackagingStickerSnapshot {
  const snapshot: BatchPackagingStickerSnapshot = {};
  if (hasOwn(packaging, 'stickers')) snapshot.stickers = validatePackagingStickers(packaging.stickers, bodyFrames);
  if (hasOwn(packaging, 'stickerDefaults')) snapshot.stickerDefaults = validatePackagingStickerDefaults(packaging.stickerDefaults);
  if (typeof packaging.pointCuesLayoutVersion === 'number') snapshot.pointCuesLayoutVersion = packaging.pointCuesLayoutVersion;
  if (typeof packaging.layoutRuntimeBundleVersion === 'number') snapshot.layoutRuntimeBundleVersion = packaging.layoutRuntimeBundleVersion;
  if (hasOwn(packaging, 'layoutResolution')) {
    const resolution = sanitizePackagingLayoutResolution(packaging.layoutResolution);
    if (resolution) snapshot.layoutResolution = resolution;
  }
  return snapshot;
}

function readRestoreSnapshot(value: unknown, bodyFrames: number): BatchPackagingStickerSnapshot {
  if (!isRecord(value) || Object.keys(value).some((key) => !SNAPSHOT_KEYS.has(key))) {
    throw new BatchDomainError('invalid_input', '贴纸恢复快照包含不支持的字段');
  }
  const snapshot: BatchPackagingStickerSnapshot = {};
  if (hasOwn(value, 'stickers')) snapshot.stickers = validatePackagingStickers(value.stickers, bodyFrames);
  if (hasOwn(value, 'stickerDefaults')) snapshot.stickerDefaults = validatePackagingStickerDefaults(value.stickerDefaults);
  if (value.pointCuesLayoutVersion !== undefined) {
    if (typeof value.pointCuesLayoutVersion !== 'number' || ![1, 2].includes(value.pointCuesLayoutVersion)) throw new BatchDomainError('invalid_input', '快照卖点布局版本无效');
    snapshot.pointCuesLayoutVersion = value.pointCuesLayoutVersion;
  }
  if (value.layoutRuntimeBundleVersion !== undefined) {
    if (typeof value.layoutRuntimeBundleVersion !== 'number' || ![1, 2].includes(value.layoutRuntimeBundleVersion)) throw new BatchDomainError('invalid_input', '快照运行时版本无效');
    snapshot.layoutRuntimeBundleVersion = value.layoutRuntimeBundleVersion;
  }
  if (hasOwn(value, 'layoutResolution')) {
    const resolution = sanitizePackagingLayoutResolution(value.layoutResolution);
    if (!resolution) throw new BatchDomainError('invalid_input', '快照布局解析结果无效');
    snapshot.layoutResolution = resolution;
  }
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
  for (const key of SNAPSHOT_KEYS) delete packaging[key];
  if (snapshot.stickers !== undefined) packaging.stickers = structuredClone(snapshot.stickers);
  if (snapshot.stickerDefaults !== undefined) packaging.stickerDefaults = structuredClone(snapshot.stickerDefaults);
  if (snapshot.pointCuesLayoutVersion !== undefined) packaging.pointCuesLayoutVersion = snapshot.pointCuesLayoutVersion;
  if (snapshot.layoutRuntimeBundleVersion !== undefined) packaging.layoutRuntimeBundleVersion = snapshot.layoutRuntimeBundleVersion;
  if (snapshot.layoutResolution !== undefined) packaging.layoutResolution = structuredClone(snapshot.layoutResolution);
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

/** 事务外一次生成随机候选并逐目标 CLS 预检；事务内双侧重验后整体提交，任一片失败全部零写入。 */
export async function copyBatchOutputStickers(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: BatchStickerCopyInput,
  dependencies: BatchStickerCopyDependencies = {},
): Promise<BatchStickerMutationResult> {
  try {
    const assets = readPlanningAssets();
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

    const afterSnapshots: BatchPackagingStickerSnapshot[] = [];
    for (const [index, { context }] of contexts.entries()) {
      const stickers = validatePackagingStickers(plans[index].stickers, context.bodyFrames);
      const layoutRuntimeBundleVersion = resolveLayoutRuntimeBundleVersion({
        previous: context.config.layoutRuntimeBundleVersion,
        pointCuesLayoutVersion: context.config.pointCuesLayoutVersion,
        stickers,
      });
      const after: BatchPackagingStickerSnapshot = {
        stickers,
        ...(sourceSnapshot.stickerDefaults === undefined ? {} : { stickerDefaults: structuredClone(sourceSnapshot.stickerDefaults) }),
        ...(context.config.pointCuesLayoutVersion !== undefined ? { pointCuesLayoutVersion: context.config.pointCuesLayoutVersion } : {}),
        ...(layoutRuntimeBundleVersion !== undefined ? { layoutRuntimeBundleVersion } : {}),
      };
      if (layoutRuntimeBundleVersion === 2) {
        if (!dependencies.resolveLayout) throw new BatchDomainError('conflict', '自动布局服务不可用，无法复制到新布局版本成片');
        const baseConfig = { ...context.config };
        delete baseConfig.layoutResolution;
        const resolution = await dependencies.resolveLayout({
          planId: context.planId,
          config: { ...baseConfig, stickers, layoutRuntimeBundleVersion: 2 },
          bodyFrames: context.bodyFrames,
        });
        if (resolution.status !== 'resolved') {
          throw new BatchDomainError('conflict', `目标成片 ${context.planId}：${resolution.status === 'budget_exceeded' ? '自动布局计算未完成，请重试' : '上 40% 空间不足，请移开手动元素后重试'}`);
        }
        after.layoutResolution = resolution;
      }
      afterSnapshots.push(after);
    }

    return db.transaction(() => {
      const latestSource = readOutputContext(db, projectId, batchId, sourcePlanId);
      if (latestSource.rawArrangementJson !== source.rawArrangementJson) {
        throw new BatchDomainError('conflict', '来源成片已被修改，请刷新后重试');
      }
      const results = contexts.map(({ context, before }, index) => {
        const latest = readOutputContext(db, projectId, batchId, context.planId);
        assertExpectedVersion(latest, {
          planId: context.planId,
          expectedOutputVersionId: context.outputVersionId,
          expectedEditRevision: context.editRevision,
        });
        if (latest.rawArrangementJson !== context.rawArrangementJson) {
          throw new BatchDomainError('conflict', `目标成片 ${context.planId} 已被修改，请刷新后重试`);
        }
        return writeTarget(db, context, before, afterSnapshots[index]);
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
