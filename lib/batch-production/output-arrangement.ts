import { planClipPosition } from '../media-core/clip-position.ts';
import { editAudioClip, parseAudioEdits, trimAudioClip, moveAudioClip, type AudioEdits, type AudioTrackKind } from '../media-core/audio-edit.ts';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { resolveBatchBgmParams, resolveBatchBgmParamsForArrangement } from './batch-renderer.ts';
import { buildBatchNarrationSubtitleCues } from './subtitle-cues.ts';
import type { BatchRenderNarrationSegment } from './batch-renderer.ts';
import { BatchDomainError } from './errors.ts';
import { listBatchBgmTracks, readBatchMusicEditPool, readFrozenMusicPool } from './bgm.ts';
import { loadFrozenCoverTitleConfig, resolveBatchCoverTitleOverride } from './cover-title.ts';
import type { FrozenBatchCoverTitleConfig } from './cover-title.ts';
import { hasBatchSubtitleStyleOverride, loadFrozenSubtitleStyle, resolveBatchSubtitleStyleOverride } from './subtitle-style.ts';
import { defaultTextStyle, normalizeTextStyle } from '../media-core/cover-domain.ts';
import { NARRATION_GAIN_DB_DEFAULT, normalizeNarrationGainDb } from '../media-core/audio-gain.ts';
import { cleanFraming } from '../media-core/cover-title-presets.ts';
import type { CoverFraming, TextStyle } from '../media-core/cover-types.ts';
import { resolveModule4AssetDisplayNames } from './media-catalog.ts';

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
 * 变长修剪/删除保留空位，插入优先填空位、不足时顺延；分割是纯结构操作，
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
  playbackRate?: number;
  framing?: CoverFraming;
}

export interface BatchOutputPoolAssetView {
  assetId: string;
  displayName: string;
  durationSec: number | null;
  contentFingerprint: string;
  thumbnailUrl: string;
  /** 代理预览地址(代理解析路由;无匹配代理时回退原片)。 */
  previewUrl: string;
  /** 冻结快照中的素材级 LUT 选择(无/已归档时可能为 null),实时预览叠加用。 */
  lutId: string | null;
  /** 已被排除出本批次联合分配（不可用于替换/插入）。 */
  excluded: boolean;
  /** 本批次版本中，当前候选画面片段用到该素材的全部成片计划（去重）。 */
  usedByPlanIds: string[];
  /** 本批次版本中，当前候选画面片段用到该素材的次数（按成片计划计数；split 切成两段计 2 次）。 */
  useCountByPlanId: Record<string, number>;
  /** 本批次版本中，当前候选封面用到该素材的全部成片计划。 */
  coverUsedByPlanIds: string[];
  role: 'opening' | 'body';
}

export interface BatchOutputSubtitleCueView {
  id: string;
  sourceSegmentId: string;
  startUs: number;
  endUs: number;
  text: string;
  timingSource?: 'estimated' | 'aligned' | 'manual';
}

export interface BatchOutputMusicTrackView {
  id: string;
  filename: string;
  durationUs: number;
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
  preserveGaps?: boolean;
  audio?: AudioEdits;
  clips: BatchOutputClipView[];
  narration: { audioRelativePath: string | null; durationUs: number | null; gainDb: number };
  subtitleCues: BatchOutputSubtitleCueView[];
  /** true 表示当前成片会优先使用 arrangement.subtitle 的手动覆盖。 */
  subtitleOverride: boolean;
  subtitleStyle: TextStyle;
  subtitleStyleDefault: TextStyle;
  subtitleStyleOverride: boolean;
  coverTitle: FrozenBatchCoverTitleConfig | null;
  coverFraming: CoverFraming;
  coverTitleOverride: boolean;
  coverAssetId: string | null;
  coverTimeUs: number;
  music: { trackId: string | null; gainDb: number; fadeInSec: number; fadeOutSec: number };
  batchMusicDefaults: { gainDb: number; fadeInSec: number; fadeOutSec: number };
  musicLibrary: BatchOutputMusicTrackView[];
  poolAssets: BatchOutputPoolAssetView[];
}

export type BatchOutputClipEdit =
  | { type: 'move_clip'; clipId: string; startUs: number }
  | { type: 'trim'; clipId: string; sourceStartUs: number; sourceEndUs: number }
  | { type: 'replace'; clipId: string; assetId: string }
  | { type: 'trim_variable'; clipId: string; sourceStartUs: number; sourceEndUs: number }
  | { type: 'delete'; clipId: string }
  | { type: 'set_clip_playback_rate'; clipId: string; playbackRate: number }
  | { type: 'set_clip_framing'; clipId: string; framing: CoverFraming }
  | { type: 'split_audio_clip'; track: AudioTrackKind; clipId: string; atUs: number }
  | { type: 'delete_audio_clip'; track: AudioTrackKind; clipId: string }
  | { type: 'trim_audio_clip'; track: AudioTrackKind; clipId: string; sourceStartUs: number; sourceEndUs: number; timelineStartUs?: number; timelineEndUs?: number }
  | { type: 'move_audio_clip'; track: AudioTrackKind; clipId: string; timelineStartUs: number }
  | { type: 'insert'; afterClipId: string | null; assetId: string; durationUs?: number }
  | { type: 'split'; clipId: string; offsetUs: number }
  | { type: 'set_cover'; assetId: string; timeUs: number; framing?: CoverFraming | null; title?: unknown }
  | { type: 'set_music_track'; trackId: string | null }
  | { type: 'set_music_params'; gainDb: number; fadeInSec: number; fadeOutSec: number }
  /** 原子 BGM 编辑：一次校验曲目并写入全部参数，只递增一次 editRevision。 */
  | { type: 'set_music'; trackId: string | null; gainDb: number; fadeInSec: number; fadeOutSec: number }
  | { type: 'set_narration_gain'; gainDb: number }
  | { type: 'set_subtitle_cue_text'; cueId: string; text: string }
  | { type: 'set_subtitle_style'; style: TextStyle | null }
  | { type: 'move_subtitle_cue'; cueId: string; startUs: number; endUs: number }
  | { type: 'trim_subtitle_cue'; cueId: string; startUs: number; endUs: number }
  | { type: 'split_subtitle_cue'; cueId: string; splitUs: number; leftText?: string; rightText?: string }
  | { type: 'delete_subtitle_cue'; cueId: string }
  | { type: 'restore_automatic_subtitles' }
  /**
   * 撤销/重做回放:把整包可编辑字段恢复到历史快照内容。
   * 快照由编辑器数据视图派生(见 buildBatchRestoreSnapshot),后端逐字段
   * 重建并按与单条命令相同的门禁校验;expectedEditRevision 不匹配时拒绝,
   * 保证撤销不覆盖较新的正式修订。
   */
  | { type: 'restore_arrangement'; snapshot: BatchOutputRestoreSnapshot; expectedEditRevision?: number };

/**
 * 撤销/重做快照:统一审片工作台编辑前后状态的可编辑字段集合。
 * 缺省字段按「无覆盖/默认值」恢复;clips 恒为完整列表。
 */
export interface BatchOutputRestoreSnapshot {
  clips?: unknown;
  audio?: unknown;
  preserveGaps?: unknown;
  /** 存在人工字幕覆盖时 true;false 表示恢复自动字幕(清除人工 cues)。 */
  subtitleOverride?: unknown;
  subtitleCues?: unknown;
  subtitleStyle?: unknown;
  subtitleStyleOverride?: unknown;
  coverAssetId?: unknown;
  coverTimeUs?: unknown;
  coverFraming?: unknown;
  coverTitle?: unknown;
  coverTitleOverride?: unknown;
  musicTrackId?: unknown;
  musicGainDb?: unknown;
  musicFadeInSec?: unknown;
  musicFadeOutSec?: unknown;
  narrationGainDb?: unknown;
}

export interface BatchOutputClipEditResult {
  outputVersionId: string;
  editRevision: number;
  changed: boolean;
  /** 画面是否真的发生变化；split 为 false（不递增 revision、不重渲染）。 */
  visualChanged: boolean;
  /** 这次有效编辑是否真的清除了既有审核态（reviewCleared=true 时前端应提示重新审核）。 */
  reviewCleared: boolean;
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
  /** 冻结色彩快照(含素材卡 LUT 选择),实时预览按它叠加 LUT */
  colorJson: string | null;
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
           pool.colorJson,
           CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS excluded
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    LEFT JOIN batch_asset_exclusions e
      ON e.batchVersionId = pool.batchVersionId AND e.assetId = pool.assetId
    WHERE pool.batchVersionId = ? AND pool.assetId = ?
  `).get(batchVersionId, assetId) as FrozenPoolAssetRow | undefined;
}

/**
 * 读取当前编辑可用的素材：
 * 优先取批次冻结池快照；若不在冻结池，则允许取用当前项目已上线的受管素材（M-04 编辑新增素材引用）。
 */
function readAvailableEditingAsset(
  db: Database.Database,
  projectId: string,
  batchVersionId: string,
  assetId: string,
): FrozenPoolAssetRow | undefined {
  const frozen = readFrozenPoolAsset(db, batchVersionId, assetId);
  if (frozen) return frozen;

  const candidate = db.prepare(`
    SELECT assets.id AS assetId,
           assets.contentFingerprint,
           assets.mediaJson,
           analysis.analysisJson,
           '{"lutId":null}' AS colorJson,
           0 AS excluded
    FROM batch_assets assets
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = assets.currentAnalysisId
    WHERE assets.projectId = ? AND assets.id = ? AND assets.status = 'online'
  `).get(projectId, assetId) as FrozenPoolAssetRow | undefined;

  if (!candidate) return undefined;
  const durationUs = poolAssetDurationUs(candidate);
  if (durationUs === null || durationUs <= 0) return undefined;

  return candidate;
}

/** 素材时长来源与分配器一致：冻结池锁定分析版的 durationUs，回落素材媒体信息。 */
function poolAssetDurationUs(row: FrozenPoolAssetRow): number | null {
  const analysis = asRecord(parseJson(row.analysisJson));
  const media = asRecord(parseJson(row.mediaJson));
  for (const candidate of [analysis?.durationUs, media?.durationUs]) {
    const value = finiteNumber(candidate);
    if (value !== null && value > 0) return Math.round(value);
  }
  const fromMediaSec = finiteNumber(media?.durationSec);
  if (fromMediaSec !== null && fromMediaSec > 0) return Math.round(fromMediaSec * 1_000_000);
  return null;
}

function fingerprintVersion(fingerprint: string): string {
  return (fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint).slice(0, 16);
}

function readEditRevision(arrangement: Record<string, unknown> | null): number {
  const value = finiteNumber(arrangement?.editRevision);
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function hasManualSubtitleOverride(arrangement: Record<string, unknown> | null): boolean {
  const subtitle = asRecord(arrangement?.subtitle);
  return subtitle?.source === 'manual' || subtitle?.mode === 'manual';
}

function outputWidthForPreset(value: unknown): number {
  const preset = typeof value === 'string' ? value : '';
  return preset === '16:9' || preset === '16x9' ? 1920 : 1080;
}

function subtitleCueViewFromRecord(record: Record<string, unknown>, index: number): BatchOutputSubtitleCueView | null {
  const startUs = finiteNumber(record.startUs);
  const endUs = finiteNumber(record.endUs);
  if (startUs === null || endUs === null || startUs < 0 || endUs <= startUs) return null;
  const id = nonEmptyString(record.id) ?? `subtitle:cue:${index + 1}`;
  return {
    id,
    sourceSegmentId: nonEmptyString(record.sourceSegmentId) ?? id,
    startUs: Math.round(startUs),
    endUs: Math.round(endUs),
    text: typeof record.text === 'string' ? record.text : '',
    ...(record.timingSource === 'aligned' || record.timingSource === 'manual' || record.timingSource === 'estimated'
      ? { timingSource: record.timingSource }
      : {}),
  };
}

function narrationSegmentsFromArrangement(arrangement: Record<string, unknown>): BatchRenderNarrationSegment[] {
  const segments = asRecord(arrangement.narration)?.segments;
  if (!Array.isArray(segments)) return [];
  return segments.flatMap((entry, index): BatchRenderNarrationSegment[] => {
    const record = asRecord(entry);
    const id = nonEmptyString(record?.id) ?? `narration:segment:${index + 1}`;
    const sourceSegmentId = nonEmptyString(record?.sourceSegmentId) ?? id;
    const text = typeof record?.text === 'string' ? record.text : '';
    const startUs = finiteNumber(record?.startUs);
    const endUs = finiteNumber(record?.endUs);
    return startUs !== null && endUs !== null && startUs >= 0 && endUs > startUs && text.trim()
      ? [{ id, sourceSegmentId, text, startUs: Math.round(startUs), endUs: Math.round(endUs) }]
      : [];
  });
}

function readSubtitleCueRecords(arrangement: Record<string, unknown>): Array<Record<string, unknown>> {
  const subtitle = asRecord(arrangement.subtitle);
  if (!hasManualSubtitleOverride(arrangement)) {
    const automatic = narrationSegmentsFromArrangement(arrangement);
    if (automatic.length > 0) {
      // 首次编辑要物化“当前实际会渲染的自动字幕”，而不是沿用可能已
      // 与重试口播错位的旧 estimated cues。
      return buildBatchNarrationSubtitleCues(automatic).map((cue) => ({ ...cue, timingSource: 'aligned' }));
    }
  }
  if (!Array.isArray(subtitle?.cues)) {
    throw new BatchDomainError('conflict', '字幕覆盖数据损坏,不能编辑字幕');
  }
  return subtitle.cues.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) throw new BatchDomainError('conflict', `字幕第 ${index + 1} 条数据损坏,不能编辑字幕`);
    const view = subtitleCueViewFromRecord(record, index);
    if (!view) throw new BatchDomainError('conflict', `字幕第 ${index + 1} 条时间范围损坏,不能编辑字幕`);
    return { ...record, id: view.id, sourceSegmentId: view.sourceSegmentId, startUs: view.startUs, endUs: view.endUs, text: view.text };
  });
}

function bodyDurationUsOf(arrangement: Record<string, unknown>, clips: Array<Record<string, unknown>>): number {
  const visual = visualDurationUs(clips);
  const narration = finiteNumber(asRecord(arrangement.narration)?.durationUs) ?? 0;
  // Renderer uses narration duration as the body target when a verified
  // narration exists; keep manual cue validation on the same contract.
  return narration > 0 ? narration : Math.max(visual, 1);
}

function normalizeMusicParams(value: { gainDb: number; fadeInSec: number; fadeOutSec: number }): { gainDb: number; fadeInSec: number; fadeOutSec: number } {
  return {
    gainDb: Math.min(0, Math.max(-60, value.gainDb)),
    fadeInSec: Math.min(30, Math.max(0, value.fadeInSec)),
    fadeOutSec: Math.min(30, Math.max(0, value.fadeOutSec)),
  };
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
    playbackRate: finiteNumber(record.playbackRate) ?? (sourceEndUs - sourceStartUs) / (timelineEndUs - timelineStartUs),
    framing: asRecord(record.framing) as unknown as CoverFraming || { scale: 1, offsetX: 0, offsetY: 0 },
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

function visualDurationUs(clips: Array<Record<string, unknown>>): number {
  const last = clips.at(-1);
  const value = last ? finiteNumber(last.timelineEndUs) : null;
  return value !== null && value > 0 ? Math.round(value) : 0;
}

function buildEditWarnings(
  clips: Array<Record<string, unknown>>,
  arrangement: Record<string, unknown>,
  deleted: boolean,
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
      warnings.push(`画面总长比口播短 ${(Math.abs(diffUs) / 1_000_000).toFixed(1)} 秒，结尾将${arrangement.preserveGaps ? '保留黑场空位' : '定格最后一帧补齐'}`);
    }
  }
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
 * 画面内容流投影:按时间排序后,把「时间相邻 + 源连续 + 同素材/速率/构图」的
 * 相邻片段合并成内容段。两次片段列表投影相同即视为画面实质相同(纯结构差异,
 * 如 split/撤销 split),恢复时沿用「不递增 revision、不清 review」的等价语义。
 */
function visualStreamKey(clips: Array<Record<string, unknown>>): string {
  const ordered = [...clips].sort((a, b) => Number(a.timelineStartUs ?? 0) - Number(b.timelineStartUs ?? 0));
  const segments: Array<[number, number, string, number, number, number, string]> = [];
  for (const clip of ordered) {
    const assetId = String(clip.assetId ?? '');
    const sourceStartUs = Math.round(Number(clip.sourceStartUs ?? 0));
    const sourceEndUs = Math.round(Number(clip.sourceEndUs ?? 0));
    const timelineStartUs = Math.round(Number(clip.timelineStartUs ?? 0));
    const timelineEndUs = Math.round(Number(clip.timelineEndUs ?? 0));
    const rate = finiteNumber(clip.playbackRate) ?? 1;
    const framing = JSON.stringify(clip.framing ?? null);
    const last = segments.at(-1);
    if (
      last
      && last[2] === assetId
      && last[5] === rate
      && last[6] === framing
      && Math.abs(timelineStartUs - last[1]) <= FRAME_TOLERANCE_US
      && Math.abs(sourceStartUs - last[4]) <= FRAME_TOLERANCE_US
    ) {
      last[1] = timelineEndUs;
      last[4] = sourceEndUs;
    } else {
      segments.push([timelineStartUs, timelineEndUs, assetId, sourceStartUs, sourceEndUs, rate, framing]);
    }
  }
  return JSON.stringify(segments);
}

/** 音轨内容的规范化等价键;解析失败时退化为原始序列化,保证不误判相等。 */
function audioEditsKey(audio: unknown): string {
  try {
    const parsed = parseAudioEdits(audio);
    if (parsed === undefined || Object.keys(parsed).length === 0) return 'none';
    return JSON.stringify(parsed);
  } catch {
    return `invalid:${JSON.stringify(audio ?? null)}`;
  }
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
    gainDb: normalizeNarrationGainDb(narrationRecord?.gainDb),
  };

  const storedSubtitleCues = (Array.isArray(asRecord(arrangement?.subtitle)?.cues) ? asRecord(arrangement?.subtitle)!.cues as unknown[] : [])
    .flatMap((entry, index) => {
      const record = asRecord(entry);
      return record ? [subtitleCueViewFromRecord(record, index)].filter((cue): cue is BatchOutputSubtitleCueView => cue !== null) : [];
    });
  const automaticSubtitleSegments = narrationSegmentsFromArrangement(arrangement ?? {});
  const subtitleCues = hasManualSubtitleOverride(arrangement)
    ? storedSubtitleCues
    : automaticSubtitleSegments.length > 0
      ? buildBatchNarrationSubtitleCues(automaticSubtitleSegments).map((cue) => ({ ...cue, timingSource: 'aligned' as const }))
      : storedSubtitleCues;

  // 全批次版本维度的素材使用标记：片段使用与封面使用分开，避免封面素材
  // 被误报成「本片画面已用」，也让素材池能明确提示封面占用。
  // 片段次数用 Map<planId, count>：clips[] 是数组，同一素材出现几次计几次
  // （split 切成两段产生两条记录，计 2 次）；Set 会丢掉次数，不能用。
  const usageByAsset = new Map<string, Map<string, number>>();
  const coverUsageByAsset = new Map<string, Set<string>>();
  const versionRows = db.prepare(`
    SELECT p.id AS planId, o.arrangementJson
    FROM batch_output_plans p
    JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.batchVersionId = ?
  `).all(lineage.batchVersionId) as Array<{ planId: string; arrangementJson: string }>;
  for (const row of versionRows) {
    const current = asRecord(parseJson(row.arrangementJson));
    for (const entry of Array.isArray(current?.clips) ? current.clips : []) {
      const assetId = nonEmptyString(asRecord(entry)?.assetId);
      if (!assetId) continue;
      const counts = usageByAsset.get(assetId) ?? new Map<string, number>();
      counts.set(row.planId, (counts.get(row.planId) ?? 0) + 1);
      usageByAsset.set(assetId, counts);
    }
    const coverAssetId = nonEmptyString(asRecord(current?.cover)?.assetId);
    if (coverAssetId) {
      const plans = coverUsageByAsset.get(coverAssetId) ?? new Set<string>();
      plans.add(row.planId);
      coverUsageByAsset.set(coverAssetId, plans);
    }
  }

  const poolRows = db.prepare(`
    SELECT pool.assetId, assets.contentFingerprint, assets.mediaJson,
           analysis.analysisJson, pool.colorJson,
           CASE WHEN e.id IS NULL THEN 0 ELSE 1 END AS excluded
    FROM batch_asset_pool_items pool
    JOIN batch_assets assets ON assets.id = pool.assetId
    LEFT JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
    LEFT JOIN batch_asset_exclusions e
      ON e.batchVersionId = pool.batchVersionId AND e.assetId = pool.assetId
    WHERE pool.batchVersionId = ?
    ORDER BY pool.createdAt, pool.id
  `).all(lineage.batchVersionId) as FrozenPoolAssetRow[];

  const existingAssetIds = new Set(poolRows.map((row) => row.assetId));
  const extraAssetIds = new Set<string>();
  for (const clip of clips) {
    if (typeof clip.assetId === 'string' && !existingAssetIds.has(clip.assetId)) {
      extraAssetIds.add(clip.assetId);
    }
  }
  const coverVal = asRecord(arrangement?.cover);
  if (coverVal?.assetId && typeof coverVal.assetId === 'string' && !existingAssetIds.has(coverVal.assetId)) {
    extraAssetIds.add(coverVal.assetId);
  }
  if (extraAssetIds.size > 0) {
    const extraRows = db.prepare(`
      SELECT assets.id AS assetId,
             assets.contentFingerprint,
             assets.mediaJson,
             analysis.analysisJson,
             '{"lutId":null}' AS colorJson,
             0 AS excluded
      FROM batch_assets assets
      LEFT JOIN batch_asset_analysis analysis ON analysis.id = assets.currentAnalysisId
      WHERE assets.projectId = ? AND assets.id IN (${[...extraAssetIds].map(() => '?').join(',')})
    `).all(projectId, ...extraAssetIds) as FrozenPoolAssetRow[];
    poolRows.push(...extraRows);
  }

  const encodedProjectId = encodeURIComponent(projectId);
  const encodedBatchId = encodeURIComponent(batchId);
  const encodedBatchVersionId = encodeURIComponent(lineage.batchVersionId);
  // 友好展示名（D5）：module4 来源素材的 mediaJson 可能只有物理文件名
  // （video-<jobId>-<时间戳>.mp4），旧登记行读取时派生友好名，不改写数据库。
  const module4DisplayNames = resolveModule4AssetDisplayNames(db, poolRows.map((row) => row.assetId));
  const poolAssets = poolRows.map((row): BatchOutputPoolAssetView => {
    const media = asRecord(parseJson(row.mediaJson));
    const durationUs = poolAssetDurationUs(row);
    const mediaDurationSec = finiteNumber(media?.durationSec);
    const encodedAssetId = encodeURIComponent(row.assetId);
    const usageCounts = usageByAsset.get(row.assetId);
    return {
      assetId: row.assetId,
      displayName: nonEmptyString(media?.displayName) ?? module4DisplayNames.get(row.assetId) ?? nonEmptyString(media?.filename) ?? `素材 ${row.assetId.slice(0, 8)}`,
      durationSec: durationUs !== null ? durationUs / 1_000_000 : mediaDurationSec,
      contentFingerprint: row.contentFingerprint,
      thumbnailUrl: `/api/batch-production/assets/${encodedAssetId}/thumbnail?projectId=${encodedProjectId}&v=${encodeURIComponent(fingerprintVersion(row.contentFingerprint))}`,
      previewUrl: `/api/batch-production/preview/${encodedAssetId}?projectId=${encodedProjectId}&batchId=${encodedBatchId}&batchVersionId=${encodedBatchVersionId}`,
      lutId: (() => {
        const color = asRecord(parseJson(row.colorJson));
        return typeof color?.lutId === 'string' && color.lutId.length > 0 ? color.lutId : null;
      })(),
      excluded: row.excluded === 1,
      usedByPlanIds: [...(usageCounts?.keys() ?? [])].sort(),
      useCountByPlanId: Object.fromEntries(usageCounts ?? []),
      coverUsedByPlanIds: [...(coverUsageByAsset.get(row.assetId) ?? [])].sort(),
      role: (() => {
        if (media?.role === 'opening' || media?.role === 'body') return media.role;
        try {
          const shot = db.prepare(`
            SELECT shots.indexNum
            FROM batch_asset_sources s
            JOIN video_jobs vj ON vj.id = json_extract(s.locationJson, '$.videoJobId')
            JOIN shots ON shots.id = vj.shotId
            WHERE s.assetId = ? AND s.sourceKind = 'module4'
            LIMIT 1
          `).get(row.assetId) as { indexNum: number } | undefined;
          return shot?.indexNum === 1 ? 'opening' : 'body';
        } catch {
          return 'body';
        }
      })(),
    };
  });

  const defaultsJson = parseJson(lineage.defaultsJson);
  const bgmParams = resolveBatchBgmParamsForArrangement(defaultsJson, asRecord(arrangement?.music) as { trackId?: unknown; gainDb?: unknown; fadeInSec?: unknown; fadeOutSec?: unknown } | undefined);
  const batchMusicDefaults = resolveBatchBgmParams(defaultsJson);
  const currentTrackId = nonEmptyString(asRecord(arrangement?.music)?.trackId);
  const liveMusicLibrary = listBatchBgmTracks(db).map(({ id, filename, durationUs }) => ({ id, filename, durationUs }));
  const frozenCurrentTrack = currentTrackId
    ? readFrozenMusicPool(defaultsJson).find((track) => track.trackId === currentTrackId)
    : undefined;
  const musicLibrary = [
    ...liveMusicLibrary,
    ...(frozenCurrentTrack && !liveMusicLibrary.some((track) => track.id === frozenCurrentTrack.trackId)
      ? [{
        id: frozenCurrentTrack.trackId,
        filename: frozenCurrentTrack.relativePath.split(/[\\/]/).filter(Boolean).at(-1) || frozenCurrentTrack.relativePath,
        durationUs: frozenCurrentTrack.durationUs,
      }]
      : []),
  ];
  const outputWidth = outputWidthForPreset(arrangement?.preset);
  const frozenSubtitleStyle = loadFrozenSubtitleStyle(db, planId, outputWidth) ?? defaultTextStyle('subtitle', outputWidth);
  const coverValue = asRecord(arrangement?.cover);
  const frozenCoverTitle = loadFrozenCoverTitleConfig(db, planId);
  const effectiveCoverTitle = resolveBatchCoverTitleOverride(frozenCoverTitle, coverValue, outputWidth);
  return {
    planId,
    batchVersionId: lineage.batchVersionId,
    outputVersionId: lineage.currentVersionId,
    versionNumber: lineage.versionNumber,
    editable: Boolean(lineage.currentVersionId) && lineage.inputState === 'frozen' && lineage.controlState !== 'stopped',
    editRevision: readEditRevision(arrangement),
    visualDurationUs: clips.at(-1)?.timelineEndUs ?? 0,
    clips,
    preserveGaps: arrangement?.preserveGaps === true,
    audio: parseAudioEdits(arrangement?.audio),
    narration,
    subtitleCues,
    subtitleOverride: hasManualSubtitleOverride(arrangement),
    subtitleStyle: resolveBatchSubtitleStyleOverride(frozenSubtitleStyle, arrangement?.subtitle),
    subtitleStyleDefault: frozenSubtitleStyle,
    subtitleStyleOverride: hasBatchSubtitleStyleOverride(arrangement?.subtitle),
    coverTitle: effectiveCoverTitle,
    coverFraming: effectiveCoverTitle?.framing ?? { scale: 1, offsetX: 0, offsetY: 0 },
    coverTitleOverride: Boolean(asRecord(coverValue?.title)),
    coverAssetId: nonEmptyString(coverValue?.assetId),
    coverTimeUs: finiteNumber(coverValue?.timeUs) ?? 0,
    music: {
      trackId: nonEmptyString(asRecord(arrangement?.music)?.trackId),
      gainDb: bgmParams.gainDb,
      fadeInSec: bgmParams.fadeInSec,
      fadeOutSec: bgmParams.fadeOutSec,
    },
    batchMusicDefaults,
    musicLibrary,
    poolAssets,
  };
}

/**
 * 应用一次片段级编辑（整读-改-整写 arrangementJson 的单事务）。
 *
 * - trim/replace：保留上一迭代的等长语义；
 * - trim_variable：变长修剪，保留后续片段位置；
 * - delete：删除后保留空位（至少保留一条片段）；
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
    case 'move_clip':
      if (!nonEmptyString(edit.clipId) || !Number.isSafeInteger(edit.startUs) || edit.startUs < 0) throw new BatchDomainError('invalid_input', '移动片段需要有效的片段 ID 和时间位置');
      break;
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
    case 'set_clip_playback_rate':
      if (!Number.isFinite(edit.playbackRate) || edit.playbackRate < 0.25 || edit.playbackRate > 4) throw new BatchDomainError('invalid_input', '视频倍速须在 0.25–4 倍之间');
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '缺少片段 ID');
      break;
    case 'set_clip_framing':
      if (!edit.framing || ![edit.framing.scale, edit.framing.offsetX, edit.framing.offsetY].every(Number.isFinite)) throw new BatchDomainError('invalid_input', '画面参数无效');
      break;
    case 'split_audio_clip':
      if (!Number.isSafeInteger(edit.atUs)) throw new BatchDomainError('invalid_input', '音频裁切点无效');
      break;
    case 'delete_audio_clip':
      break;
    case 'trim_audio_clip':
      if (edit.track !== 'narration' && edit.track !== 'bgm') throw new BatchDomainError('invalid_input', '音轨无效');
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '音频修剪缺少 clipId');
      if (![edit.sourceStartUs, edit.sourceEndUs].every((v) => Number.isSafeInteger(v))) {
        throw new BatchDomainError('invalid_input', '音频源时间必须是安全整数(微秒)');
      }
      if (edit.sourceStartUs < 0 || edit.sourceEndUs <= edit.sourceStartUs) {
        throw new BatchDomainError('invalid_input', '音频源区间无效');
      }
      break;
    case 'move_audio_clip':
      if (edit.track !== 'narration' && edit.track !== 'bgm') throw new BatchDomainError('invalid_input', '音轨无效');
      if (!nonEmptyString(edit.clipId)) throw new BatchDomainError('invalid_input', '音频移动缺少 clipId');
      if (!Number.isSafeInteger(edit.timelineStartUs) || edit.timelineStartUs < 0) {
        throw new BatchDomainError('invalid_input', '音频移动时间轴起始点必须是非负安全整数');
      }
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
    case 'set_cover':
      if (!nonEmptyString(edit.assetId)) throw new BatchDomainError('invalid_input', '封面编辑需要 assetId');
      if (!Number.isSafeInteger(edit.timeUs) || edit.timeUs < 0) {
        throw new BatchDomainError('invalid_input', '封面时间点必须是非负安全整数(微秒)');
      }
      if (edit.framing !== undefined && edit.framing !== null && (typeof edit.framing !== 'object' || Array.isArray(edit.framing))) {
        throw new BatchDomainError('invalid_input', '封面构图参数无效');
      }
      if (edit.title !== undefined && (edit.title === null || typeof edit.title !== 'object' || Array.isArray(edit.title))) {
        throw new BatchDomainError('invalid_input', '封面标题参数无效');
      }
      break;
    case 'set_music_track':
      if (edit.trackId !== null && !nonEmptyString(edit.trackId)) {
        throw new BatchDomainError('invalid_input', 'BGM 曲目 ID 无效');
      }
      break;
    case 'set_music_params':
      if (![edit.gainDb, edit.fadeInSec, edit.fadeOutSec].every((value) => Number.isFinite(value))) {
        throw new BatchDomainError('invalid_input', 'BGM 参数必须是有限数字');
      }
      break;
    case 'set_music':
      if (edit.trackId !== null && !nonEmptyString(edit.trackId)) {
        throw new BatchDomainError('invalid_input', 'BGM 曲目 ID 无效');
      }
      if (![edit.gainDb, edit.fadeInSec, edit.fadeOutSec].every((value) => Number.isFinite(value))) {
        throw new BatchDomainError('invalid_input', 'BGM 参数必须是有限数字');
      }
      break;
    case 'set_narration_gain':
      if (!Number.isFinite(edit.gainDb)) throw new BatchDomainError('invalid_input', '口播音量必须是有限数字');
      break;
    case 'set_subtitle_cue_text':
      if (!nonEmptyString(edit.cueId) || typeof edit.text !== 'string') {
        throw new BatchDomainError('invalid_input', '字幕文字编辑需要 cueId 与 text');
      }
      break;
    case 'set_subtitle_style':
      if (edit.style !== null && (typeof edit.style !== 'object' || Array.isArray(edit.style))) {
        throw new BatchDomainError('invalid_input', '字幕样式参数无效');
      }
      break;
    case 'move_subtitle_cue':
    case 'trim_subtitle_cue':
      if (!nonEmptyString(edit.cueId)) throw new BatchDomainError('invalid_input', '字幕编辑缺少 cueId');
      if (![edit.startUs, edit.endUs].every((value) => Number.isSafeInteger(value))) {
        throw new BatchDomainError('invalid_input', '字幕时间必须是安全整数(微秒)');
      }
      if (edit.startUs < 0 || edit.endUs <= edit.startUs) {
        throw new BatchDomainError('invalid_input', '字幕时间范围无效');
      }
      break;
    case 'split_subtitle_cue':
      if (!nonEmptyString(edit.cueId) || !Number.isSafeInteger(edit.splitUs) || edit.splitUs < 0) {
        throw new BatchDomainError('invalid_input', '字幕分割需要 cueId 与非负安全整数 splitUs');
      }
      if (edit.leftText !== undefined && typeof edit.leftText !== 'string') {
        throw new BatchDomainError('invalid_input', '字幕左侧文字无效');
      }
      if (edit.rightText !== undefined && typeof edit.rightText !== 'string') {
        throw new BatchDomainError('invalid_input', '字幕右侧文字无效');
      }
      break;
    case 'delete_subtitle_cue':
      if (!nonEmptyString(edit.cueId)) throw new BatchDomainError('invalid_input', '字幕删除缺少 cueId');
      break;
    case 'restore_automatic_subtitles':
      break;
    case 'restore_arrangement':
      if (!edit.snapshot || typeof edit.snapshot !== 'object' || Array.isArray(edit.snapshot)) {
        throw new BatchDomainError('invalid_input', '恢复快照无效');
      }
      if (
        edit.expectedEditRevision !== undefined
        && (!Number.isSafeInteger(edit.expectedEditRevision) || edit.expectedEditRevision < 0)
      ) {
        throw new BatchDomainError('invalid_input', '期望修订号无效');
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
    // 有效编辑会删除 $.review(B4):记录编辑前是否真的存在审核态,供前端判断
    // 这次是否需要提示"重新审核"。unchanged / 纯结构 split 不删 review。
    const reviewPresentBefore = arrangement.review !== undefined && arrangement.review !== null;
    const unchanged: BatchOutputClipEditResult = {
      outputVersionId,
      editRevision,
      changed: false,
      visualChanged: false,
      reviewCleared: false,
      warnings: [],
    };

    const clipIndex = (id: string): number => clips.findIndex((record) => nonEmptyString(record.clipId) === id);
    let visualChanged = false;
    let splitChanged = false;
    let deleted = false;

    if (edit.type === 'move_clip') {
      if (clipIndex(edit.clipId) < 0) throw new BatchDomainError('not_found', '片段不存在');
      const positions = clips.map((clip) => ({ id: String(clip.clipId), startUs: Number(clip.timelineStartUs), endUs: Number(clip.timelineEndUs) }));
      const bodyEndUs = Math.max(visualDurationUs(clips), finiteNumber(asRecord(arrangement.narration)?.durationUs) ?? 0);
      const planned = planClipPosition(positions, edit.clipId, edit.startUs, bodyEndUs);
      if (planned.every((item) => positions.some((original) => original.id === item.id && original.startUs === item.startUs && original.endUs === item.endUs))) return unchanged;
      for (const position of planned) {
        const clip = clips[clipIndex(position.id)];
        clip.timelineStartUs = position.startUs;
        clip.timelineEndUs = position.endUs;
      }
      clips.sort((a, b) => Number(a.timelineStartUs) - Number(b.timelineStartUs));
      arrangement.preserveGaps = true;
      visualChanged = true;
    } else if (edit.type === 'trim' || edit.type === 'trim_variable') {
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
        const poolRow = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, String(clip.assetId));
        if (!poolRow) throw new BatchDomainError('conflict', '片段素材不在本批次冻结素材池或项目可用素材中,无法校验截取区间');
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
        const poolRow = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, String(clip.assetId));
        if (!poolRow) throw new BatchDomainError('conflict', '片段素材不在本批次冻结素材池或项目可用素材中,无法校验截取区间');
        const durationUs = poolAssetDurationUs(poolRow);
        if (durationUs === null) throw new BatchDomainError('invalid_input', '素材缺少时长信息,无法校验截取区间');
        if (normalizedEndUs > durationUs) throw new BatchDomainError('invalid_input', '截取区间超出素材时长');
        const rate = finiteNumber(clip.playbackRate) ?? sourceLengthUs / (Number(clip.timelineEndUs) - Number(clip.timelineStartUs));
        if ((normalizedEndUs - normalizedStartUs) / rate < MIN_CLIP_DURATION_US) {
          throw new BatchDomainError('invalid_input', '修剪后片段长度不能短于 0.5 秒');
        }
        if (sameClipRange(clip, normalizedStartUs, normalizedEndUs)) return unchanged;
        const slip = normalizedEndUs - normalizedStartUs === sourceLengthUs;
        const nextStart = slip ? Number(clip.timelineStartUs) : frameAlignUs(Number(clip.timelineStartUs) + (normalizedStartUs - current.startUs) / rate);
        const nextEnd = frameAlignUs(nextStart + (normalizedEndUs - normalizedStartUs) / rate);
        if (nextStart < (index > 0 ? Number(clips[index - 1].timelineEndUs) : 0) || nextEnd > (index + 1 < clips.length ? Number(clips[index + 1].timelineStartUs) : Infinity)) throw new BatchDomainError('invalid_input', '修剪超出当前空位，不能覆盖相邻片段');
        clip.timelineStartUs = nextStart;
        clip.timelineEndUs = nextEnd;
        clip.sourceStartUs = normalizedStartUs;
        clip.sourceEndUs = normalizedEndUs;
        arrangement.preserveGaps = true;
        visualChanged = true;
      }
    } else if (edit.type === 'set_clip_playback_rate' || edit.type === 'set_clip_framing') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      if (edit.type === 'set_clip_framing') {
        const framing = { scale: Math.max(0.25, Math.min(3, edit.framing.scale)), offsetX: Math.max(-1, Math.min(1, edit.framing.offsetX)), offsetY: Math.max(-1, Math.min(1, edit.framing.offsetY)) };
        if (JSON.stringify(clip.framing) === JSON.stringify(framing)) return unchanged;
        clip.framing = framing;
      } else {
        // 自动分配的相邻边界可能不在整帧上；在微秒域变速，渲染时再统一采样到帧。
        // 否则 2.735 秒恢复 1 倍会被取整到 2.75 秒，误判覆盖下一片段。
        const duration = Math.round((Number(clip.sourceEndUs) - Number(clip.sourceStartUs)) / edit.playbackRate);
        if (duration < MIN_CLIP_DURATION_US) throw new BatchDomainError('invalid_input', '变速后片段不能短于 0.5 秒');
        const end = Number(clip.timelineStartUs) + duration;
        if (index + 1 < clips.length && end > Number(clips[index + 1].timelineStartUs)) throw new BatchDomainError('invalid_input', '变速后空位不足，请先缩短当前片段');
        if (clip.playbackRate === edit.playbackRate) return unchanged;
        clip.playbackRate = edit.playbackRate;
        clip.timelineEndUs = end;
        arrangement.preserveGaps = true;
      }
      visualChanged = true;
    } else if (edit.type === 'split_audio_clip' || edit.type === 'delete_audio_clip' || edit.type === 'trim_audio_clip' || edit.type === 'move_audio_clip') {
      if (edit.track === 'bgm' && !nonEmptyString(asRecord(arrangement.music)?.trackId)) throw new BatchDomainError('invalid_input', '请先添加背景音乐');
      const duration = finiteNumber(asRecord(arrangement.narration)?.durationUs) ?? visualDurationUs(clips);
      const state = { audio: parseAudioEdits(arrangement.audio) };
      try {
        if (edit.type === 'split_audio_clip') {
          editAudioClip(state, edit.track, duration, edit.clipId, edit.atUs);
          splitChanged = true;
        } else if (edit.type === 'delete_audio_clip') {
          editAudioClip(state, edit.track, duration, edit.clipId);
          visualChanged = true;
        } else if (edit.type === 'trim_audio_clip') {
          let sourceDurationUs: number | undefined;
          if (edit.track === 'narration') {
            sourceDurationUs = finiteNumber(asRecord(arrangement.narration)?.durationUs) ?? undefined;
          } else {
            const currentTrackId = nonEmptyString(asRecord(arrangement.music)?.trackId);
            const liveTracks = listBatchBgmTracks(db);
            const track = liveTracks.find((t) => t.id === currentTrackId);
            sourceDurationUs = track?.durationUs;
          }
          trimAudioClip(state, edit.track, duration, edit.clipId, {
            sourceStartUs: edit.sourceStartUs,
            sourceEndUs: edit.sourceEndUs,
            timelineStartUs: edit.timelineStartUs,
            timelineEndUs: edit.timelineEndUs,
            sourceDurationUs,
            minDurationUs: MIN_CLIP_DURATION_US,
          });
          visualChanged = true;
        } else if (edit.type === 'move_audio_clip') {
          moveAudioClip(state, edit.track, duration, edit.clipId, edit.timelineStartUs);
          visualChanged = true;
        }
      } catch (error) {
        throw new BatchDomainError('invalid_input', error instanceof Error ? error.message : '音频编辑失败');
      }
      arrangement.audio = state.audio;
    } else if (edit.type === 'replace') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      const current = clipRangeOf(clip);
      if (!current) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
      const clipLengthUs = current.endUs - current.startUs;
      const targetAssetId = edit.assetId.trim();
      const target = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, targetAssetId);
      if (!target) throw new BatchDomainError('invalid_input', '替换素材不在本批次冻结素材池或项目可用素材中');
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
      arrangement.preserveGaps = true;
      deleted = true;
      visualChanged = true;
    } else if (edit.type === 'insert') {
      const afterIndex = edit.afterClipId === null ? -1 : clipIndex(edit.afterClipId);
      if (afterIndex < 0 && edit.afterClipId !== null) {
        throw new BatchDomainError('not_found', '插入位置片段不存在');
      }
      const position = afterIndex + 1;
      const targetAssetId = edit.assetId.trim();
      const target = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, targetAssetId);
      if (!target) throw new BatchDomainError('invalid_input', '插入素材不在本批次冻结素材池或项目可用素材中');
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
      const insertStart = afterIndex >= 0 ? Number(clips[afterIndex].timelineEndUs) : 0;
      const nextStart = position < clips.length ? Number(clips[position].timelineStartUs) : insertStart + insertDurationUs;
      const shift = Math.max(0, insertStart + insertDurationUs - nextStart);
      for (const following of clips.slice(position)) { following.timelineStartUs = Number(following.timelineStartUs) + shift; following.timelineEndUs = Number(following.timelineEndUs) + shift; }
      clips.splice(position, 0, { ...manualClipRecord(targetAssetId, target.contentFingerprint, insertDurationUs, 'manual_insert'), timelineStartUs: insertStart, timelineEndUs: insertStart + insertDurationUs });
      visualChanged = true;
    } else if (edit.type === 'split') {
      const index = clipIndex(edit.clipId);
      if (index < 0) throw new BatchDomainError('not_found', '片段不存在');
      const clip = clips[index];
      const current = clipRangeOf(clip);
      if (!current) throw new BatchDomainError('conflict', '片段区间数据损坏,不能编辑');
      const sourceLengthUs = current.endUs - current.startUs;
      const offsetUs = frameAlignUs(edit.offsetUs);
      const rate = finiteNumber(clip.playbackRate) ?? sourceLengthUs / (Number(clip.timelineEndUs) - Number(clip.timelineStartUs));
      const sourceOffsetUs = frameAlignUs(offsetUs * rate);
      if (offsetUs < MIN_CLIP_DURATION_US || Number(clip.timelineEndUs) - Number(clip.timelineStartUs) - offsetUs < MIN_CLIP_DURATION_US) {
        throw new BatchDomainError('invalid_input', '分割点两侧都必须至少 0.5 秒');
      }
      const timelineStartUs = finiteNumber(clip.timelineStartUs) ?? 0;
      const timelineEndUs = finiteNumber(clip.timelineEndUs) ?? timelineStartUs + sourceLengthUs;
      const first = { ...clip };
      first.sourceEndUs = current.startUs + sourceOffsetUs;
      first.timelineEndUs = timelineStartUs + offsetUs;
      const second = {
        ...clip,
        clipId: `manual:${randomUUID()}`,
        segmentId: '',
        sourceSegmentId: '',
        sourceStartUs: current.startUs + sourceOffsetUs,
        sourceEndUs: current.endUs,
        timelineStartUs: timelineStartUs + offsetUs,
        timelineEndUs,
        locked: false,
        reason: 'manual_split',
      };
      clips.splice(index, 1, first, second);
      splitChanged = true;
    } else if (edit.type === 'set_cover') {
      const target = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, edit.assetId.trim());
      if (!target) throw new BatchDomainError('invalid_input', '封面素材不在本批次冻结素材池或项目可用素材中');
      if (target.excluded === 1) throw new BatchDomainError('conflict', '封面素材已被排除出本批次分配');
      const durationUs = poolAssetDurationUs(target);
      if (durationUs === null) throw new BatchDomainError('invalid_input', '封面素材缺少时长信息,无法校验抽帧时间');
      const timeUs = edit.timeUs;
      if (timeUs < 0 || timeUs >= durationUs) throw new BatchDomainError('invalid_input', '封面抽帧时间超出素材原片时长');
      const currentCover = asRecord(arrangement.cover) ?? {};
      const currentAssetId = nonEmptyString(currentCover.assetId);
      const currentTimeUs = finiteNumber(currentCover.timeUs);
      const nextCover: Record<string, unknown> = { ...currentCover, assetId: edit.assetId.trim(), timeUs };
      const outputWidth = outputWidthForPreset(arrangement.preset);
      const frozenCoverTitle = loadFrozenCoverTitleConfig(db, planId);
      delete nextCover.clipId;
      delete nextCover.segmentId;
      if (edit.framing !== undefined) nextCover.framing = edit.framing === null ? null : cleanFraming(edit.framing);
      if (edit.title !== undefined) {
        const effectiveTitle = resolveBatchCoverTitleOverride(
          frozenCoverTitle,
          { ...nextCover, title: edit.title },
          outputWidth,
        );
        if (effectiveTitle) {
          nextCover.title = {
            primary: effectiveTitle.primary,
            secondary: effectiveTitle.secondary,
            styles: effectiveTitle.styles,
          };
          nextCover.framing = effectiveTitle.framing;
        } else {
          delete nextCover.title;
        }
      }
      const currentEffectiveTitle = resolveBatchCoverTitleOverride(frozenCoverTitle, currentCover, outputWidth);
      const nextEffectiveTitle = resolveBatchCoverTitleOverride(frozenCoverTitle, nextCover, outputWidth);
      const sameEffectiveTitle = currentEffectiveTitle?.primary === nextEffectiveTitle?.primary
        && currentEffectiveTitle?.secondary === nextEffectiveTitle?.secondary
        && JSON.stringify(currentEffectiveTitle?.styles ?? null) === JSON.stringify(nextEffectiveTitle?.styles ?? null)
        && JSON.stringify(currentEffectiveTitle?.framing ?? null) === JSON.stringify(nextEffectiveTitle?.framing ?? null);
      if (currentAssetId === edit.assetId.trim() && currentTimeUs === timeUs
        && !('clipId' in currentCover) && !('segmentId' in currentCover)
        && sameEffectiveTitle) return unchanged;
      arrangement.cover = nextCover;
      visualChanged = true;
    } else if (edit.type === 'set_music_track') {
      const currentMusic = asRecord(arrangement.music) ?? {};
      const trackId = edit.trackId === null ? null : edit.trackId.trim();
      const currentTrackId = nonEmptyString(currentMusic.trackId);
      // 旧批次可能仍在使用一首已从全局 ready 曲库移除的冻结曲目;
      // 重新提交同一选择是幂等操作,不应因为当前曲库已变化而被拒绝。
      if (currentTrackId === trackId || (currentTrackId === null && trackId === null)) return unchanged;
      if (trackId !== null && !readBatchMusicEditPool(db, parseJson(lineage.defaultsJson)).some((track) => track.trackId === trackId)) {
        throw new BatchDomainError('invalid_input', 'BGM 曲目不在当前 ready 曲库中');
      }
      arrangement.music = { ...currentMusic, trackId };
      visualChanged = true;
    } else if (edit.type === 'set_music_params') {
      const currentMusic = asRecord(arrangement.music) ?? {};
      const currentEffective = resolveBatchBgmParamsForArrangement(
        parseJson(lineage.defaultsJson),
        currentMusic as { trackId?: unknown; gainDb?: unknown; fadeInSec?: unknown; fadeOutSec?: unknown },
      );
      const nextParams = normalizeMusicParams(edit);
      if (
        currentEffective.gainDb === nextParams.gainDb
        && currentEffective.fadeInSec === nextParams.fadeInSec
        && currentEffective.fadeOutSec === nextParams.fadeOutSec
      ) return unchanged;
      const batchDefaults = resolveBatchBgmParams(parseJson(lineage.defaultsJson));
      const nextMusic: Record<string, unknown> = { ...currentMusic };
      if (nextParams.gainDb === batchDefaults.gainDb) delete nextMusic.gainDb;
      else nextMusic.gainDb = nextParams.gainDb;
      if (nextParams.fadeInSec === batchDefaults.fadeInSec) delete nextMusic.fadeInSec;
      else nextMusic.fadeInSec = nextParams.fadeInSec;
      if (nextParams.fadeOutSec === batchDefaults.fadeOutSec) delete nextMusic.fadeOutSec;
      else nextMusic.fadeOutSec = nextParams.fadeOutSec;
      arrangement.music = nextMusic;
      visualChanged = true;
    } else if (edit.type === 'set_music') {
      const currentMusic = asRecord(arrangement.music) ?? {};
      const trackId = edit.trackId === null ? null : edit.trackId.trim();
      const currentEffective = resolveBatchBgmParamsForArrangement(
        parseJson(lineage.defaultsJson),
        currentMusic as { trackId?: unknown; gainDb?: unknown; fadeInSec?: unknown; fadeOutSec?: unknown },
      );
      const currentTrackId = nonEmptyString(currentMusic.trackId) ?? null;
      const nextParams = normalizeMusicParams(edit);
      // 旧批次可能仍在使用一首已从全局 ready 曲库移除的冻结曲目;
      // 重新提交同一选择是幂等操作,不应因为当前曲库已变化而被拒绝。
      if (
        currentTrackId === trackId
        && currentEffective.gainDb === nextParams.gainDb
        && currentEffective.fadeInSec === nextParams.fadeInSec
        && currentEffective.fadeOutSec === nextParams.fadeOutSec
      ) return unchanged;
      if (trackId !== null && trackId !== currentTrackId && !readBatchMusicEditPool(db, parseJson(lineage.defaultsJson)).some((track) => track.trackId === trackId)) {
        throw new BatchDomainError('invalid_input', 'BGM 曲目不在当前 ready 曲库中');
      }
      const batchDefaults = resolveBatchBgmParams(parseJson(lineage.defaultsJson));
      const nextMusic: Record<string, unknown> = { ...currentMusic, trackId };
      if (nextParams.gainDb === batchDefaults.gainDb) delete nextMusic.gainDb;
      else nextMusic.gainDb = nextParams.gainDb;
      if (nextParams.fadeInSec === batchDefaults.fadeInSec) delete nextMusic.fadeInSec;
      else nextMusic.fadeInSec = nextParams.fadeInSec;
      if (nextParams.fadeOutSec === batchDefaults.fadeOutSec) delete nextMusic.fadeOutSec;
      else nextMusic.fadeOutSec = nextParams.fadeOutSec;
      arrangement.music = nextMusic;
      visualChanged = true;
    } else if (edit.type === 'set_narration_gain') {
      const currentNarration = asRecord(arrangement.narration) ?? {};
      const currentGainDb = normalizeNarrationGainDb(currentNarration.gainDb);
      const nextGainDb = normalizeNarrationGainDb(edit.gainDb);
      if (currentGainDb === nextGainDb) return unchanged;
      const nextNarration: Record<string, unknown> = { ...currentNarration };
      if (nextGainDb === NARRATION_GAIN_DB_DEFAULT) delete nextNarration.gainDb;
      else nextNarration.gainDb = nextGainDb;
      arrangement.narration = nextNarration;
      visualChanged = true;
    } else if (edit.type === 'set_subtitle_style') {
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      const outputWidth = outputWidthForPreset(arrangement.preset);
      const frozenStyle = loadFrozenSubtitleStyle(db, planId, outputWidth) ?? defaultTextStyle('subtitle', outputWidth);
      const currentStyle = resolveBatchSubtitleStyleOverride(frozenStyle, subtitle);
      const nextStyle = edit.style === null ? null : normalizeTextStyle(edit.style, currentStyle);
      const currentHasOverride = hasBatchSubtitleStyleOverride(subtitle);
      if (edit.style === null && !currentHasOverride) return unchanged;
      if (nextStyle && currentHasOverride && JSON.stringify(nextStyle) === JSON.stringify(currentStyle)) return unchanged;
      if (nextStyle) subtitle.style = nextStyle;
      else delete subtitle.style;
      if (Object.keys(subtitle).length > 0) arrangement.subtitle = subtitle;
      else delete arrangement.subtitle;
      visualChanged = true;
    } else if (edit.type === 'set_subtitle_cue_text') {
      const cues = readSubtitleCueRecords(arrangement);
      const cue = cues.find((entry) => nonEmptyString(entry.id) === edit.cueId.trim());
      if (!cue) throw new BatchDomainError('not_found', '字幕不存在');
      const wasManual = hasManualSubtitleOverride(arrangement);
      const changedText = cue.text !== edit.text;
      if (!changedText && wasManual) return unchanged;
      cue.text = edit.text;
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      subtitle.cues = cues;
      subtitle.source = 'manual';
      delete subtitle.mode;
      arrangement.subtitle = subtitle;
      visualChanged = true;
    } else if (edit.type === 'move_subtitle_cue' || edit.type === 'trim_subtitle_cue') {
      const cues = readSubtitleCueRecords(arrangement);
      const cue = cues.find((entry) => nonEmptyString(entry.id) === edit.cueId.trim());
      if (!cue) throw new BatchDomainError('not_found', '字幕不存在');
      const startUs = Math.round(edit.startUs);
      const endUs = Math.round(edit.endUs);
      if (endUs > bodyDurationUsOf(arrangement, clips)) throw new BatchDomainError('invalid_input', '字幕时间不能超出成片正文时长');
      const wasManual = hasManualSubtitleOverride(arrangement);
      if (cue.startUs === startUs && cue.endUs === endUs && wasManual) return unchanged;
      cue.startUs = startUs;
      cue.endUs = endUs;
      cue.timingSource = 'manual';
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      subtitle.cues = cues;
      subtitle.source = 'manual';
      delete subtitle.mode;
      arrangement.subtitle = subtitle;
      visualChanged = true;
    } else if (edit.type === 'split_subtitle_cue') {
      const cues = readSubtitleCueRecords(arrangement);
      const index = cues.findIndex((entry) => nonEmptyString(entry.id) === edit.cueId.trim());
      if (index < 0) throw new BatchDomainError('not_found', '字幕不存在');
      const cue = cues[index]!;
      const splitUs = Math.round(edit.splitUs);
      if (splitUs <= Number(cue.startUs) || splitUs >= Number(cue.endUs)) {
        throw new BatchDomainError('invalid_input', '字幕分割点必须位于字幕区间内部');
      }
      const sourceSegmentId = nonEmptyString(cue.sourceSegmentId) ?? String(cue.id);
      const left = {
        ...cue,
        sourceSegmentId,
        endUs: splitUs,
        text: edit.leftText ?? String(cue.text),
        timingSource: 'manual',
      };
      const right = {
        ...cue,
        id: `subtitle:${randomUUID()}`,
        sourceSegmentId,
        startUs: splitUs,
        text: edit.rightText ?? String(cue.text),
        timingSource: 'manual',
      };
      cues.splice(index, 1, left, right);
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      subtitle.cues = cues;
      subtitle.source = 'manual';
      delete subtitle.mode;
      arrangement.subtitle = subtitle;
      visualChanged = true;
    } else if (edit.type === 'delete_subtitle_cue') {
      const cues = readSubtitleCueRecords(arrangement);
      const index = cues.findIndex((entry) => nonEmptyString(entry.id) === edit.cueId.trim());
      if (index < 0) throw new BatchDomainError('not_found', '字幕不存在');
      cues.splice(index, 1);
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      subtitle.cues = cues;
      subtitle.source = 'manual';
      delete subtitle.mode;
      arrangement.subtitle = subtitle;
      visualChanged = true;
    } else if (edit.type === 'restore_automatic_subtitles') {
      if (!hasManualSubtitleOverride(arrangement)) return unchanged;
      // 不保留旧的人工 cues 作为“看起来像自动字幕”的假数据。渲染器会在
      // subtitle 缺失时从最新口播对齐结果派生，编辑器也应立即显示同一事实。
      // 字幕样式是独立的单条覆盖，恢复自动字幕不应把用户刚调好的样式一并抹掉。
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      if (hasBatchSubtitleStyleOverride(subtitle)) arrangement.subtitle = { style: subtitle.style };
      else delete arrangement.subtitle;
      visualChanged = true;
    } else if (edit.type === 'restore_arrangement') {
      // 撤销/重做回放:整包恢复可编辑字段。冲突门禁先行——快照基线的修订号
      // 与当前不一致说明中间发生过其他正式编辑,拒绝覆盖(A18)。
      if (edit.expectedEditRevision !== undefined && edit.expectedEditRevision !== editRevision) {
        throw new BatchDomainError('conflict', '成片已有更新的正式修订，撤销/重做被拒绝，请刷新后重试');
      }
      const snapshot = edit.snapshot;

      // -- 片段列表:逐条按冻结池/项目素材校验,时间轴必须有序且不重叠 --
      if (!Array.isArray(snapshot.clips) || snapshot.clips.length === 0) {
        throw new BatchDomainError('invalid_input', '恢复快照缺少有效片段列表');
      }
      const restoredClips: Array<Record<string, unknown>> = [];
      const seenClipIds = new Set<string>();
      let prevTimelineEndUs = 0;
      for (const entry of snapshot.clips) {
        const record = asRecord(entry);
        const clipId = nonEmptyString(record?.clipId);
        const assetId = nonEmptyString(record?.assetId);
        if (!record || !clipId || !assetId || seenClipIds.has(clipId)) {
          throw new BatchDomainError('invalid_input', '恢复快照片段数据无效');
        }
        seenClipIds.add(clipId);
        const sourceStartUs = finiteNumber(record.sourceStartUs);
        const sourceEndUs = finiteNumber(record.sourceEndUs);
        const timelineStartUs = finiteNumber(record.timelineStartUs);
        const timelineEndUs = finiteNumber(record.timelineEndUs);
        if (
          sourceStartUs === null || sourceEndUs === null || timelineStartUs === null || timelineEndUs === null
          || !Number.isSafeInteger(sourceStartUs) || !Number.isSafeInteger(sourceEndUs)
          || !Number.isSafeInteger(timelineStartUs) || !Number.isSafeInteger(timelineEndUs)
        ) {
          throw new BatchDomainError('invalid_input', `片段 ${clipId} 时间数据无效`);
        }
        if (sourceStartUs < 0 || sourceEndUs <= sourceStartUs || timelineStartUs < prevTimelineEndUs || timelineEndUs <= timelineStartUs) {
          throw new BatchDomainError('invalid_input', `片段 ${clipId} 区间无效或与相邻片段重叠`);
        }
        prevTimelineEndUs = timelineEndUs;
        const poolRow = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, assetId);
        if (!poolRow) throw new BatchDomainError('invalid_input', `片段 ${clipId} 素材不在本批次冻结素材池或项目可用素材中`);
        if (poolRow.excluded === 1) throw new BatchDomainError('conflict', `片段 ${clipId} 素材已被排除出本批次分配`);
        const assetDurationUs = poolAssetDurationUs(poolRow);
        if (assetDurationUs === null) throw new BatchDomainError('invalid_input', `片段 ${clipId} 素材缺少时长信息`);
        if (sourceEndUs > assetDurationUs) throw new BatchDomainError('invalid_input', `片段 ${clipId} 源区间超出素材时长`);
        const playbackRate = finiteNumber(record.playbackRate);
        if (playbackRate !== null && (playbackRate < 0.25 || playbackRate > 4)) {
          throw new BatchDomainError('invalid_input', `片段 ${clipId} 倍速须在 0.25–4 倍之间`);
        }
        restoredClips.push({
          clipId,
          segmentId: nonEmptyString(record.segmentId) ?? '',
          sourceSegmentId: nonEmptyString(record.sourceSegmentId) ?? '',
          assetId,
          contentFingerprint: poolRow.contentFingerprint,
          sourceStartUs,
          sourceEndUs,
          timelineStartUs,
          timelineEndUs,
          locked: record.locked === true,
          ...(nonEmptyString(record.reason) ? { reason: nonEmptyString(record.reason) } : {}),
          ...(playbackRate !== null ? { playbackRate } : {}),
          ...(asRecord(record.framing) ? { framing: cleanFraming(record.framing) } : {}),
        });
      }

      // -- 音轨:沿用严格解析(旧格式自动归一为双坐标) --
      const nextAudio = snapshot.audio === undefined || snapshot.audio === null
        ? undefined
        : parseAudioEdits(snapshot.audio);

      // -- 字幕:人工覆盖 + 样式覆盖分别恢复 --
      const subtitleManual = snapshot.subtitleOverride === true;
      const styleOverride = snapshot.subtitleStyleOverride === true;
      const outputWidth = outputWidthForPreset(arrangement.preset);
      const frozenStyle = loadFrozenSubtitleStyle(db, planId, outputWidth) ?? defaultTextStyle('subtitle', outputWidth);
      let nextCues: Array<Record<string, unknown>> | null = null;
      if (subtitleManual) {
        if (!Array.isArray(snapshot.subtitleCues)) throw new BatchDomainError('invalid_input', '恢复快照缺少人工字幕数据');
        const bodyEndUs = bodyDurationUsOf(arrangement, restoredClips);
        const cueIds = new Set<string>();
        nextCues = snapshot.subtitleCues.map((entry, index) => {
          const record = asRecord(entry);
          const id = nonEmptyString(record?.id) ?? `subtitle:cue:${index + 1}`;
          if (!record || cueIds.has(id)) throw new BatchDomainError('invalid_input', `字幕第 ${index + 1} 条数据无效`);
          cueIds.add(id);
          const startUs = finiteNumber(record.startUs);
          const endUs = finiteNumber(record.endUs);
          if (startUs === null || endUs === null || !Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs)
            || startUs < 0 || endUs <= startUs || endUs > bodyEndUs) {
            throw new BatchDomainError('invalid_input', `字幕第 ${index + 1} 条时间超出成片正文时长`);
          }
          return {
            id,
            sourceSegmentId: nonEmptyString(record.sourceSegmentId) ?? id,
            startUs,
            endUs,
            text: typeof record.text === 'string' ? record.text : '',
            timingSource: 'manual',
          };
        });
      }
      const nextStyle = styleOverride ? normalizeTextStyle(snapshot.subtitleStyle, frozenStyle) : null;

      // -- 封面:显式 assetId 才是覆盖,否则回到首片段派生 --
      const coverAssetId = nonEmptyString(snapshot.coverAssetId);
      let nextCover: Record<string, unknown> | null = null;
      if (coverAssetId) {
        const coverTarget = readAvailableEditingAsset(db, projectId, lineage.batchVersionId, coverAssetId);
        if (!coverTarget) throw new BatchDomainError('invalid_input', '恢复快照封面素材不可用');
        if (coverTarget.excluded === 1) throw new BatchDomainError('conflict', '恢复快照封面素材已被排除出本批次分配');
        const coverDurationUs = poolAssetDurationUs(coverTarget);
        if (coverDurationUs === null) throw new BatchDomainError('invalid_input', '恢复快照封面素材缺少时长信息');
        const coverTimeUs = finiteNumber(snapshot.coverTimeUs);
        if (coverTimeUs === null || !Number.isSafeInteger(coverTimeUs) || coverTimeUs < 0 || coverTimeUs >= coverDurationUs) {
          throw new BatchDomainError('invalid_input', '恢复快照封面抽帧时间超出素材原片时长');
        }
        nextCover = { assetId: coverAssetId, timeUs: coverTimeUs };
        if (asRecord(snapshot.coverFraming)) nextCover.framing = cleanFraming(snapshot.coverFraming);
        if (snapshot.coverTitleOverride === true) {
          const titleRecord = asRecord(snapshot.coverTitle);
          if (titleRecord) {
            nextCover.title = {
              primary: titleRecord.primary,
              secondary: titleRecord.secondary,
              styles: titleRecord.styles,
            };
          }
        }
      }

      // -- BGM / 口播音量:与 set_music / set_narration_gain 相同的归一化 --
      const currentMusic = asRecord(arrangement.music) ?? {};
      const currentTrackId = nonEmptyString(currentMusic.trackId) ?? null;
      if (snapshot.musicTrackId !== undefined && snapshot.musicTrackId !== null && !nonEmptyString(snapshot.musicTrackId)) {
        throw new BatchDomainError('invalid_input', '恢复快照 BGM 曲目 ID 无效');
      }
      const trackId = snapshot.musicTrackId === null || snapshot.musicTrackId === undefined
        ? null
        : String(snapshot.musicTrackId).trim();
      // 旧批次可能仍在使用一首已从全局 ready 曲库移除的冻结曲目;
      // 恢复到当前选择是幂等操作,不应因为当前曲库已变化而被拒绝。
      if (trackId !== null && trackId !== currentTrackId
        && !readBatchMusicEditPool(db, parseJson(lineage.defaultsJson)).some((t) => t.trackId === trackId)) {
        throw new BatchDomainError('invalid_input', '恢复快照 BGM 曲目不在当前 ready 曲库中');
      }
      const batchMusicDefaults = resolveBatchBgmParams(parseJson(lineage.defaultsJson));
      const musicGainDb = finiteNumber(snapshot.musicGainDb) ?? batchMusicDefaults.gainDb;
      const musicFadeInSec = finiteNumber(snapshot.musicFadeInSec) ?? batchMusicDefaults.fadeInSec;
      const musicFadeOutSec = finiteNumber(snapshot.musicFadeOutSec) ?? batchMusicDefaults.fadeOutSec;
      const nextMusic: Record<string, unknown> = { ...currentMusic, trackId };
      if (musicGainDb === batchMusicDefaults.gainDb) delete nextMusic.gainDb; else nextMusic.gainDb = musicGainDb;
      if (musicFadeInSec === batchMusicDefaults.fadeInSec) delete nextMusic.fadeInSec; else nextMusic.fadeInSec = musicFadeInSec;
      if (musicFadeOutSec === batchMusicDefaults.fadeOutSec) delete nextMusic.fadeOutSec; else nextMusic.fadeOutSec = musicFadeOutSec;
      const currentNarration = asRecord(arrangement.narration) ?? {};
      const nextNarrationGainDb = normalizeNarrationGainDb(snapshot.narrationGainDb);
      const nextNarration: Record<string, unknown> = { ...currentNarration };
      if (nextNarrationGainDb === NARRATION_GAIN_DB_DEFAULT) delete nextNarration.gainDb;
      else nextNarration.gainDb = nextNarrationGainDb;
      const nextPreserveGaps = snapshot.preserveGaps === true;

      // -- 内容等价判定:画面流相同且其余字段相同 → 纯结构恢复(不递增 revision、不清 review) --
      const streamEqual = visualStreamKey(clips) === visualStreamKey(restoredClips);
      const currentCover = asRecord(arrangement.cover);
      const coverKey = (cover: Record<string, unknown> | null) => (cover && nonEmptyString(cover.assetId)
        ? JSON.stringify([nonEmptyString(cover.assetId), finiteNumber(cover.timeUs) ?? 0, JSON.stringify(cover.framing ?? null), JSON.stringify(cover.title ?? null)])
        : 'derived');
      const currentSubtitleManual = hasManualSubtitleOverride(arrangement);
      const currentStyleOverride = hasBatchSubtitleStyleOverride(asRecord(arrangement.subtitle) ?? {});
      const currentStyle = resolveBatchSubtitleStyleOverride(frozenStyle, asRecord(arrangement.subtitle) ?? {});
      const cuesKey = (cues: Array<Record<string, unknown>> | null) => (cues
        ? JSON.stringify(cues.map((cue) => [nonEmptyString(cue.id), Math.round(Number(cue.startUs)), Math.round(Number(cue.endUs)), String(cue.text)]))
        : 'auto');
      const currentBgm = resolveBatchBgmParamsForArrangement(
        parseJson(lineage.defaultsJson),
        currentMusic as { trackId?: unknown; gainDb?: unknown; fadeInSec?: unknown; fadeOutSec?: unknown },
      );
      const otherEqual =
        audioEditsKey(arrangement.audio) === audioEditsKey(nextAudio)
        && currentSubtitleManual === subtitleManual
        && cuesKey(currentSubtitleManual ? readSubtitleCueRecords(arrangement) : null) === cuesKey(nextCues)
        && currentStyleOverride === styleOverride
        && (!styleOverride || JSON.stringify(currentStyle) === JSON.stringify(nextStyle))
        && coverKey(currentCover) === coverKey(nextCover)
        && currentTrackId === trackId
        && currentBgm.gainDb === musicGainDb
        && currentBgm.fadeInSec === musicFadeInSec
        && currentBgm.fadeOutSec === musicFadeOutSec
        && normalizeNarrationGainDb(currentNarration.gainDb) === nextNarrationGainDb
        && Boolean(arrangement.preserveGaps) === nextPreserveGaps;

      // 应用恢复结果(写回由尾部统一处理:实质变化走 visualChanged,纯结构走 splitChanged)
      clips.splice(0, clips.length, ...restoredClips);
      if (nextAudio === undefined) delete arrangement.audio;
      else arrangement.audio = nextAudio;
      if (subtitleManual || styleOverride) {
        const subtitle: Record<string, unknown> = {};
        if (styleOverride && nextStyle) subtitle.style = nextStyle;
        if (subtitleManual && nextCues) {
          subtitle.cues = nextCues;
          subtitle.source = 'manual';
          delete subtitle.mode;
        }
        arrangement.subtitle = subtitle;
      } else {
        delete arrangement.subtitle;
      }
      if (nextCover) arrangement.cover = nextCover;
      else delete arrangement.cover;
      arrangement.music = nextMusic;
      arrangement.narration = nextNarration;
      if (nextPreserveGaps) arrangement.preserveGaps = true;
      else delete arrangement.preserveGaps;

      if (streamEqual && otherEqual) {
        splitChanged = true;
      } else {
        visualChanged = true;
      }
    }

    if (visualChanged) {
      arrangement.clips = clips;
      const nextEditRevision = editRevision + 1;
      arrangement.editRevision = nextEditRevision;
      delete arrangement.review;

      // 封面是独立的冻结素材抽帧决定,范围是封面素材整段原片;
      // 时间线片段窗口变化不应把合法的封面时间点重置到第一片段。
      const warnings = buildEditWarnings(clips, arrangement, deleted);
      db.prepare(`
        UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?
      `).run(JSON.stringify(arrangement), outputVersionId);
      return {
        outputVersionId,
        editRevision: nextEditRevision,
        changed: true,
        visualChanged: true,
        reviewCleared: reviewPresentBefore,
        warnings,
      };
    }

    if (splitChanged) {
      arrangement.clips = clips;
      db.prepare(`
        UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?
      `).run(JSON.stringify(arrangement), outputVersionId);
      return { outputVersionId, editRevision, changed: true, visualChanged: false, reviewCleared: false, warnings: [] };
    }

    return unchanged;
  })();
}

/**
 * 口播重试前清理同一脚本快照下所有当前成片的手动字幕覆盖。
 * 新口播成功后，renderer 会从新的对齐句段重新派生自动字幕；清理动作本身
 * 先递增 revision 并删除审核结论，避免旧候选在重试窗口内被误导出。
 */
export function clearBatchSubtitleOverridesForNarrationRetry(
  db: Database.Database,
  projectId: string,
  batchId: string,
  scriptSnapshotId: string,
): number {
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT o.id AS outputVersionId, o.arrangementJson
      FROM batch_output_plans p
      JOIN batch_output_versions o ON o.id = p.currentVersionId
      JOIN batch_production_versions v ON v.id = p.batchVersionId
      JOIN batch_productions b ON b.id = v.batchId
      WHERE p.scriptSnapshotId = ? AND p.batchVersionId = v.id
        AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
    `).all(scriptSnapshotId, batchId, projectId) as Array<{ outputVersionId: string; arrangementJson: string }>;
    let cleared = 0;
    for (const row of rows) {
      const arrangement = asRecord(parseJson(row.arrangementJson));
      if (!arrangement || !hasManualSubtitleOverride(arrangement)) continue;
      const subtitle = asRecord(arrangement.subtitle) ?? {};
      if (hasBatchSubtitleStyleOverride(subtitle)) arrangement.subtitle = { style: subtitle.style };
      else delete arrangement.subtitle;
      arrangement.editRevision = readEditRevision(arrangement) + 1;
      delete arrangement.review;
      db.prepare(`UPDATE batch_output_versions SET arrangementJson = ? WHERE id = ?`)
        .run(JSON.stringify(arrangement), row.outputVersionId);
      cleared += 1;
    }
    return cleared;
  })();
}
