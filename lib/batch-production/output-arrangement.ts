import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveBatchBgmParams } from './batch-renderer.ts';
import { BatchDomainError } from './errors.ts';

/**
 * 检查成片的片段级编辑（等长 trim / replace、变长修剪、删除、插入、分割）
 * 与编辑器数据视图。
 *
 * 片段级真相在 batch_output_versions.arrangementJson 的 clips[]；编辑是
 * 「就地改当前候选版本 arrangement + 重渲染同一版本」（与换封面同一先例），
 * 不产生新成片版本。每次视觉变化生效的编辑把 editRevision +1 并删除 $.review
 * （画面变了必须重新审核，与正式发布门禁对齐）；editRevision 进渲染
 * requestKey（见 phase-e.ts），保证 createBatchTask 幂等去重不会吞掉重渲染。
 *
 * 变长修剪/删除/插入都执行 ripple（依次首尾相接）；分割是纯结构操作，
 * 总长不变，不递增 editRevision、不清 review、不触发重渲染。
 */

/** 24fps 一帧的微秒数：客户端按帧换算 µs 提交时的取整误差容差。 */
const FRAME_TOLERANCE_US = Math.round(1_000_000 / 24); // 41667

/** 与单条 12 帧最短惯例一致的自由编辑最短片段长度。 */
const MIN_CLIP_DURATION_US = 500_000;

const FPS = 24;

export interface BatchOutputClipView {
  clipId: string;
  segmentId: string;
  assetId: string;
  contentFingerprint: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  locked: boolean;
}

export interface BatchOutputPoolAssetView {
  assetId: string;
  displayName: string;
  durationSec: number | null;
  contentFingerprint: string;
  thumbnailUrl: string;
  /** 代理预览地址（LUT 已烧入，色彩与正式渲染一致）。 */
  previewUrl: string;
  /** 已被排除出本批次联合分配（不可用于替换/插入）。 */
  excluded: boolean;
  /** 本批次版本中，当前候选画面用到该素材（片段或封面）的全部成片计划。 */
  usedByPlanIds: string[];
}

export interface BatchOutputClipEditView {
  planId: string;
  batchVersionId: string;
  outputVersionId: string | null;
  versionNumber: number | null;
  /** 当前版本存在、批次已冻结且未停止，才允许片段编辑。 */
  editable: boolean;
  editRevision: number;
  /** 当前片段的真实画面结尾时间（last clip timelineEndUs）。 */
  visualDurationUs: number;
  clips: BatchOutputClipView[];
  narration: { audioRelativePath: string | null; durationUs: number | null };
  subtitleCues: Array<{ startUs: number; endUs: number; text: string }>;
  coverAssetId: string | null;
  music: { trackId: string | null; gainDb: number; fadeInSec: number; fadeOutSec: number };
  poolAssets: BatchOutputPoolAssetView[];
}

export type BatchOutputClipEdit =
  | { type: 'trim'; clipId: string; sourceStartUs: number; sourceEndUs: number }
  | { type: 'replace'; clipId: string; assetId: string }
  | { type: 'trim_variable'; clipId: string; sourceStartUs: number; sourceEndUs: number }
  | { type: 'delete'; clipId: string }
  | { type: 'insert'; afterClipId: string | null; assetId: string; durationUs?: number }
  | { type: 'split'; clipId: string; offsetUs: number };

export interface BatchOutputClipEditResult {
  outputVersionId: string;
  editRevision: number;
  changed: boolean;
  /** 画面是否真的发生变化；split 为 false（不递增 revision、不重渲染）。 */
  visualChanged: boolean;
  warnings: string[];
}

interface PlanLineageRow {
  batchVersionId: string;
  currentVersionId: string | null;
  versionNumber: number | null;
  arrangementJson: string | null;
  inputState: 'draft' | 'frozen';
  defaultsJson: string;
  controlState: 'running' | 'paused' | 'stopped';
  batchCurrentVersionId: string | null;
}

interface FrozenPoolAssetRow {
  assetId: string;
  contentFingerprint: string;
  mediaJson: string;
  analysisJson: string | null;
  excluded: number;
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readPlanLineage(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
): PlanLineageRow {
  const row = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId,
           o.versionNumber, o.arrangementJson,
           v.inputState, v.defaultsJson,
           b.controlState, b.currentVersionId AS batchCurrentVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    LEFT JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as PlanLineageRow | undefined;
  if (!row) throw new BatchDomainError('not_found', '成片计划不存在');
  return row;
}

function readFrozenPoolAsset(
  db: Database.Database,
  batchVersionId: string,
  assetId: string,
): FrozenPoolAssetRow | undefined {
  return db.prepare(`
    SELECT pool.assetId, assets.contentFingerprint, assets.mediaJson,
           analysis.analysisJson,
           CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS excluded
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    LEFT JOIN batch_asset_exclusions e
      ON e.batchVersionId = pool.batchVersionId AND e.assetId = pool.assetId
    WHERE pool.batchVersionId = ? AND pool.assetId = ?
  `).get(batchVersionId, assetId) as FrozenPoolAssetRow | undefined;
}

/** 素材时长来源与分配器一致：冻结池锁定分析版的 durationUs，回落素材媒体信息。 */
function poolAssetDurationUs(row: FrozenPoolAssetRow): number | null {
  const analysis = asRecord(parseJson(row.analysisJson));
  const media = asRecord(parseJson(row.mediaJson));
  for (const candidate of [analysis?.durationUs, media?.durationUs]) {
    const value = finiteNumber(candidate);
    if (value !== null && value > 0) return Math.round(value);
  }
  return null;
}

function fingerprintVersion(fingerprint: string): string {
  return (fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint).slice(0, 16);
}

function readEditRevision(arrangement: Record<string, unknown> | null): number {
  const value = finiteNumber(arrangement?.editRevision);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function clipViewFromRecord(record: Record<string, unknown>): BatchOutputClipView | null {
  const clipId = nonEmptyString(record.clipId);
  const assetId = nonEmptyString(record.assetId);
  const sourceStartUs = finiteNumber(record.sourceStartUs);
  const sourceEndUs = finiteNumber(record.sourceEndUs);
  const timelineStartUs = finiteNumber(record.timelineStartUs);
  const timelineEndUs = finiteNumber(record.timelineEndUs);
  if (!clipId || !assetId || sourceStartUs === null || sourceEndUs === null
    || timelineStartUs === null || timelineEndUs === null) return null;
  return {
    clipId,
    segmentId: nonEmptyString(record.segmentId) ?? '',
    assetId,
    contentFingerprint: nonEmptyString(record.contentFingerprint) ?? '',
    sourceStartUs: Math.round(sourceStartUs),
    sourceEndUs: Math.round(sourceEndUs),
    timelineStartUs: Math.round(timelineStartUs),
    timelineEndUs: Math.round(timelineEndUs),
    locked: record.locked === true,
  };
}

function frameAlignUs(us: number): number {
  const frame = Math.round((us * FPS) / 1_000_000);
  return frameToUs(frame);
}

function frameToUs(frame: number): number {
  return Math.round((frame / FPS) * 1_000_000);
}

function clipRangeOf(record: Record<string, unknown>): { startUs: number; endUs: number } | null {
  const startUs = finiteNumber(record.sourceStartUs);
  const endUs = finiteNumber(record.sourceEndUs);
  if (startUs === null || endUs === null || endUs <= startUs) return null;
  return { startUs: Math.round(startUs), endUs: Math.round(endUs) };
}

function sameClipRange(record: Record<string, unknown>, startUs: number, endUs: number): boolean {
  const current = clipRangeOf(record);
  return current !== null && current.startUs === startUs && current.endUs === endUs;
}

function rippleClips(clips: Array<Record<string, unknown>>): void {
  let cursorUs = 0;
  for (const record of clips) {
    const range = clipRangeOf(record);
    if (!range) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
    record.timelineStartUs = cursorUs;
    record.timelineEndUs = cursorUs + (range.endUs - range.startUs);
    cursorUs = Number(record.timelineEndUs);
  }
}

function visualDurationUs(clips: Array<Record<string, unknown>>): number {
  const last = clips.at(-1);
  const value = last ? finiteNumber(last.timelineEndUs) : null;
  return value !== null && value > 0 ? Math.round(value) : 0;
}

function buildEditWarnings(
  clips: Array<Record<string, unknown>>,
  arrangement: Record<string, unknown>,
  deleted: boolean,
  coverReset: boolean,
): string[] {
  const warnings: string[] = [];
  const narrationDurationUs = finiteNumber(asRecord(arrangement.narration)?.durationUs);
  if (deleted && narrationDurationUs !== null && narrationDurationUs > 0) {
    warnings.push('删除的片段对应口播句子仍按原时间播放，注意声画对位');
  }
  if (narrationDurationUs !== null && narrationDurationUs > 0) {
    const diffUs = visualDurationUs(clips) - narrationDurationUs;
    if (diffUs > 1_000) {
      warnings.push(`画面总长比口播长 ${(diffUs / 1_000_000).toFixed(1)} 秒，超出部分渲染时会被裁掉`);
    } else if (diffUs < -1_000) {
      warnings.push(`画面总长比口播短 ${(Math.abs(diffUs) / 1_000_000).toFixed(1)} 秒，结尾将定格最后一帧补齐`);
    }
  }
  if (coverReset) warnings.push('封面抽帧点已重置到新片段开头');
  return warnings;
}

function manualClipRecord(
  assetId: string,
  contentFingerprint: string,
  durationUs: number,
  reason: string,
): Record<string, unknown> {
  return {
    clipId: `manual:${randomUUID()}`,
    segmentId: '',
    sourceSegmentId: '',
    assetId,
    contentFingerprint,
    sourceStartUs: 0,
    sourceEndUs: durationUs,
    timelineStartUs: 0,
    timelineEndUs: durationUs,
    locked: false,
    reason,
  };
}

/**
 * 编辑器数据视图：当前候选版本的片段/口播/字幕/封面/BGM，
 * 以及冻结池全部素材的使用标记（clips ∪ cover，全批次版本维度）。
 */
export function getBatchOutputArrangementView(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
): BatchOutputClipEditView {
  const lineage = readPlanLineage(db, projectId, batchId, planId);
  const arrangement = asRecord(parseJson(lineage.arrangementJson));

  const clips = (Array.isArray(arrangement?.clips) ? arrangement.clips : [])
    .map((entry) => clipViewFromRecord(asRecord(entry) ?? {}))
    .filter((clip): clip is BatchOutputClipView => clip !== null);

  const narrationRecord = asRecord(arrangement?.narration);
  const narrationDurationUs = finiteNumber(narrationRecord?.durationUs);
  const narration = {
    audioRelativePath: nonEmptyString(narrationRecord?.audioRelativePath),
    durationUs: narrationDurationUs !== null && narrationDurationUs > 0 ? Math.round(narrationDurationUs) : null,
  };

  const subtitleCues = (Array.isArray(asRecord(arrangement?.subtitle)?.cues) ? asRecord(arrangement?.subtitle)!.cues as unknown[] : [])
    .flatMap((entry) => {
      const record = asRecord(entry);
      const startUs = finiteNumber(record?.startUs);
      const endUs = finiteNumber(record?.endUs);
      const text = typeof record?.text === 'string' ? record.text : null;
      return startUs !== null && endUs !== null && text !== null
        ? [{ startUs: Math.round(startUs), endUs: Math.round(endUs), text }]
        : [];
    });

  // 全批次版本维度的素材使用标记：全部 plan 当前候选的 clips ∪ cover。
  const usageByAsset = new Map<string, Set<string>>();
  const versionRows = db.prepare(`
    SELECT p.id AS planId, o.arrangementJson
    FROM batch_output_plans p
    JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.batchVersionId = ?
  `).all(lineage.batchVersionId) as Array<{ planId: string; arrangementJson: string }>;
  for (const row of versionRows) {
    const current = asRecord(parseJson(row.arrangementJson));
    const usedAssetIds = new Set<string>();
    for (const entry of Array.isArray(current?.clips) ? current.clips : []) {
      const assetId = nonEmptyString(asRecord(entry)?.assetId);
      if (assetId) usedAssetIds.add(assetId);
    }
    const coverAssetId = nonEmptyString(asRecord(current?.cover)?.assetId);
    if (coverAssetId) usedAssetIds.add(coverAssetId);
    for (const assetId of usedAssetIds) {
      const plans = usageByAsset.get(assetId) ?? new Set<string>();
      plans.add(row.planId);
      usageByAsset.set(assetId, plans);
    }
  }

  const poolRows = db.prepare(`
    SELECT pool.assetId, assets.contentFingerprint, assets.mediaJson,
           analysis.analysisJson,
           CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS excluded
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    LEFT JOIN batch_asset_exclusions e
      ON e.batchVersionId = pool.batchVersionId AND e.assetId = pool.assetId
    WHERE pool.batchVersionId = ?
    ORDER BY pool.createdAt, pool.id
  `).all(lineage.batchVersionId) as FrozenPoolAssetRow[];

  const encodedProjectId = encodeURIComponent(projectId);
  const encodedBatchId = encodeURIComponent(batchId);
  const encodedBatchVersionId = encodeURIComponent(lineage.batchVersionId);
  const poolAssets = poolRows.map((row): BatchOutputPoolAssetView => {
    const media = asRecord(parseJson(row.mediaJson));
    const durationUs = poolAssetDurationUs(row);
    const mediaDurationSec = finiteNumber(media?.durationSec);
    const encodedAssetId = encodeURIComponent(row.assetId);
    return {
      assetId: row.assetId,
      displayName: nonEmptyString(media?.displayName) ?? nonEmptyString(media?.filename) ?? `素材 ${row.assetId.slice(0, 8)}`,
      durationSec: durationUs !== null ? durationUs / 1_000_000 : mediaDurationSec,
      contentFingerprint: row.contentFingerprint,
      thumbnailUrl: `/api/batch-production/assets/${encodedAssetId}/thumbnail?projectId=${encodedProjectId}&v=${encodeURIComponent(fingerprintVersion(row.contentFingerprint))}`,
      previewUrl: `/api/batch-production/preview/${encodedAssetId}?projectId=${encodedProjectId}&batchId=${encodedBatchId}&batchVersionId=${encodedBatchVersionId}`,
      excluded: row.excluded === 1,
      usedByPlanIds: [...(usageByAsset.get(row.assetId) ?? [])].sort(),
    };
  });

  const bgmParams = resolveBatchBgmParams(parseJson(lineage.defaultsJson));
  return {
    planId,
    batchVersionId: lineage.batchVersionId,
    outputVersionId: lineage.currentVersionId,
    versionNumber: lineage.versionNumber,
    editable: Boolean(lineage.currentVersionId) && lineage.inputState === 'frozen' && lineage.controlState !== 'stopped',
    editRevision: readEditRevision(arrangement),
    visualDurationUs: clips.at(-1)?.timelineEndUs ?? 0,
    clips,
    narration,
    subtitleCues,
    coverAssetId: nonEmptyString(asRecord(arrangement?.cover)?.assetId),
    music: {
      trackId: nonEmptyString(asRecord(arrangement?.music)?.trackId),
      gainDb: bgmParams.gainDb,
      fadeInSec: bgmParams.fadeInSec,
      fadeOutSec: bgmParams.fadeOutSec,
    },
    poolAssets,
  };
}

/**
 * 应用一次片段级编辑（整读-改-整写 arrangementJson 的单事务）。
 *
 * - trim/replace：保留上一迭代的等长语义；
 * - trim_variable：变长修剪，ripple 平移后续片段；
 * - delete：删除后 ripple（至少保留一条片段）；
 * - insert：从冻结池插入默认 3s（或显式窗口）片段，ripple；
 * - split：把一段切成源连续的 two pieces，总长不变，不触发重渲染。
 */
export function applyBatchOutputClipEdit(
  db: Database.Database,
  projectId: string,
  batchId: string,
  planId: string,
  edit: BatchOutputClipEdit,
): BatchOutputClipEditResult {
  if (!edit || typeof edit !== 'object') {
    throw new BatchDomainError('invalid_input', '不支持的片段编辑类型');
  }
  switch (edit.type) {
    case 'trim':
    case 'trim_variable':
      if (!nonEmptyString(edit.clipId)) {
        throw new BatchDomainError('invalid_input', '缺少片段 ID');
      }
      if (!Number.isSafeInteger(edit.sourceStartUs) || !Number.isSafeInteger(edit.sourceEndUs)) {
        throw new BatchDomainError('invalid_input', '截取区间必须是安全整数(微秒)');
      }
      if (edit.sourceStartUs < 0 || edit.sourceEndUs <= edit.sourceStartUs) {
        throw new BatchDomainError('invalid_input', '截取区间无效');
      }
      break;
    case 'replace':
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '缺少片段 ID');
      if (!nonEmptyString(edit.assetId)) throw new BatchDomainError('invalid_input', '缺少替换素材 ID');
      break;
    case 'delete':
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '缺少片段 ID');
      break;
    case 'insert':
      if (!nonEmptyString(edit.assetId)) throw new BatchDomainError('invalid_input', '缺少插入素材 ID');
      if (edit.afterClipId !== null && !nonEmptyString(edit.afterClipId)) {
        throw new BatchDomainError('invalid_input', '插入位置无效');
      }
      if (edit.durationUs !== undefined && (!Number.isSafeInteger(edit.durationUs) || edit.durationUs <= 0)) {
        throw new BatchDomainError('invalid_input', '插入时长必须是正整数(微秒)');
      }
      break;
    case 'split':
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '缺少片段 ID');
      if (!Number.isSafeInteger(edit.offsetUs) || edit.offsetUs < 0) {
        throw new BatchDomainError('invalid_input', '分割偏移必须是非负安全整数(微秒)');
      }
      break;
    default:
      throw new BatchDomainError('invalid_input', '不支持的片段编辑类型');
  }

  return db.transaction(() => {
    const lineage = readPlanLineage(db, projectId, batchId, planId);
    if (lineage.inputState !== 'frozen') {
      throw new BatchDomainError('conflict', '批次尚未冻结,不能编辑成片片段');
    }
    if (lineage.controlState === 'stopped') {
      throw new BatchDomainError('conflict', '批次已停止,不能编辑成片片段');
    }
    if (!lineage.batchCurrentVersionId || lineage.batchVersionId !== lineage.batchCurrentVersionId) {
      throw new BatchDomainError('conflict', '成片计划不属于批次当前版本,不能编辑片段');
    }
    if (!lineage.currentVersionId) {
      throw new BatchDomainError('conflict', '成片还没有候选版本,不能编辑片段');
    }
    const outputVersionId = lineage.currentVersionId;
    const arrangement = asRecord(parseJson(lineage.arrangementJson));
    if (!arrangement || !Array.isArray(arrangement.clips)) {
      throw new BatchDomainError('conflict', '成片安排缺少片段信息,不能编辑');
    }
    const clips = (arrangement.clips as unknown[]).map((entry) => {
      const record = asRecord(entry);
      if (!record) throw new BatchDomainError('conflict', '成片片段数据损坏,不能编辑');
      return record;
    });
    const editRevision = readEditRevision(arrangement);
    const unchanged: BatchOutputClipEditResult = {
      outputVersionId,
      editRevision,
      changed: false,
      visualChanged: false,
      warnings: [],
    };

    const clipIndex = (id: string): number => clips.findIndex((record) => nonEmptyString(record.clipId) === id);
    let visualChanged = false;
    let splitChanged = false;
    let deleted = false;

    if (edit.type === 'trim' || edit.type === 'trim_variable') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      const current = clipRangeOf(clip);
      if (!current) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
      const sourceLengthUs = current.endUs - current.startUs;

      if (edit.type === 'trim') {
        const requestedLengthUs = edit.sourceEndUs - edit.sourceStartUs;
        if (Math.abs(requestedLengthUs - sourceLengthUs) > FRAME_TOLERANCE_US) {
          throw new BatchDomainError('invalid_input', '截取必须保持原片段时长不变(只允许移动出入点)');
        }
        const normalizedStartUs = frameAlignUs(edit.sourceStartUs);
        const normalizedEndUs = normalizedStartUs + sourceLengthUs;
        const poolRow = readFrozenPoolAsset(db, lineage.batchVersionId, String(clip.assetId));
        if (!poolRow) throw new BatchDomainError('conflict', '片段素材不在本批次冻结素材池中,无法校验截取区间');
        const durationUs = poolAssetDurationUs(poolRow);
        if (durationUs === null) throw new BatchDomainError('invalid_input', '素材缺少时长信息,无法校验截取区间');
        if (normalizedEndUs > durationUs) throw new BatchDomainError('invalid_input', '截取区间超出素材时长');
        if (sameClipRange(clip, normalizedStartUs, normalizedEndUs)) return unchanged;
        clip.sourceStartUs = normalizedStartUs;
        clip.sourceEndUs = normalizedEndUs;
        visualChanged = true;
      } else {
        const normalizedStartUs = frameAlignUs(edit.sourceStartUs);
        const normalizedEndUs = frameAlignUs(edit.sourceEndUs);
        if (normalizedEndUs <= normalizedStartUs) throw new BatchDomainError('invalid_input', '截取区间无效');
        const poolRow = readFrozenPoolAsset(db, lineage.batchVersionId, String(clip.assetId));
        if (!poolRow) throw new BatchDomainError('conflict', '片段素材不在本批次冻结素材池中,无法校验截取区间');
        const durationUs = poolAssetDurationUs(poolRow);
        if (durationUs === null) throw new BatchDomainError('invalid_input', '素材缺少时长信息,无法校验截取区间');
        if (normalizedEndUs > durationUs) throw new BatchDomainError('invalid_input', '截取区间超出素材时长');
        if (normalizedEndUs - normalizedStartUs < MIN_CLIP_DURATION_US) {
          throw new BatchDomainError('invalid_input', '修剪后片段长度不能短于 0.5 秒');
        }
        if (sameClipRange(clip, normalizedStartUs, normalizedEndUs)) return unchanged;
        clip.sourceStartUs = normalizedStartUs;
        clip.sourceEndUs = normalizedEndUs;
        visualChanged = true;
      }
    } else if (edit.type === 'replace') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      const current = clipRangeOf(clip);
      if (!current) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
      const clipLengthUs = current.endUs - current.startUs;
      const targetAssetId = edit.assetId.trim();
      const target = readFrozenPoolAsset(db, lineage.batchVersionId, targetAssetId);
      if (!target) throw new BatchDomainError('invalid_input', '替换素材不在本批次冻结素材池中');
      if (target.excluded === 1) throw new BatchDomainError('conflict', '替换素材已被排除出本批次分配');
      const durationUs = poolAssetDurationUs(target);
      if (durationUs === null) throw new BatchDomainError('invalid_input', '替换素材缺少时长信息,无法覆盖片段');
      if (durationUs < clipLengthUs) throw new BatchDomainError('invalid_input', '替换素材时长不足,无法覆盖片段长度');
      if (String(clip.assetId) === targetAssetId && current.startUs === 0) return unchanged;
      clip.assetId = targetAssetId;
      clip.contentFingerprint = target.contentFingerprint;
      clip.sourceStartUs = 0;
      clip.sourceEndUs = clipLengthUs;
      visualChanged = true;
    } else if (edit.type === 'delete') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      if (clips.length <= 1) throw new BatchDomainError('invalid_input', '至少保留一条片段');
      clips.splice(index, 1);
      deleted = true;
      visualChanged = true;
    } else if (edit.type === 'insert') {
      const afterIndex = edit.afterClipId === null ? -1 : clipIndex(edit.afterClipId);
      if (afterIndex < 0 && edit.afterClipId !== null) {
        throw new BatchDomainError('not_found', '插入位置片段不存在');
      }
      const position = afterIndex + 1;
      const targetAssetId = edit.assetId.trim();
      const target = readFrozenPoolAsset(db, lineage.batchVersionId, targetAssetId);
      if (!target) throw new BatchDomainError('invalid_input', '插入素材不在本批次冻结素材池中');
      if (target.excluded === 1) throw new BatchDomainError('conflict', '插入素材已被排除出本批次分配');
      const durationUs = poolAssetDurationUs(target);
      if (durationUs === null) throw new BatchDomainError('invalid_input', '插入素材缺少时长信息');
      const rawInsertDurationUs = Math.min(durationUs, edit.durationUs ?? 3_000_000);
      const alignedInsertDurationUs = frameAlignUs(rawInsertDurationUs);
      const insertDurationUs = alignedInsertDurationUs <= durationUs
        ? alignedInsertDurationUs
        : frameToUs(Math.floor((durationUs * FPS) / 1_000_000));
      if (insertDurationUs < MIN_CLIP_DURATION_US) {
        throw new BatchDomainError('invalid_input', '插入素材时长不足最短片段长度');
      }
      clips.splice(position, 0, manualClipRecord(targetAssetId, target.contentFingerprint, insertDurationUs, 'manual_insert'));
      visualChanged = true;
    } else {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      const current = clipRangeOf(clip);
      if (!current) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
      const sourceLengthUs = current.endUs - current.startUs;
      const offsetUs = frameAlignUs(edit.offsetUs);
      if (offsetUs < MIN_CLIP_DURATION_US || sourceLengthUs - offsetUs < MIN_CLIP_DURATION_US) {
        throw new BatchDomainError('invalid_input', '分割点两侧都必须至少 0.5 秒');
      }
      const timelineStartUs = finiteNumber(clip.timelineStartUs) ?? 0;
      const timelineEndUs = finiteNumber(clip.timelineEndUs) ?? timelineStartUs + sourceLengthUs;
      const first = { ...clip };
      first.sourceEndUs = current.startUs + offsetUs;
      first.timelineEndUs = timelineStartUs + offsetUs;
      const second = {
        ...clip,
        clipId: `manual:${randomUUID()}`,
        segmentId: '',
        sourceSegmentId: '',
        sourceStartUs: current.startUs + offsetUs,
        sourceEndUs: current.endUs,
        timelineStartUs: timelineStartUs + offsetUs,
        timelineEndUs,
        locked: false,
        reason: 'manual_split',
      };
      clips.splice(index, 1, first, second);
      splitChanged = true;
    }

    if (visualChanged) {
      rippleClips(clips);
      arrangement.clips = clips;
      const nextEditRevision = editRevision + 1;
      arrangement.editRevision = nextEditRevision;
      delete arrangement.review;

      let coverReset = false;
      const cover = asRecord(arrangement.cover);
      const first = clips[0];
      if (cover && first) {
        const firstRange = clipRangeOf(first);
        const coverTimeUs = finiteNumber(cover.timeUs);
        if (firstRange && coverTimeUs !== null && (coverTimeUs < firstRange.startUs || coverTimeUs >= firstRange.endUs)) {
          cover.timeUs = firstRange.startUs;
          coverReset = true;
        }
      }
      const warnings = buildEditWarnings(clips, arrangement, deleted, coverReset);
      db.prepare(`
        UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?
      `).run(JSON.stringify(arrangement), outputVersionId);
      return { outputVersionId, editRevision: nextEditRevision, changed: true, visualChanged: true, warnings };
    }

    if (splitChanged) {
      arrangement.clips = clips;
      db.prepare(`
        UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?
      `).run(JSON.stringify(arrangement), outputVersionId);
      return { outputVersionId, editRevision, changed: true, visualChanged: false, warnings: [] };
    }

    return unchanged;
  })();
}
