import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  allocateBatch,
  reallocateOutput,
  type AllocationNarrationInput,
  type AllocationSegmentInput,
  type AllocationOutput,
  type AllocationResult,
  type FrozenBatchInput,
} from './allocator.ts';
import { BatchDomainError } from './errors.ts';
import { BATCH_ALLOCATION_RULE_VERSION } from './allocator.ts';
import { resolveAllocationMusicTrackIds } from './bgm.ts';
import { extractMatchKeywords } from '../media-core/match-keywords.ts';
import {
  buildBatchScenes,
  buildBatchSentences,
  batchSemanticPoolKey,
  batchSemanticScriptKey,
  readBatchSemanticMatrix,
  type BatchSemanticMatrixRecord,
} from './semantic-match.ts';

type JsonRecord = Record<string, unknown>;

export interface AllocationStoreOptions {
  ruleVersion?: string;
  seed?: string | number;
  now?: () => Date;
  /** Exclusion changes may deliberately restore an older deterministic run. */
  restoreExistingRunPointers?: boolean;
}

export interface PersistedAllocationRun {
  runId: string;
  batchVersionId: string;
  ruleVersion: string;
  seed: string;
  inputFingerprint: string;
  created: boolean;
  result: AllocationResult;
  outputVersionIds: Record<string, string>;
}

export interface BatchAssetExclusionRow {
  id: string;
  batchVersionId: string;
  assetId: string;
  reason: string;
  createdAt: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return {}; }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function arrayOfRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
}

function numberFrom(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ownerForVersion(db: Database.Database, projectId: string, batchVersionId: string): {
  batchId: string;
  projectId: string;
  inputState: 'draft' | 'frozen';
} {
  const row = db.prepare(`
    SELECT b.id AS batchId, b.projectId, b.deletedAt, v.inputState
    FROM batch_production_versions v
    JOIN batch_productions b ON b.id = v.batchId
    WHERE v.id = ?
  `).get(batchVersionId) as {
    batchId: string;
    projectId: string;
    deletedAt: string | null;
    inputState: 'draft' | 'frozen';
  } | undefined;
  if (!row || row.deletedAt) throw new BatchDomainError('not_found', '批次版本不存在');
  if (row.projectId !== projectId) throw new BatchDomainError('invalid_input', '批次版本不属于该项目');
  return row;
}

function planSegments(planJson: JsonRecord): unknown[] {
  for (const key of ['segments', 'scriptSegments', 'beats']) {
    if (Array.isArray(planJson[key]) && planJson[key].length) return planJson[key] as unknown[];
  }
  return [];
}

function buildFrozenInput(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  options: AllocationStoreOptions = {},
): { input: FrozenBatchInput; owner: { batchId: string; projectId: string; inputState: 'draft' | 'frozen' } } {
  const owner = ownerForVersion(db, projectId, batchVersionId);
  if (owner.inputState !== 'frozen') {
    throw new BatchDomainError('conflict', '联合分配只能读取已经冻结的批次版本');
  }
  const version = db.prepare(`
    SELECT copyCount, defaultsJson FROM batch_production_versions WHERE id = ?
  `).get(batchVersionId) as { copyCount: number; defaultsJson: string } | undefined;
  if (!version) throw new BatchDomainError('not_found', '批次版本不存在');

  const snapshots = db.prepare(`
    SELECT id, sourceScriptId, title, bodyText, coverTitleJson, copyCount
    FROM batch_script_snapshots
    WHERE batchVersionId = ?
    ORDER BY createdAt, id
  `).all(batchVersionId) as Array<{
    id: string;
    sourceScriptId: string;
    title: string;
    bodyText: string;
    coverTitleJson: string;
    copyCount: number;
  }>;
  const plans = db.prepare(`
    SELECT p.id AS planId, p.scriptSnapshotId, p.seq, p.planJson,
           s.title, s.bodyText, s.coverTitleJson, s.copyCount, s.targetDurationSec,
           bs.projectId AS sourceProjectId, bs.sourceKind, bs.ownerBatchVersionId,
           ov.arrangementJson AS currentArrangementJson
    FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
    JOIN batch_scripts bs ON bs.id = s.sourceScriptId
    LEFT JOIN batch_output_versions ov ON ov.id = p.currentVersionId
    WHERE p.batchVersionId = ?
    ORDER BY p.seq, p.id
  `).all(batchVersionId) as Array<{
    planId: string;
    scriptSnapshotId: string;
    seq: number;
    planJson: string;
    title: string;
    bodyText: string;
    coverTitleJson: string;
    copyCount: number;
    targetDurationSec: number;
    currentArrangementJson: string | null;
    sourceProjectId: string;
    sourceKind: string;
    ownerBatchVersionId: string | null;
  }>;
  const expectedPlanCount = snapshots.reduce((sum, snapshot) => sum + snapshot.copyCount, 0);
  if (plans.length !== expectedPlanCount || plans.length !== version.copyCount) {
    throw new BatchDomainError('conflict', `成片计划数量不完整:应有 ${expectedPlanCount} 张,实际 ${plans.length} 张`);
  }
  const snapshotIds = new Set(snapshots.map((snapshot) => snapshot.id));
  if (plans.some((plan) => !snapshotIds.has(plan.scriptSnapshotId))) {
    throw new BatchDomainError('invalid_input', '成片计划引用了不属于该批次版本的脚本快照');
  }
  if (plans.some((plan) => plan.sourceProjectId !== projectId
    || (plan.sourceKind === 'external' && plan.ownerBatchVersionId !== batchVersionId))) {
    throw new BatchDomainError('invalid_input', '脚本快照来源不属于当前项目或批次版本');
  }

  const poolRows = db.prepare(`
    SELECT pool.assetId, pool.analysisId, pool.colorJson,
           assets.projectId, assets.contentFingerprint, assets.status, assets.mediaJson,
           analysis.analysisJson, analysis.assetId AS analysisAssetId, analysis.status AS analysisStatus
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    WHERE pool.batchVersionId = ?
    ORDER BY pool.createdAt, pool.id
  `).all(batchVersionId) as Array<{
    assetId: string;
    analysisId: string;
    colorJson: string;
    projectId: string;
    contentFingerprint: string;
    status: string;
    mediaJson: string;
    analysisJson: string;
    analysisAssetId: string;
    analysisStatus: string;
  }>;
  if (!poolRows.length) throw new BatchDomainError('conflict', '批次版本素材池为空');
  if (poolRows.some((row) => row.projectId !== projectId || row.analysisAssetId !== row.assetId)) {
    throw new BatchDomainError('invalid_input', '批次版本素材池存在跨项目或分析版本谱系');
  }

  const exclusions = db.prepare(`
    SELECT assetId, reason FROM batch_asset_exclusions WHERE batchVersionId = ? ORDER BY assetId
  `).all(batchVersionId) as Array<{ assetId: string; reason: string }>;
  const exclusionReasons = new Map(exclusions.map(({ assetId, reason }) => [assetId, reason]));
  for (const row of poolRows) {
    const automaticReasons = [
      row.status !== 'online' ? `素材状态为 ${row.status}` : '',
      row.analysisStatus !== 'ready' ? `分析状态为 ${row.analysisStatus}` : '',
    ].filter(Boolean);
    if (automaticReasons.length && !exclusionReasons.has(row.assetId)) {
      exclusionReasons.set(row.assetId, automaticReasons.join('；'));
    }
  }
  const normalizedExclusions = [...exclusionReasons]
    .map(([assetId, reason]) => ({ assetId, reason }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const lockedSegments: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    if (!plan.currentArrangementJson) continue;
    const arrangement = asRecord(parseJson(plan.currentArrangementJson));
    for (const clip of arrayOfRecords(arrangement.clips)) {
      if (clip.locked !== true) continue;
      lockedSegments.push({
        planId: plan.planId,
        segmentId: clip.segmentId,
        assetId: clip.assetId,
        contentFingerprint: clip.contentFingerprint,
        sourceStartUs: clip.sourceStartUs,
        sourceEndUs: clip.sourceEndUs,
      });
    }
  }

  const defaults = parseJson(version.defaultsJson);
  const musicTrackIds = resolveAllocationMusicTrackIds(defaults);
  // 口播先于分配:已核验口播(按 scriptSnapshotId 权威表)随冻结输入挂到
  // 每个 plan,分配器据此取真实对齐时间;无口播(失败/未生成)不挂,走估算。
  const narrationRows = db.prepare(`
    SELECT n.scriptSnapshotId, n.narrationJson
    FROM batch_script_narrations n
    JOIN batch_script_snapshots s ON s.id = n.scriptSnapshotId
    WHERE s.batchVersionId = ?
  `).all(batchVersionId) as Array<{ scriptSnapshotId: string; narrationJson: string }>;
  const narrationBySnapshot = new Map(narrationRows.map((row) => [row.scriptSnapshotId, parseJson(row.narrationJson)]));
  const narrationFor = (scriptSnapshotId: string): AllocationNarrationInput | undefined => {
    const snap = asRecord(narrationBySnapshot.get(scriptSnapshotId));
    if (snap.productionReady !== true || snap.mode !== 'local_ready') return undefined;
    const durationUs = Math.round(numberFrom(snap.durationUs, 0));
    const audioFingerprint = typeof snap.audioFingerprint === 'string' && snap.audioFingerprint.trim() ? snap.audioFingerprint.trim() : '';
    if (durationUs <= 0 || !audioFingerprint) return undefined;
    const segments = arrayOfRecords(snap.segments)
      .map((entry): AllocationNarrationInput['segments'][number] | null => {
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
        const sourceSegmentId = typeof entry.sourceSegmentId === 'string' && entry.sourceSegmentId.trim() ? entry.sourceSegmentId.trim() : id;
        const text = typeof entry.text === 'string' ? entry.text.trim() : '';
        const startUs = Math.round(numberFrom(entry.startUs, 0));
        const endUs = Math.round(numberFrom(entry.endUs, 0));
        if (!id || !sourceSegmentId || !text || !Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || endUs <= startUs || endUs > durationUs) return null;
        return { id, sourceSegmentId, text, startUs, endUs, timingSource: entry.timingSource === 'estimated' ? 'estimated' as const : 'aligned' as const };
      });
    if (segments.length === 0 || segments.some((segment) => segment === null)) return undefined;
    const wordTimings = Array.isArray(snap.wordTimings)
      ? snap.wordTimings.flatMap((entry): Array<{ text: string; startUs: number; endUs: number }> => {
        const record = asRecord(entry);
        const startUs = Math.round(numberFrom(record.startUs, 0));
        const endUs = Math.round(numberFrom(record.endUs, 0));
        return typeof record.text === 'string' && record.text.trim() && Number.isSafeInteger(startUs) && Number.isSafeInteger(endUs) && endUs > startUs
          ? [{ text: record.text.trim(), startUs, endUs }]
          : [];
      })
      : undefined;
    return {
      durationUs,
      audioFingerprint,
      segments: segments.filter((segment): segment is AllocationNarrationInput['segments'][number] => segment !== null),
      ...(wordTimings && wordTimings.length ? { wordTimings } : {}),
    };
  };
  // 语义矩阵按内容指纹同步读取(打分已在快照确认后由 semantic_score 任务落库);
  // 这里是同步装配路径,绝不发起 LLM 调用。无矩阵时仅挂 keywords,
  // 分配器自动退到关键词重合 + 质量兜底。
  const semanticScenes = buildBatchScenes(poolRows);
  const semanticPoolKey = semanticScenes.length ? batchSemanticPoolKey(semanticScenes) : null;
  const semanticMatrixCache = new Map<string, BatchSemanticMatrixRecord | undefined>();
  const semanticMatrixFor = (scriptKey: string | null): BatchSemanticMatrixRecord | undefined => {
    if (!scriptKey || !semanticPoolKey) return undefined;
    if (!semanticMatrixCache.has(scriptKey)) {
      semanticMatrixCache.set(scriptKey, readBatchSemanticMatrix(db, projectId, scriptKey, semanticPoolKey));
    }
    return semanticMatrixCache.get(scriptKey);
  };
  const input: FrozenBatchInput = {
    projectId,
    batchId: owner.batchId,
    batchVersionId,
    ruleVersion: options.ruleVersion ?? BATCH_ALLOCATION_RULE_VERSION,
    seed: options.seed ?? '0',
    defaultsJson: defaults,
    musicTrackIds,
    plans: plans.map((plan) => {
      const planJson = asRecord(parseJson(plan.planJson));
      const segmentsFromPlanJson = planSegments(planJson);
      const bodyRecord = asRecord(parseJson(plan.bodyText));
      const segmentsFromBody = Array.isArray(bodyRecord.segments) && bodyRecord.segments.length
        ? bodyRecord.segments
        : [];
      const historicalSegments = segmentsFromPlanJson.length ? segmentsFromPlanJson : segmentsFromBody;
      // 句段与 scriptKey 必须和打分 executor 完全一致(同一 bodyText、同一断句)。
      const sentences = buildBatchSentences(plan.bodyText);
      const matrix = semanticMatrixFor(sentences.length ? batchSemanticScriptKey(sentences) : null);
      const matrixScoresAt = (index: number) => matrix?.scores[`segment-${index + 1}`] ?? {};
      if (historicalSegments.length) {
        // 历史路径:planJson/bodyText 自带 segments,保留原 id 与时间字段,
        // 按数组 index 对齐补 keywords 与语义分。
        return {
          planId: plan.planId,
          scriptSnapshotId: plan.scriptSnapshotId,
          title: plan.title,
          segments: historicalSegments.map((segment, index) => {
            const record = asRecord(segment);
            const text = [record.text, record.narration, record.subtitle]
              .find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
            const hasKeywords = Array.isArray(record.keywords) && record.keywords.length > 0;
            return {
              ...record,
              ...(hasKeywords ? {} : { keywords: extractMatchKeywords(text) }),
              ...(matrix ? { semanticScores: matrixScoresAt(index), hookScores: matrix.hooks } : {}),
            };
          }) as AllocationSegmentInput[],
          planJson,
          scriptSnapshot: { targetDurationSec: plan.targetDurationSec },
          narration: narrationFor(plan.scriptSnapshotId),
        };
      }
      return {
        planId: plan.planId,
        scriptSnapshotId: plan.scriptSnapshotId,
        title: plan.title,
        // 显式 segments:不传 id,分配器仍按 `${planId}:segment:<i+1>` 生成,
        // 与改动前的句段身份完全一致(既有锁定/封面引用不受影响)。
        segments: sentences.map((sentence, index) => ({
          text: sentence.text,
          keywords: sentence.keywords,
          ...(matrix ? { semanticScores: matrixScoresAt(index), hookScores: matrix.hooks } : {}),
        })),
        planJson,
        scriptSnapshot: { targetDurationSec: plan.targetDurationSec },
        narration: narrationFor(plan.scriptSnapshotId),
      };
    }),
    assets: poolRows.map((row) => ({
      assetId: row.assetId,
      analysisId: row.analysisId,
      contentFingerprint: row.contentFingerprint,
      analysisJson: parseJson(row.analysisJson),
      durationUs: numberFrom(
        asRecord(parseJson(row.analysisJson)).durationUs
          ?? asRecord(parseJson(row.mediaJson)).durationUs,
      ),
      excluded: exclusionReasons.has(row.assetId),
      colorSnapshot: parseJson(row.colorJson),
    })) as FrozenBatchInput['assets'],
    exclusions: normalizedExclusions,
    excludedAssetIds: normalizedExclusions.map(({ assetId }) => assetId),
    lockedSegments: lockedSegments as unknown as FrozenBatchInput['locks'],
  };
  return { input, owner };
}

/** 只读 seam:供诊断/测试查看冻结输入组装,不触碰文件或供应商。 */
export function buildFrozenBatchInput(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  options: AllocationStoreOptions = {},
): FrozenBatchInput {
  return buildFrozenInput(db, projectId, batchVersionId, options).input;
}

function statusForResult(result: AllocationResult): 'completed' | 'partial' | 'blocked' {
  return result.status;
}

function readExistingRun(
  db: Database.Database,
  batchVersionId: string,
  ruleVersion: string,
  seed: string,
  inputFingerprint: string,
): PersistedAllocationRun | undefined {
  const row = db.prepare(`
    SELECT id, batchVersionId, ruleVersion, seed, inputFingerprint, resultJson
    FROM batch_allocation_runs
    WHERE batchVersionId = ? AND ruleVersion = ? AND seed = ? AND inputFingerprint = ?
    LIMIT 1
  `).get(batchVersionId, ruleVersion, seed, inputFingerprint) as {
    id: string;
    batchVersionId: string;
    ruleVersion: string;
    seed: string;
    inputFingerprint: string;
    resultJson: string;
  } | undefined;
  if (!row) return undefined;
  const result = parseJson(row.resultJson) as AllocationResult;
  const versions = db.prepare(`
    SELECT id, planId FROM batch_output_versions WHERE allocationRunId = ?
  `).all(row.id) as Array<{ id: string; planId: string }>;
  return {
    runId: row.id,
    batchVersionId: row.batchVersionId,
    ruleVersion: row.ruleVersion,
    seed: row.seed,
    inputFingerprint: row.inputFingerprint,
    created: false,
    result,
    outputVersionIds: Object.fromEntries(versions.map((version) => [version.planId, version.id])),
  };
}

/**
 * A deterministic retry may rediscover an older run after a temporary input
 * change (for example exclude then restore one asset). Keep the plan pointers
 * aligned with that run without creating another output version; formal
 * artifact pointers are intentionally untouched.
 */
function restoreRunCurrentVersions(
  db: Database.Database,
  persisted: PersistedAllocationRun,
  overwriteExisting = true,
): void {
  for (const [planId, outputVersionId] of Object.entries(persisted.outputVersionIds)) {
    db.prepare(overwriteExisting ? `
        UPDATE batch_output_plans
        SET currentVersionId = ?
        WHERE id = ? AND batchVersionId = ?
      ` : `
        UPDATE batch_output_plans
        SET currentVersionId = ?
        WHERE id = ? AND batchVersionId = ? AND currentVersionId IS NULL
      `).run(outputVersionId, planId, persisted.batchVersionId);
  }
}

function activateAllocationRun(
  db: Database.Database,
  batchVersionId: string,
  runId: string,
): void {
  const updated = db.prepare(`
    UPDATE batch_production_versions SET currentAllocationRunId = ? WHERE id = ?
  `).run(runId, batchVersionId);
  if (updated.changes !== 1) throw new BatchDomainError('not_found', '批次版本不存在');
}

function persistResult(
  db: Database.Database,
  batchVersionId: string,
  result: AllocationResult,
  now?: () => Date,
  onlyPlanId?: string,
  writeOutputVersions = true,
): PersistedAllocationRun {
  const createdAt = nowIso(now);
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO batch_allocation_runs
      (id, batchVersionId, ruleVersion, seed, inputFingerprint, status, resultJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(runId, batchVersionId, result.ruleVersion, result.seed, result.inputFingerprint, statusForResult(result), JSON.stringify(result), createdAt);

  const outputVersionIds: Record<string, string> = {};
  const planOutputs = writeOutputVersions
    ? result.outputs.filter((output) => output.status === 'available' && (!onlyPlanId || output.planId === onlyPlanId))
    : [];
  for (const output of planOutputs) {
    const plan = db.prepare(`
      SELECT id, batchVersionId FROM batch_output_plans WHERE id = ? AND batchVersionId = ?
    `).get(output.planId, batchVersionId) as { id: string; batchVersionId: string } | undefined;
    if (!plan) throw new BatchDomainError('invalid_input', '分配结果引用了不属于该批次版本的成片计划');
    const existing = db.prepare(`
      SELECT MAX(versionNumber) AS maxVersion FROM batch_output_versions WHERE planId = ?
    `).get(output.planId) as { maxVersion: number | null };
    const versionNumber = (existing.maxVersion ?? 0) + 1;
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_output_versions
        (id, planId, versionNumber, arrangementJson, createdAt, allocationRunId)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, output.planId, versionNumber, JSON.stringify(output.arrangement), createdAt, runId);
    // 这里只更新“当前候选”指针;不接触 currentArtifactId,旧正式产物保持可见。
    db.prepare(`UPDATE batch_output_plans SET currentVersionId = ? WHERE id = ? AND batchVersionId = ?`).run(id, output.planId, batchVersionId);
    outputVersionIds[output.planId] = id;
  }
  activateAllocationRun(db, batchVersionId, runId);
  return { runId, batchVersionId, ruleVersion: result.ruleVersion, seed: result.seed, inputFingerprint: result.inputFingerprint, created: true, result, outputVersionIds };
}

/** 为已经冻结的批次版本执行一次联合分配并登记可用成片版本。 */
export function persistBatchAllocation(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  options: AllocationStoreOptions = {},
): PersistedAllocationRun {
  return db.transaction(() => {
    const { input } = buildFrozenInput(db, projectId, batchVersionId, options);
    const result = allocateBatch(input);
    const existing = readExistingRun(db, batchVersionId, result.ruleVersion, result.seed, result.inputFingerprint);
    if (existing) {
      // PUT /start is also the frozen recovery seam. It may be retried after
      // the user has deliberately reallocated individual plans; recovering
      // the original batch run must fill only missing pointers, never roll
      // those later per-plan decisions back.
      const latestRun = db.prepare(`
        SELECT seed, inputFingerprint FROM batch_allocation_runs
        WHERE batchVersionId = ? ORDER BY createdAt DESC, id DESC LIMIT 1
      `).get(batchVersionId) as { seed: string; inputFingerprint: string } | undefined;
      const inputWasDeliberatelyChanged = Boolean(
        latestRun
        && latestRun.seed === result.seed
        && latestRun.inputFingerprint !== result.inputFingerprint,
      );
      restoreRunCurrentVersions(
        db,
        existing,
        options.restoreExistingRunPointers === true || inputWasDeliberatelyChanged,
      );
      activateAllocationRun(db, batchVersionId, existing.runId);
      return existing;
    }
    return persistResult(db, batchVersionId, result, options.now);
  })();
}

/** 与 persistBatchAllocation 同义的工作区 seam 名称。 */
export const allocateBatchVersion = persistBatchAllocation;
export const runBatchAllocation = persistBatchAllocation;
export const persistAllocation = persistBatchAllocation;
export const createAllocationRun = persistBatchAllocation;

/**
 * 只重分配目标计划。目标无可用新安排或与当前安排完全相同时，不增加成片版本；
 * 旧 candidate 和旧正式产物都继续保留。
 */
export function persistOutputReallocation(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  targetPlanId: string,
  reason = 'manual',
  options: AllocationStoreOptions = {},
): PersistedAllocationRun {
  return db.transaction(() => {
    const { input } = buildFrozenInput(db, projectId, batchVersionId, options);
    const currentRunRow = db.prepare(`
      SELECT r.id, r.resultJson, r.ruleVersion, r.seed, r.inputFingerprint
      FROM batch_production_versions v
      JOIN batch_allocation_runs r ON r.id = v.currentAllocationRunId
      WHERE v.id = ? AND r.batchVersionId = v.id
    `).get(batchVersionId) as { id: string; resultJson: string; ruleVersion: string; seed: string; inputFingerprint: string } | undefined;
    if (!currentRunRow) throw new BatchDomainError('conflict', '批次版本尚未有联合分配运行');
    const targetPlan = db.prepare(`SELECT id, currentVersionId FROM batch_output_plans WHERE id = ? AND batchVersionId = ?`).get(targetPlanId, batchVersionId) as { id: string; currentVersionId: string | null } | undefined;
    if (!targetPlan) throw new BatchDomainError('not_found', '成片计划不属于该批次版本');
    // Reallocation seeds derive from the original run seed plus the target plan's
    // current version pointer. A retry from the same state (network retry / double
    // click) still hits the same run idempotently; once a reallocation succeeds the
    // pointer has advanced, so the next「换一批画面」click derives a fresh seed and
    // must produce a new run instead of replaying the previous footage.
    const baseSeed = currentRunRow.seed.split(':reallocate:')[0] ?? currentRunRow.seed;
    const seed = String(options.seed ?? `${baseSeed}:reallocate:${targetPlanId}:${reason}:${targetPlan.currentVersionId ?? 'none'}`);
    const result = reallocateOutput({ ...input, seed }, parseJson(currentRunRow.resultJson), targetPlanId, reason);
    const existing = readExistingRun(db, batchVersionId, result.ruleVersion, result.seed, result.inputFingerprint);
    if (existing) {
      restoreRunCurrentVersions(db, existing);
      activateAllocationRun(db, batchVersionId, existing.runId);
      return existing;
    }

    const currentArrangementRow = db.prepare(`
      SELECT ov.arrangementJson FROM batch_output_plans p
      LEFT JOIN batch_output_versions ov ON ov.id = p.currentVersionId
      WHERE p.id = ? AND p.batchVersionId = ?
    `).get(targetPlanId, batchVersionId) as { arrangementJson: string | null } | undefined;
    const currentArrangement = currentArrangementRow?.arrangementJson ? parseJson(currentArrangementRow.arrangementJson) : null;
    const targetOutput = result.outputs.find((output) => output.planId === targetPlanId);
    if (!targetOutput || targetOutput.status !== 'available') {
      return persistResult(db, batchVersionId, result, options.now, targetPlanId);
    }
    if (currentArrangement && canonicalJson(currentArrangement) === canonicalJson(targetOutput.arrangement)) {
      const noBetterOutput: AllocationOutput = {
        ...targetOutput,
        warnings: [...new Set([...targetOutput.warnings, 'no-better-arrangement'])].sort(),
        arrangement: {
          ...targetOutput.arrangement,
          warnings: [...new Set([...targetOutput.arrangement.warnings, 'no-better-arrangement'])].sort(),
        },
      };
      const noBetterResult: AllocationResult = {
        ...result,
        warnings: [...new Set([...result.warnings, 'no-better-arrangement'])].sort(),
        outputs: result.outputs.map((output) => output.planId === targetPlanId ? noBetterOutput : output),
      };
      noBetterResult.plans = noBetterResult.outputs;
      return persistResult(db, batchVersionId, noBetterResult, options.now, targetPlanId, false);
    }
    return persistResult(db, batchVersionId, result, options.now, targetPlanId);
  })();
}

export const reallocateBatchOutput = persistOutputReallocation;
export const persistAllocationReallocation = persistOutputReallocation;

/** 记录批次版本内的素材排除,不修改项目素材本身。 */
export function setBatchAssetExclusion(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  assetId: string,
  reason = '',
  now?: () => Date,
): BatchAssetExclusionRow {
  return db.transaction(() => {
    ownerForVersion(db, projectId, batchVersionId);
    const asset = db.prepare(`SELECT projectId FROM batch_assets WHERE id = ?`).get(assetId) as { projectId: string } | undefined;
    if (!asset) throw new BatchDomainError('not_found', '素材不存在');
    if (asset.projectId !== projectId) throw new BatchDomainError('invalid_input', '素材不属于该项目');
    const pool = db.prepare(`SELECT 1 FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?`).get(batchVersionId, assetId);
    if (!pool) throw new BatchDomainError('invalid_input', '素材不属于该批次版本素材池');
    const existing = db.prepare(`SELECT id, createdAt FROM batch_asset_exclusions WHERE batchVersionId = ? AND assetId = ?`).get(batchVersionId, assetId) as { id: string; createdAt: string } | undefined;
    const createdAt = existing?.createdAt ?? nowIso(now);
    const id = existing?.id ?? randomUUID();
    db.prepare(`
      INSERT INTO batch_asset_exclusions (id, batchVersionId, assetId, reason, createdAt)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(batchVersionId, assetId) DO UPDATE SET reason = excluded.reason
    `).run(id, batchVersionId, assetId, reason, createdAt);
    return { id, batchVersionId, assetId, reason, createdAt };
  })();
}

export const excludeBatchAsset = setBatchAssetExclusion;

export function clearBatchAssetExclusion(db: Database.Database, projectId: string, batchVersionId: string, assetId: string): void {
  ownerForVersion(db, projectId, batchVersionId);
  db.prepare(`DELETE FROM batch_asset_exclusions WHERE batchVersionId = ? AND assetId = ?`).run(batchVersionId, assetId);
}

export const removeBatchAssetExclusion = clearBatchAssetExclusion;

export function listBatchAssetExclusions(db: Database.Database, projectId: string, batchVersionId: string): BatchAssetExclusionRow[] {
  ownerForVersion(db, projectId, batchVersionId);
  return db.prepare(`
    SELECT e.id, e.batchVersionId, e.assetId, e.reason, e.createdAt
    FROM batch_asset_exclusions e
    JOIN batch_asset_pool_items pool ON pool.batchVersionId = e.batchVersionId AND pool.assetId = e.assetId
    WHERE e.batchVersionId = ? ORDER BY e.assetId
  `).all(batchVersionId) as BatchAssetExclusionRow[];
}
