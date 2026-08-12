import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { dataRoot } from '../data-root.ts';
import { probeDurationSec, probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { writeLog } from '../logger.ts';
import { assertNoStorageSymlink, resolveStoragePath, toStorageRelativePath } from '../media-core/storage-path.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
import { buildColorFilterFragments, upgradeColorSnapshot, type ColorSnapshotV1 } from './color-pipeline.ts';
import { applyFrozenCoverTitleToFile, escapeXml } from './cover-title.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from './fingerprint.ts';
import { listAssetSources, resolveSourceFilePath } from './media-catalog.ts';
import { resolveManagedLutPath } from './lut-catalog.ts';
import { buildBatchNarrationSubtitleCues } from './subtitle-cues.ts';
import { readFrozenMusicPool } from './bgm.ts';

export const BATCH_OUTPUT_PRESETS = {
  '3:4': { width: 1080, height: 1440 },
  '3x4': { width: 1080, height: 1440 },
  '9:16': { width: 1080, height: 1920 },
  '9x16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '16x9': { width: 1920, height: 1080 },
} as const;

export type BatchOutputPreset = keyof typeof BATCH_OUTPUT_PRESETS;
export type BatchRenderAudioMode = 'narration' | 'silent_placeholder';

export interface BatchRenderClipInput {
  id?: string;
  clipId?: string;
  segmentId?: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs?: number;
  timelineEndUs?: number;
  timelineInUs?: number;
  timelineOutUs?: number;
  timeline?: { startUs?: number; endUs?: number; inUs?: number; outUs?: number };
  preset?: string;
  fps?: number;
  contentFingerprint?: string;
}

export interface BatchRenderCoverInput {
  clipId?: string;
  segmentId?: string;
  assetId?: string;
  timeUs?: number;
  frameTimeUs?: number;
  sourceTimeUs?: number;
}

export interface BatchRenderArrangementInput {
  clips: BatchRenderClipInput[];
  preset?: string;
  fps?: number;
  targetDurationUs?: number;
  cover?: BatchRenderCoverInput;
  subtitle?: {
    cues?: unknown[];
  };
  music?: { trackId?: unknown };
  /** Optional already-prepared local narration seam (never a provider request). */
  narration?: {
    relativePath?: string;
    fingerprint?: string;
    durationUs?: number;
    segments?: unknown[];
  };
}

export interface BatchRenderNarrationInput {
  /** Exactly one of absolutePath or relativePath must be provided. */
  absolutePath?: string;
  relativePath?: string;
  fingerprint: string;
  durationUs: number;
  segments?: BatchRenderNarrationSegment[];
}

export interface BatchRenderNarrationSegment {
  id: string;
  sourceSegmentId: string;
  text: string;
  startUs: number;
  endUs: number;
}

function normalizeNarrationSegments(value: unknown, durationUs: number): BatchRenderNarrationSegment[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw error('narration segments 必须是数组');
  let previousEndUs = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw error(`narration segment ${index + 1} 无效`);
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
    const sourceSegmentId = typeof raw.sourceSegmentId === 'string' && raw.sourceSegmentId.trim() ? raw.sourceSegmentId.trim() : id;
    const text = typeof raw.text === 'string' && raw.text.trim() ? raw.text.trim() : '';
    const startUs = finiteInteger(raw.startUs, `narration segment ${index + 1} startUs`);
    const endUs = finiteInteger(raw.endUs, `narration segment ${index + 1} endUs`);
    if (!id || !sourceSegmentId || !text || startUs < previousEndUs || endUs <= startUs || endUs > durationUs) {
      throw error(`narration segment ${index + 1} 的身份、文本或对齐时间无效`);
    }
    previousEndUs = endUs;
    return { id, sourceSegmentId, text, startUs, endUs };
  });
}

function normalizeArrangementSubtitleCues(value: unknown, durationUs: number): BatchRenderNarrationSegment[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const cues = (value as Record<string, unknown>).cues;
  if (!Array.isArray(cues)) return [];
  return normalizeNarrationSegments(cues, durationUs);
}

/** Parse the persisted arrangement narration seam without accepting browser absolute paths. */
export function resolveBatchArrangementNarration(value: unknown): BatchRenderNarrationInput | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw error('arrangement narration seam 无效');
  const raw = value as Record<string, unknown>;
  const relativePath = typeof raw.relativePath === 'string' ? raw.relativePath : typeof raw.audioRelativePath === 'string' ? raw.audioRelativePath : '';
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint : typeof raw.audioFingerprint === 'string' ? raw.audioFingerprint : '';
  // Allocator/workspace snapshots use silent_placeholder with no audio path;
  // that is a valid visual candidate and must stay explicitly non-publishable.
  if (!relativePath && raw.productionReady !== true) return undefined;
  if (raw.productionReady !== true) throw error('arrangement narration 尚未达到正式可用状态');
  if (!relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw error('arrangement narration 只允许 storage 相对路径');
  if (!fingerprint) throw error('arrangement narration 缺少完整指纹');
  const durationUs = finiteInteger(raw.durationUs, 'narration durationUs');
  if (durationUs <= 0) throw error('narration durationUs 必须为正数');
  return {
    relativePath,
    fingerprint,
    durationUs,
    segments: normalizeNarrationSegments(raw.segments, durationUs),
  };
}

export interface BatchRenderProgress {
  phase: 'preflight' | 'rendering' | 'cover' | 'verifying' | 'ready';
  completed: number | null;
  total: number | null;
  percent: number | null;
  description?: string;
}

export interface BatchRenderInput {
  db: Database.Database;
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
  storageRoot?: string;
  /** Data root used to resolve managed LUT relative paths; defaults to dataRoot(). */
  dataRootPath?: string;
  /** Internal unique render location; defaults to storage/batch-renders. */
  renderRoot?: string;
  narration?: BatchRenderNarrationInput;
  signal?: AbortSignal;
  onProgress?: (progress: BatchRenderProgress) => void;
  /** Test-only output dimensions override; production defaults remain fixed. */
  outputSize?: { width: number; height: number };
}

export interface BatchRenderResult {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
  planSeq: number;
  outputVersionNumber: number;
  preset: BatchOutputPreset;
  width: number;
  height: number;
  fps: 24;
  durationUs: number;
  audioMode: BatchRenderAudioMode;
  productionReady: boolean;
  /** 已由 renderer 验证并消费的本地对齐句段，供后续字幕图层 seam 使用。 */
  subtitleCues: BatchRenderNarrationSegment[];
  videoAbsolutePath: string;
  coverAbsolutePath: string;
  videoRelativePath: string;
  coverRelativePath: string;
  videoChecksum: string;
  coverChecksum: string;
  /** Stable resolved clips are useful to the artifact registration seam. */
  clips: Array<{ clipId: string; assetId: string; sourceStartUs: number; sourceEndUs: number; timelineStartUs: number; timelineEndUs: number }>;
}

/** Delete a completed candidate when the scheduler rejects its late result. */
export async function discardBatchRenderResult(result: BatchRenderResult): Promise<void> {
  const videoPath = path.resolve(result.videoAbsolutePath);
  const coverPath = path.resolve(result.coverAbsolutePath);
  const jobDir = path.dirname(videoPath);
  if (
    path.dirname(coverPath) !== jobDir
    || path.basename(videoPath) !== 'video.mp4'
    || path.basename(coverPath) !== 'cover.jpg'
  ) throw error('拒绝清理非标准渲染候选路径');
  try {
    const stat = fs.lstatSync(jobDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw error('拒绝清理非目录渲染候选');
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw caught;
  }
  await Promise.allSettled([fsp.unlink(videoPath), fsp.unlink(coverPath)]);
  await fsp.rmdir(jobDir).catch(() => undefined);
}

interface NormalizedClip {
  clipId: string;
  assetId: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  preset: BatchOutputPreset;
  fps: 24;
  contentFingerprint?: string;
}

interface ResolvedClip extends NormalizedClip {
  sourcePath: string;
  assetFingerprint: string;
  sourceDurationUs: number;
  colorSnapshot: ColorSnapshotV1;
  lutPath: string | null;
}

interface Snapshot {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  planId: string;
  outputVersionId: string;
  planSeq: number;
  outputVersionNumber: number;
  arrangement: BatchRenderArrangementInput;
  versionDefaultsJson: Record<string, unknown>;
  clips: ResolvedClip[];
  coverClip: ResolvedClip;
}

function error(message: string): Error {
  return new Error(`batch-render: ${message}`);
}

function finiteInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw error(`${label} 必须是安全整数`);
  return Number(value);
}

function normalizePreset(value: unknown): BatchOutputPreset {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  let candidate: unknown = typeof value === 'string'
    ? value
    : record?.id ?? record?.aspectRatio;
  if (typeof candidate !== 'string' && record) {
    const width = Number(record.width);
    const height = Number(record.height);
    const matching = Object.entries(BATCH_OUTPUT_PRESETS).find(([, size]) => size.width === width && size.height === height);
    candidate = matching?.[0];
  }
  if (typeof candidate !== 'string') throw error('输出比例缺失');
  if (!(candidate in BATCH_OUTPUT_PRESETS)) throw error(`不支持的输出比例: ${candidate}`);
  return candidate as BatchOutputPreset;
}

function normalizeRange(raw: BatchRenderClipInput): { startUs: number; endUs: number } {
  const timeline = raw.timeline ?? {};
  const start = raw.timelineStartUs ?? raw.timelineInUs ?? timeline.startUs ?? timeline.inUs;
  const end = raw.timelineEndUs ?? raw.timelineOutUs ?? timeline.endUs ?? timeline.outUs;
  if (start == null || end == null) throw error('clip 缺少 timeline range');
  const startUs = finiteInteger(start, 'timeline startUs');
  const endUs = finiteInteger(end, 'timeline endUs');
  if (startUs < 0 || endUs <= startUs) throw error('timeline range 必须非空且非负');
  return { startUs, endUs };
}

function normalizeArrangement(raw: unknown): { arrangement: BatchRenderArrangementInput; clips: NormalizedClip[]; preset: BatchOutputPreset } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('arrangementJson 必须是对象');
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.clips) || obj.clips.length === 0) throw error('arrangementJson.clips 不能为空');
  const rootPreset = obj.preset == null ? null : normalizePreset(obj.preset);
  const rootFps = obj.fps == null ? 24 : finiteInteger(obj.fps, 'fps');
  if (rootFps !== 24) throw error('正式批量渲染只支持 24fps');
  if (obj.targetDurationUs != null) {
    const targetDurationUs = finiteInteger(obj.targetDurationUs, 'targetDurationUs');
    if (targetDurationUs <= 0) throw error('targetDurationUs 必须为正数');
  }
  const clipIds = new Set<string>();
  const clips: NormalizedClip[] = obj.clips.map((rawClip, index) => {
    if (!rawClip || typeof rawClip !== 'object' || Array.isArray(rawClip)) throw error(`clip[${index}] 无效`);
    const clip = rawClip as BatchRenderClipInput;
    const clipId = typeof clip.clipId === 'string' ? clip.clipId : typeof clip.id === 'string' ? clip.id : clip.segmentId;
    if (!clipId?.trim()) throw error(`clip[${index}] 缺少稳定 clip/segment id`);
    if (clipIds.has(clipId.trim())) throw error(`clip[${index}] 的稳定 clip/segment id 重复`);
    clipIds.add(clipId.trim());
    if (typeof clip.assetId !== 'string' || !clip.assetId) throw error(`clip[${index}] 缺少 assetId`);
    const sourceStartUs = finiteInteger(clip.sourceStartUs, 'sourceStartUs');
    const sourceEndUs = finiteInteger(clip.sourceEndUs, 'sourceEndUs');
    if (sourceStartUs < 0 || sourceEndUs <= sourceStartUs) throw error(`clip[${index}] 原片区间无效`);
    const timeline = normalizeRange(clip);
    const preset = normalizePreset(clip.preset ?? rootPreset ?? undefined);
    if (rootPreset && preset !== rootPreset) throw error('所有 clip 必须使用同一输出比例');
    const fps = clip.fps == null ? 24 : finiteInteger(clip.fps, 'clip fps');
    if (fps !== 24) throw error('正式批量渲染只支持 24fps');
    return {
      clipId: clipId.trim(), assetId: clip.assetId, sourceStartUs, sourceEndUs,
      timelineStartUs: timeline.startUs, timelineEndUs: timeline.endUs,
      preset, fps: 24 as const, contentFingerprint: typeof clip.contentFingerprint === 'string' ? clip.contentFingerprint : undefined,
    };
  }).sort((a, b) => a.timelineStartUs - b.timelineStartUs || a.clipId.localeCompare(b.clipId));
  if (clips[0].timelineStartUs !== 0) throw error('timeline 必须从 0 开始');
  for (let index = 1; index < clips.length; index += 1) {
    if (clips[index].timelineStartUs !== clips[index - 1].timelineEndUs) throw error('timeline clips 必须连续,不能出现缺口或重叠');
  }
  const arrangement: BatchRenderArrangementInput = {
    ...(obj as unknown as BatchRenderArrangementInput),
    clips: obj.clips as BatchRenderClipInput[],
    preset: rootPreset ?? clips[0].preset,
    fps: 24,
  };
  return { arrangement, clips, preset: clips[0].preset };
}

function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw error(`${label} JSON 损坏`); }
}

async function resolveOriginalSource(
  db: Database.Database,
  projectId: string,
  assetId: string,
  frozenFingerprint: string,
): Promise<{ sourcePath: string; fingerprint: string; probe: Awaited<ReturnType<typeof probeVideoMedia>> }> {
  const sources = db.prepare(`
    SELECT s.id, s.locationJson, s.health
    FROM batch_asset_sources s
    JOIN batch_assets a ON a.id = s.assetId AND a.projectId = ?
    WHERE s.assetId = ?
    ORDER BY CASE s.health WHEN 'healthy' THEN 0 ELSE 1 END, s.createdAt, s.id
  `).all(projectId, assetId) as Array<{ id: string; locationJson: string; health: string }>;
  // `listAssetSources` normalizes v10 rows whose location JSON predates the
  // explicit `kind` discriminator; the renderer must not silently lose those
  // frozen sources merely because it revalidates them in a later phase.
  const parsedLocations = new Map(listAssetSources(db, assetId).map((source) => [source.id, source.locationJson] as const));
  let foundOnline = false;
  for (const source of sources) {
    try {
      const location = parsedLocations.get(source.id);
      if (!location) continue;
      const filePath = resolveSourceFilePath(location);
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) continue;
      foundOnline = true;
      const fingerprint = await computeFingerprintFromFile(filePath);
      if (!fingerprintsEqual(fingerprint, frozenFingerprint)) continue;
      const probe = await probeVideoMedia(filePath);
      if (probe.errorMessage || probe.durationUs <= 0 || probe.width <= 0 || probe.height <= 0) continue;
      return { sourcePath: filePath, fingerprint, probe };
    } catch {
      continue;
    }
  }
  throw error(foundOnline ? `素材 ${assetId} 原片内容已变化` : `素材 ${assetId} 没有可用原片来源`);
}

async function resolveFrozenLut(
  db: Database.Database,
  projectId: string,
  colorSnapshot: ColorSnapshotV1,
  dataRootPath: string,
): Promise<string | null> {
  if (colorSnapshot.lutId === null) return null;
  if (!colorSnapshot.lutFingerprint || colorSnapshot.lutFingerprint.startsWith('unresolved:')) throw error('冻结 LUT 缺少完整内容指纹');
  const row = db.prepare(`SELECT projectId, relativePath, contentFingerprint FROM batch_luts WHERE id = ?`).get(colorSnapshot.lutId) as { projectId: string; relativePath: string; contentFingerprint: string } | undefined;
  if (!row || row.projectId !== projectId) throw error('冻结 LUT 不属于当前项目或记录不存在');
  let filePath: string;
  try {
    filePath = dataRootPath === dataRoot()
      ? resolveManagedLutPath(row.relativePath)
      : resolveStoragePath(dataRootPath, row.relativePath).replace(/\\/g, path.sep);
    assertNoStorageSymlink(dataRootPath, row.relativePath);
  } catch {
    throw error('冻结 LUT 路径不安全');
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw error('冻结 LUT 文件缺失或不是普通文件');
  const fingerprint = await computeFingerprintFromFile(filePath);
  if (!fingerprintsEqual(fingerprint, colorSnapshot.lutFingerprint) || !fingerprintsEqual(fingerprint, row.contentFingerprint)) throw error('冻结 LUT 文件内容已变化');
  return filePath;
}

async function loadSnapshot(input: BatchRenderInput): Promise<Snapshot> {
  const row = input.db.prepare(`
    SELECT
      p.id AS planId, p.batchVersionId, p.seq,
      o.id AS outputVersionId, o.versionNumber, o.arrangementJson,
      v.id AS versionId, v.batchId, v.inputState, v.defaultsJson,
      b.id AS productionBatchId, b.projectId, b.deletedAt
    FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE o.id = ? AND p.id = ? AND v.id = ? AND b.id = ? AND b.projectId = ?
  `).get(input.outputVersionId, input.planId, input.batchVersionId, input.batchId, input.projectId) as {
    planId: string; batchVersionId: string; seq: number; outputVersionId: string; versionNumber: number;
    arrangementJson: string; versionId: string; batchId: string; inputState: 'draft' | 'frozen';
    defaultsJson: string; productionBatchId: string; projectId: string; deletedAt: string | null;
  } | undefined;
  if (!row) throw error('project → batch → version → plan → outputVersion 谱系校验失败');
  if (row.deletedAt) throw error('批次已删除,不能正式渲染');
  if (row.inputState !== 'frozen') throw error('批次版本输入尚未冻结,不能正式渲染');
  const normalized = normalizeArrangement(parseJson(row.arrangementJson, 'arrangementJson'));
  const dataRootPath = path.resolve(input.dataRootPath ?? dataRoot());
  const byAsset = new Map<string, ResolvedClip>();
  for (const clip of normalized.clips) {
    let resolved = byAsset.get(clip.assetId);
    if (!resolved) {
      const asset = input.db.prepare(`SELECT projectId, contentFingerprint FROM batch_assets WHERE id = ? AND projectId = ?`).get(clip.assetId, input.projectId) as { projectId: string; contentFingerprint: string } | undefined;
      if (!asset) throw error(`素材 ${clip.assetId} 不属于当前项目`);
      const pool = input.db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?`).get(input.batchVersionId, clip.assetId) as { colorJson: string } | undefined;
      if (!pool) throw error(`素材 ${clip.assetId} 不在冻结素材池中`);
      if (clip.contentFingerprint && !fingerprintsEqual(clip.contentFingerprint, asset.contentFingerprint)) throw error(`素材 ${clip.assetId} 的冻结指纹与 arrangement 不一致`);
      const source = await resolveOriginalSource(input.db, input.projectId, clip.assetId, asset.contentFingerprint);
      const colorSnapshot = upgradeColorSnapshot(parseJson(pool.colorJson, 'colorJson'));
      const lutPath = await resolveFrozenLut(input.db, input.projectId, colorSnapshot, dataRootPath);
      resolved = { ...clip, sourcePath: source.sourcePath, assetFingerprint: asset.contentFingerprint, sourceDurationUs: source.probe.durationUs, colorSnapshot, lutPath };
      byAsset.set(clip.assetId, resolved);
    }
    if (clip.sourceEndUs > resolved.sourceDurationUs) throw error(`素材 ${clip.assetId} 的 source 区间超出原片时长`);
  }
  const resolvedClips = normalized.clips.map((clip) => ({ ...byAsset.get(clip.assetId)!, ...clip }));
  const firstClip = resolvedClips[0]!;
  const coverInput = normalized.arrangement.cover;
  const coverClipId = coverInput?.clipId ?? coverInput?.segmentId;
  const selectedCoverClip = coverClipId
    ? resolvedClips.find((clip) => clip.clipId === coverClipId)
    : undefined;
  if (coverClipId && !selectedCoverClip) throw error('封面 clip 身份不属于冻结 arrangement');
  if (coverInput?.assetId && selectedCoverClip && coverInput.assetId !== selectedCoverClip.assetId) {
    throw error('封面 clip 与素材身份不一致');
  }
  const coverAssetId = coverInput?.assetId ?? selectedCoverClip?.assetId ?? firstClip.assetId;
  // An explicit cover asset/time is an independent frozen source-frame
  // decision. It may legally point outside every timeline clip while still
  // belonging to the frozen pool, so do not inherit the first clip's range.
  let coverClip = selectedCoverClip ?? (coverInput?.assetId ? undefined : firstClip);
  if (!coverClip) {
    const reusedSource = byAsset.get(coverAssetId);
    if (reusedSource) {
      coverClip = {
        ...reusedSource,
        clipId: `cover:${coverAssetId}`,
        sourceStartUs: 0,
        sourceEndUs: reusedSource.sourceDurationUs,
        timelineStartUs: 0,
        timelineEndUs: reusedSource.sourceDurationUs,
      };
    }
  }
  if (!coverClip) {
    const coverAsset = input.db.prepare(`SELECT projectId, contentFingerprint FROM batch_assets WHERE id = ? AND projectId = ?`).get(coverAssetId, input.projectId) as { projectId: string; contentFingerprint: string } | undefined;
    const coverPool = input.db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ? AND assetId = ?`).get(input.batchVersionId, coverAssetId) as { colorJson: string } | undefined;
    if (!coverAsset || !coverPool) throw error(`封面素材 ${coverAssetId} 不在冻结素材池中`);
    const coverSource = await resolveOriginalSource(input.db, input.projectId, coverAssetId, coverAsset.contentFingerprint);
    const colorSnapshot = upgradeColorSnapshot(parseJson(coverPool.colorJson, 'colorJson'));
    const lutPath = await resolveFrozenLut(input.db, input.projectId, colorSnapshot, dataRootPath);
    coverClip = {
      clipId: `cover:${coverAssetId}`, assetId: coverAssetId, sourceStartUs: 0, sourceEndUs: coverSource.probe.durationUs,
      timelineStartUs: 0, timelineEndUs: coverSource.probe.durationUs, preset: normalized.preset, fps: 24,
      sourcePath: coverSource.sourcePath, assetFingerprint: coverAsset.contentFingerprint,
      sourceDurationUs: coverSource.probe.durationUs, colorSnapshot, lutPath,
    };
  }
  return {
    projectId: input.projectId, batchId: input.batchId, batchVersionId: input.batchVersionId,
    planId: input.planId, outputVersionId: input.outputVersionId, planSeq: row.seq,
    outputVersionNumber: row.versionNumber, arrangement: normalized.arrangement,
    versionDefaultsJson: parseJson(row.defaultsJson, 'defaultsJson') as Record<string, unknown>,
    clips: resolvedClips,
    coverClip,
  };
}

interface ResolvedBgm {
  trackId: string;
  absolutePath: string;
}

export interface BatchBgmParams {
  gainDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export const BATCH_BGM_DEFAULT_PARAMS: BatchBgmParams = { gainDb: -18, fadeInSec: 1.0, fadeOutSec: 1.5 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 从锁定快照的 defaultsJson 解析整批统一的 BGM 混音参数(音量增益/淡入/淡出)。
 * 锁定时快照,渲染只读;缺字段时回落默认值 -18dB / 1.0s / 1.5s。
 */
export function resolveBatchBgmParams(versionDefaultsJson: unknown): BatchBgmParams {
  if (!versionDefaultsJson || typeof versionDefaultsJson !== 'object' || Array.isArray(versionDefaultsJson)) {
    return BATCH_BGM_DEFAULT_PARAMS;
  }
  const raw = (versionDefaultsJson as Record<string, unknown>).batchBgmParams;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return BATCH_BGM_DEFAULT_PARAMS;
  const record = raw as Record<string, unknown>;
  const gainDb = Number(record.gainDb);
  const fadeInSec = Number(record.fadeInSec);
  const fadeOutSec = Number(record.fadeOutSec);
  return {
    gainDb: Number.isFinite(gainDb) ? clamp(gainDb, -60, 0) : BATCH_BGM_DEFAULT_PARAMS.gainDb,
    fadeInSec: Number.isFinite(fadeInSec) ? clamp(fadeInSec, 0, 30) : BATCH_BGM_DEFAULT_PARAMS.fadeInSec,
    fadeOutSec: Number.isFinite(fadeOutSec) ? clamp(fadeOutSec, 0, 30) : BATCH_BGM_DEFAULT_PARAMS.fadeOutSec,
  };
}

/**
 * 解析成片分配的 BGM:只读冻结曲库池(锁定时快照),校验相对路径安全、
 * 文件存在且内容指纹与冻结池一致。曲库池缺失或曲目不在池中时视为分配异常;
 * 没有分配任何曲目(旧批次)返回 null,不混音。
 */
export async function resolveBatchBgm(
  arrangement: BatchRenderArrangementInput,
  versionDefaultsJson: unknown,
  storageRoot: string,
): Promise<ResolvedBgm | null> {
  const trackId = arrangement.music && typeof arrangement.music === 'object'
    ? (arrangement.music as { trackId?: unknown }).trackId
    : null;
  if (!trackId || typeof trackId !== 'string' || !trackId) return null;
  const pool = readFrozenMusicPool(versionDefaultsJson);
  const entry = pool.find((item) => item.trackId === trackId);
  if (!entry) throw error(`成片分配的 BGM（${trackId.slice(0, 8)}）不在冻结曲库中`);
  let filePath: string;
  try {
    filePath = resolveStoragePath(storageRoot, entry.relativePath);
    assertNoStorageSymlink(storageRoot, entry.relativePath);
  } catch {
    throw error('冻结 BGM 路径不安全');
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw error('冻结 BGM 文件缺失或不是普通文件');
  const fingerprint = await computeFingerprintFromFile(filePath);
  if (!fingerprintsEqual(fingerprint, entry.fileFingerprint)) throw error('冻结 BGM 文件内容已变化');
  return { trackId, absolutePath: filePath };
}

function clipFilter(inputIndex: number, clip: ResolvedClip, width: number, height: number, timelineDurationSec: number): string {
  const sourceDurationSec = (clip.sourceEndUs - clip.sourceStartUs) / 1_000_000;
  // FFmpeg PTS are multiplied by timeline/source: a 1s source stretched to a
  // 2s timeline must use PTS*2 (and a 2s source compressed to 1s uses *0.5).
  const timeScale = timelineDurationSec / sourceDurationSec;
  const colorFragments = buildBatchRenderColorFilterFragments({ colorSnapshot: clip.colorSnapshot, lutPath: clip.lutPath });
  const filters = [
    `trim=duration=${sourceDurationSec.toFixed(6)}`,
    'setpts=PTS-STARTPTS',
    Math.abs(timeScale - 1) > 1e-7 ? `setpts=PTS*${timeScale.toFixed(8)}` : '',
    'fps=24',
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    'setsar=1',
    ...colorFragments,
    'format=yuv420p',
  ].filter(Boolean);
  return `[${inputIndex}:v]${filters.join(',')}[clip${inputIndex}]`;
}

/** Shared color-chain seam used by formal rendering and color-preview tests. */
export function buildBatchRenderColorFilterFragments(input: { colorSnapshot: ColorSnapshotV1; lutPath: string | null }): string[] {
  return buildColorFilterFragments({
    colorSnapshot: input.colorSnapshot,
    resolveLutAbsolutePath: (lutId) => {
      if (!input.lutPath) throw error(`LUT ${lutId} 尚未通过冻结文件核验`);
      return input.lutPath;
    },
  });
}

function audioFilter(audioInput: number, durationSec: number, mode: BatchRenderAudioMode): string {
  const source = `[${audioInput}:a]aresample=48000`;
  if (mode === 'narration') return `${source},atrim=duration=${durationSec.toFixed(6)},apad,atrim=duration=${durationSec.toFixed(6)},asetpts=PTS-STARTPTS[narration]`;
  return `${source},anullsrc=channel_layout=stereo:sample_rate=48000`; // replaced by caller for silent lavfi input
}

async function materializeSubtitleOverlays(input: {
  directory: string;
  cues: BatchRenderNarrationSegment[];
  width: number;
  height: number;
}): Promise<string[]> {
  if (input.cues.length === 0) return [];
  await fsp.mkdir(input.directory, { recursive: true });
  const fontSize = Math.max(34, Math.round(input.width * (input.width > input.height ? 0.042 : 0.055)));
  const baselineY = Math.round(input.height * 0.86);
  const strokeWidth = Math.max(3, Math.round(fontSize * 0.09));
  return Promise.all(input.cues.map(async (cue, index) => {
    const target = path.join(input.directory, `cue-${String(index + 1).padStart(3, '0')}.png`);
    const svg = `
      <svg width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" xmlns="http://www.w3.org/2000/svg">
        <text x="${Math.round(input.width / 2)}" y="${baselineY}" text-anchor="middle"
          font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif"
          font-size="${fontSize}" font-weight="600" fill="#ffffff" stroke="#111111"
          stroke-width="${strokeWidth}" stroke-linejoin="round" paint-order="stroke fill">${escapeXml(cue.text)}</text>
      </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(target);
    return target;
  }));
}

function outputDirectory(input: BatchRenderInput): { storageRoot: string; renderRoot: string; jobDir: string } {
  const storageRoot = path.resolve(input.storageRoot ?? path.join(dataRoot(), 'storage'));
  const renderRoot = path.resolve(input.renderRoot ?? path.join(storageRoot, 'batch-renders'));
  fs.mkdirSync(renderRoot, { recursive: true });
  assertNoStorageSymlink(path.dirname(renderRoot), path.basename(renderRoot));
  const safeOutputVersionId = input.outputVersionId.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'output';
  const jobDir = path.join(renderRoot, `${safeOutputVersionId}-${crypto.randomUUID()}`);
  fs.mkdirSync(jobDir, { recursive: true });
  return { storageRoot, renderRoot, jobDir };
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) throw error('任务已中止');
}

async function atomicRenameNoReplace(tempPath: string, finalPath: string): Promise<void> {
  try { if (fs.lstatSync(finalPath)) throw error('正式渲染目标已存在,不得覆盖'); } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught;
  }
  await fsp.rename(tempPath, finalPath);
}

/**
 * Render an immutable output version from original media only. This module
 * deliberately never queries proxy tables; proxy files cannot become formal
 * output by accident.
 */
export async function renderBatchOutputVersion(input: BatchRenderInput): Promise<BatchRenderResult>;
export async function renderBatchOutputVersion(db: Database.Database, input: Omit<BatchRenderInput, 'db'>): Promise<BatchRenderResult>;
export async function renderBatchOutputVersion(first: BatchRenderInput | Database.Database, second?: Omit<BatchRenderInput, 'db'>): Promise<BatchRenderResult> {
  const input: BatchRenderInput = first instanceof Object && 'prepare' in first
    ? { ...(second as Omit<BatchRenderInput, 'db'>), db: first as Database.Database }
    : first as BatchRenderInput;
  const controller = input.signal ? null : new AbortController();
  const signal = input.signal ?? controller!.signal;
  const report = (progress: BatchRenderProgress): void => input.onProgress?.(progress);
  report({ phase: 'preflight', completed: null, total: null, percent: null, description: '重新核验冻结谱系、原片与 LUT' });
  assertSignal(signal);
  const snapshot = await loadSnapshot(input);
  const normalizedPreset = snapshot.clips[0].preset;
  const presetSize = BATCH_OUTPUT_PRESETS[normalizedPreset];
  const outputSize = input.outputSize ?? presetSize;
  if (!Number.isInteger(outputSize.width) || !Number.isInteger(outputSize.height) || outputSize.width <= 0 || outputSize.height <= 0) throw error('输出尺寸无效');
  const arrangementTargetDurationUs = snapshot.arrangement.targetDurationUs == null
    ? 0
    : finiteInteger(snapshot.arrangement.targetDurationUs, 'targetDurationUs');
  const visualDurationUs = Math.max(snapshot.clips.at(-1)!.timelineEndUs, arrangementTargetDurationUs);
  const resolvedStorageRoot = path.resolve(input.storageRoot ?? path.join(dataRoot(), 'storage'));
  const narrationInput = input.narration ?? resolveBatchArrangementNarration(snapshot.arrangement.narration);
  const narrationSegments = narrationInput
    ? normalizeNarrationSegments(narrationInput.segments, narrationInput.durationUs)
    : [];
  const narrationPath = narrationInput ? resolveNarrationPath(narrationInput, resolvedStorageRoot) : null;
  const audioMode: BatchRenderAudioMode = narrationInput ? 'narration' : 'silent_placeholder';
  const targetDurationUs = narrationInput?.durationUs ?? visualDurationUs;
  if (!Number.isSafeInteger(targetDurationUs) || targetDurationUs <= 0) throw error('目标时长无效');
  if (narrationInput) {
    if (!narrationPath) throw error('narration 路径缺失');
    const narrationFingerprint = await computeFingerprintFromFile(narrationPath);
    if (!narrationInput || !fingerprintsEqual(narrationFingerprint, narrationInput.fingerprint)) throw error('narration 内容指纹与冻结输入不一致');
    const measuredDuration = await probeDurationSec(narrationPath);
    if (!narrationInput || !Number.isFinite(measuredDuration) || Math.abs(measuredDuration - narrationInput.durationUs / 1_000_000) > 0.1) throw error('narration 实际时长与冻结时长不一致');
  }
  const subtitleCues = narrationSegments.length > 0
    ? buildBatchNarrationSubtitleCues(narrationSegments)
    : normalizeArrangementSubtitleCues(snapshot.arrangement.subtitle, targetDurationUs);
  // 片头封面:与单条剪辑同一个契约(FINAL_EDIT_INTRO_DURATION_US = 20 帧),
  // 带标题的封面静帧接在正文之前,音频与字幕整体后移同样时长。脚本时长预算
  // (script-duration-policy)本来就为它扣掉了这 20 帧,不加片头成片会系统性
  // 短一个封面的长度。
  const bodyDurationUs = targetDurationUs;
  const bodyDurationSec = bodyDurationUs / 1_000_000;
  const introDurationSec = FINAL_EDIT_INTRO_DURATION_US / 1_000_000;
  const totalDurationSec = introDurationSec + bodyDurationSec;
  const { storageRoot, jobDir } = outputDirectory(input);
  const videoTemp = path.join(jobDir, `.video-${crypto.randomUUID()}.mp4.tmp`);
  const videoFinal = path.join(jobDir, 'video.mp4');
  const coverTemp = path.join(jobDir, `.cover-${crypto.randomUUID()}.jpg.tmp`);
  const coverFinal = path.join(jobDir, 'cover.jpg');
  const subtitleDir = path.join(jobDir, '.subtitle-overlays');
  try {
    // 封面必须先于视频生成:带标题的封面就是片头那 20 帧静帧的输入源。
    report({ phase: 'cover', completed: null, total: null, percent: null, description: '生成第一镜头冻结时间点封面' });
    assertSignal(signal);
    const first = snapshot.coverClip;
    const cover = snapshot.arrangement.cover;
    const requestedCoverTime = cover?.timeUs ?? cover?.frameTimeUs ?? cover?.sourceTimeUs;
    const coverTimeUs = requestedCoverTime == null ? first.sourceStartUs : finiteInteger(requestedCoverTime, 'cover timeUs');
    if (coverTimeUs < first.sourceStartUs || coverTimeUs >= first.sourceEndUs) throw error('封面冻结时间点不在第一镜头原片区间内');
    const coverColorFragments = buildBatchRenderColorFilterFragments({ colorSnapshot: first.colorSnapshot, lutPath: first.lutPath });
    await runFfmpeg([
      '-ss', (coverTimeUs / 1_000_000).toFixed(6), '-i', first.sourcePath,
      '-frames:v', '1', '-vf', [
        'fps=24', `scale=${outputSize.width}:${outputSize.height}:force_original_aspect_ratio=increase`,
        `crop=${outputSize.width}:${outputSize.height}`, 'setsar=1', ...coverColorFragments, 'format=yuv420p',
      ].join(','), '-q:v', '2', '-f', 'image2', '-y', coverTemp,
    ], { signal });
    // 冻结的封面标题设置随版本 defaultsJson 锁定:抽帧+色彩链之后合成主/副标题,
    // 再校验与算指纹,保证导出指纹校验与工作区预览一致。片头用的就是这张成品。
    await applyFrozenCoverTitleToFile(input.db, input.planId, coverTemp, outputSize);
    const audioInput = snapshot.clips.length;
    const bgm = await resolveBatchBgm(snapshot.arrangement, snapshot.versionDefaultsJson, resolvedStorageRoot);
    const args: string[] = [];
    snapshot.clips.forEach((clip) => {
      args.push('-ss', (clip.sourceStartUs / 1_000_000).toFixed(6), '-t', ((clip.sourceEndUs - clip.sourceStartUs) / 1_000_000).toFixed(6), '-i', clip.sourcePath);
    });
    if (narrationPath) args.push('-i', narrationPath);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const bgmInput = bgm ? audioInput + 1 : null;
    if (bgm) args.push('-stream_loop', '-1', '-i', bgm.absolutePath);
    const subtitleStartInput = audioInput + 1 + (bgm ? 1 : 0);
    const subtitlePaths = await materializeSubtitleOverlays({
      directory: subtitleDir,
      cues: subtitleCues,
      width: outputSize.width,
      height: outputSize.height,
    });
    subtitlePaths.forEach((subtitlePath) => args.push('-loop', '1', '-framerate', '24', '-i', subtitlePath));
    // 片头封面挂在最后一个输入位:这样 clip / 音频 / BGM / 字幕的既有下标全部不变。
    const coverInput = subtitleStartInput + subtitlePaths.length;
    args.push('-loop', '1', '-framerate', '24', '-i', coverTemp);
    const filters = snapshot.clips.map((clip, index) => clipFilter(index, clip, outputSize.width, outputSize.height, (clip.timelineEndUs - clip.timelineStartUs) / 1_000_000));
    filters.push(`${snapshot.clips.map((_, index) => `[clip${index}]`).join('')}concat=n=${snapshot.clips.length}:v=1:a=0[vconcat]`);
    // 回归探针:画面与口播对齐后,下面的 tpad/trim 应是 no-op;偏差超过
    // 0.15 秒说明"声画又各走各的"了,记 warning 供排查,不阻塞渲染。
    const visualDurationSec = visualDurationUs / 1_000_000;
    if (Math.abs(bodyDurationSec - visualDurationSec) > 0.15) {
      writeLog({
        projectId: input.projectId,
        level: 'warn',
        message: `渲染对齐偏差过大:画面 ${visualDurationSec.toFixed(3)}s vs 口播 ${bodyDurationSec.toFixed(3)}s（偏差 ${Math.abs(bodyDurationSec - visualDurationSec).toFixed(3)}s）batch=${input.batchId} plan=${input.planId} outputVersion=${input.outputVersionId}`,
      });
    }
    if (bodyDurationSec > visualDurationSec + 1e-6) filters.push(`[vconcat]tpad=stop_mode=clone:stop_duration=${(bodyDurationSec - visualDurationSec).toFixed(6)},trim=duration=${bodyDurationSec.toFixed(6)},setpts=PTS-STARTPTS[vbody]`);
    else filters.push(`[vconcat]trim=duration=${bodyDurationSec.toFixed(6)},setpts=PTS-STARTPTS[vbody]`);
    // 片头静帧接在正文之前。setsar=1 与 clipFilter 一致,否则 concat 会因
    // SAR 不一致失败。
    filters.push(`[${coverInput}:v]trim=duration=${introDurationSec.toFixed(6)},setpts=PTS-STARTPTS,scale=${outputSize.width}:${outputSize.height},crop=${outputSize.width}:${outputSize.height},setsar=1,fps=24,format=yuv420p[intro]`);
    filters.push(`[intro][vbody]concat=n=2:v=1:a=0[vbase]`);
    let currentVideoLabel = 'vbase';
    // 字幕时间是正文内的时间,叠加时整体后移一个片头。
    subtitleCues.forEach((cue, index) => {
      const nextVideoLabel = `vsubtitle${index}`;
      const startSec = introDurationSec + cue.startUs / 1_000_000;
      const endSec = introDurationSec + cue.endUs / 1_000_000;
      filters.push(`[${currentVideoLabel}][${subtitleStartInput + index}:v]overlay=0:0:enable='gte(t,${startSec.toFixed(6)})*lt(t,${endSec.toFixed(6)})'[${nextVideoLabel}]`);
      currentVideoLabel = nextVideoLabel;
    });
    filters.push(`[${currentVideoLabel}]null[vout]`);
    const voiceLabel = narrationPath ? 'narration' : 'silence';
    if (narrationPath) filters.push(audioFilter(audioInput, bodyDurationSec, 'narration'));
    else filters.push(`[${audioInput}:a]aresample=48000,apad,atrim=duration=${bodyDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[silence]`);
    if (bgm && bgmInput != null) {
      // 混音链:响度归一化 → 增益 → 裁到正文时长 → 淡入淡出 → 与口播 amix。
      // 音量/淡入/淡出来自锁定快照(整批统一),渲染只读不重选。
      const bgmParams = resolveBatchBgmParams(snapshot.versionDefaultsJson);
      const fadeInSec = Math.min(bgmParams.fadeInSec, bodyDurationSec);
      const fadeOutSec = Math.min(bgmParams.fadeOutSec, bodyDurationSec);
      const fadeStartSec = Math.max(0, bodyDurationSec - fadeOutSec);
      const fades = [
        fadeInSec > 0 ? `afade=t=in:st=0:d=${fadeInSec.toFixed(6)}` : '',
        fadeOutSec > 0 ? `afade=t=out:st=${fadeStartSec.toFixed(6)}:d=${fadeOutSec.toFixed(6)}` : '',
      ].filter(Boolean).join(',');
      filters.push(`[${bgmInput}:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,volume=${bgmParams.gainDb.toFixed(1)}dB,atrim=duration=${bodyDurationSec.toFixed(6)},${fades ? `${fades},` : ''}asetpts=PTS-STARTPTS[music]`);
      filters.push(`[${voiceLabel}][music]amix=inputs=2:duration=longest:dropout_transition=0,apad,atrim=duration=${bodyDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[abody]`);
    } else {
      filters.push(`[${voiceLabel}]anull[abody]`);
    }
    // 音轨整体后移一个片头,片头期间静音(与单条 renderer 的 adelay 一致)。
    const introDelayMs = (FINAL_EDIT_INTRO_DURATION_US / 1000).toFixed(3);
    filters.push(`[abody]adelay=${introDelayMs}|${introDelayMs},apad,atrim=duration=${totalDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[aout]`);
    report({
      phase: 'rendering', completed: 0, total: totalDurationSec, percent: 0,
      description: audioMode === 'narration'
        ? `渲染画面、口播与 ${subtitleCues.length} 条字幕${bgm ? '及背景音乐' : ''}`
        : `渲染静音视觉候选与 ${subtitleCues.length} 条预计字幕`,
    });
    assertSignal(signal);
    await runFfmpeg([
      ...args,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-t', totalDurationSec.toFixed(6), '-r', '24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', '-y', videoTemp,
    ], {
      signal,
      onProgressSec: (seconds) => {
        const completed = Math.max(0, Math.min(totalDurationSec, seconds));
        report({ phase: 'rendering', completed, total: totalDurationSec, percent: totalDurationSec > 0 ? completed / totalDurationSec : null, description: 'FFmpeg 实际媒体时间' });
      },
    });
    await fsp.rm(subtitleDir, { recursive: true, force: true });
    report({ phase: 'verifying', completed: null, total: null, percent: null, description: '校验正式渲染产物' });
    assertSignal(signal);
    const probe = await probeVideoMedia(videoTemp);
    if (
      probe.errorMessage
      || probe.width !== outputSize.width
      || probe.height !== outputSize.height
      || Math.abs(probe.fps - 24) > 0.2
      || probe.durationUs <= 0
      || Math.abs(probe.durationUs / 1_000_000 - totalDurationSec) > 0.12
      || probe.hasAudio !== true
      || probe.videoCodec !== 'h264'
      || probe.pixelFormat !== 'yuv420p'
      || probe.audioCodec !== 'aac'
      || probe.audioSampleRate !== 48_000
      || !/(?:^|,)mp4(?:,|$)/u.test(probe.format ?? '')
    ) throw error('视频产物容器、音轨、尺寸、帧率或时长校验失败');
    const videoChecksum = await computeFingerprintFromFile(videoTemp);
    const coverStat = fs.lstatSync(coverTemp);
    if (coverStat.isSymbolicLink() || !coverStat.isFile() || coverStat.size <= 0) throw error('封面产物为空');
    const coverChecksum = await computeFingerprintFromFile(coverTemp);
    assertSignal(signal);
    await atomicRenameNoReplace(videoTemp, videoFinal);
    await atomicRenameNoReplace(coverTemp, coverFinal);
    report({ phase: 'ready', completed: totalDurationSec, total: totalDurationSec, percent: 1, description: '正式渲染完成' });
    return {
      projectId: snapshot.projectId, batchId: snapshot.batchId, batchVersionId: snapshot.batchVersionId,
      planId: snapshot.planId, outputVersionId: snapshot.outputVersionId, planSeq: snapshot.planSeq,
      outputVersionNumber: snapshot.outputVersionNumber, preset: normalizedPreset,
      width: outputSize.width, height: outputSize.height, fps: 24, durationUs: probe.durationUs,
      audioMode, productionReady: audioMode === 'narration',
      subtitleCues,
      videoAbsolutePath: videoFinal, coverAbsolutePath: coverFinal,
      videoRelativePath: toStorageRelativePath(storageRoot, videoFinal), coverRelativePath: toStorageRelativePath(storageRoot, coverFinal),
      videoChecksum, coverChecksum,
      clips: snapshot.clips.map(({ clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs }) => ({ clipId, assetId, sourceStartUs, sourceEndUs, timelineStartUs, timelineEndUs })),
    };
  } catch (caught) {
    await Promise.allSettled([fsp.unlink(videoTemp), fsp.unlink(coverTemp), fsp.unlink(videoFinal), fsp.unlink(coverFinal)]);
    // The job directory is unique to this attempt. Remove it as a unit after
    // cleaning the known files so an aborted/failed render cannot leave an
    // orphan candidate directory behind. Refuse to recurse through a path
    // that was swapped to a symlink while the task was running.
    try {
      const stat = fs.lstatSync(jobDir);
      if (!stat.isSymbolicLink() && stat.isDirectory()) await fsp.rm(jobDir, { recursive: true, force: true });
    } catch { /* best effort cleanup; never touch prior formal artifacts */ }
    if (signal.aborted) throw error('任务已中止');
    throw caught;
  }
}

function resolveNarrationPath(input: BatchRenderNarrationInput, storageRoot: string): string {
  if ((input.absolutePath && input.relativePath) || (!input.absolutePath && !input.relativePath)) throw error('narration 必须提供唯一的本地路径');
  const storageRelative = input.relativePath?.replace(/^storage[\\/]/u, '');
  const filePath = input.absolutePath
    ? path.resolve(input.absolutePath)
    : resolveStoragePath(storageRoot, storageRelative!);
  if (storageRelative) assertNoStorageSymlink(storageRoot, storageRelative);
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw error('narration 必须是非空普通文件且不能是符号链接');
  if (!Number.isSafeInteger(input.durationUs) || input.durationUs <= 0) throw error('narration durationUs 无效');
  return filePath;
}

export interface BatchCoverRegenerationInput {
  db: Database.Database;
  projectId: string;
  batchId: string;
  planId: string;
  /** 封面抽帧时间点(微秒),必须落在封面取材 clip 的原片区间内 */
  timeUs: number;
  storageRoot?: string;
  dataRootPath?: string;
  signal?: AbortSignal;
}

export interface BatchCoverRegenerationResult {
  planId: string;
  outputVersionId: string;
  timeUs: number;
  coverRelativePath: string;
  coverChecksum: string;
}

/**
 * 换封面(简化版,问题 6/8):改写当前成片版本 arrangement.cover.timeUs 后,
 * 仍然从原片(第一镜头或显式封面 clip)按新时间点重新抽帧,复用同一套冻结
 * 色彩管线。绝不从成片抽帧——成片不是 original-media,从成片取材会同时
 * 打破 original-media-only 不变量与正式导出预检。
 *
 * 产物原子覆盖既有候选封面文件,并把最新渲染尝试的 coverChecksum 同步
 * 更新,让工作区预览与正式导出的指纹校验保持一致;导出仍走 renderer 产物
 * 的封面相对路径,发布链路无需改动。
 */
export async function regenerateBatchOutputCover(input: BatchCoverRegenerationInput): Promise<BatchCoverRegenerationResult> {
  const { db, projectId, batchId, planId, timeUs } = input;
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw error('封面抽帧时间点必须是安全整数');
  const signal = input.signal ?? new AbortController().signal;
  const storageRoot = path.resolve(input.storageRoot ?? path.join(dataRoot(), 'storage'));
  const dataRootPath = path.resolve(input.dataRootPath ?? dataRoot());

  const lineage = db.prepare(`
    SELECT p.batchVersionId, p.currentVersionId
    FROM batch_output_plans p
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    LEFT JOIN batch_output_versions o ON o.id = p.currentVersionId
    WHERE p.id = ? AND b.id = ? AND b.projectId = ? AND b.deletedAt IS NULL
  `).get(planId, batchId, projectId) as {
    batchVersionId: string;
    currentVersionId: string | null;
  } | undefined;
  if (!lineage) throw error('plan 不属于该批次');
  if (!lineage.currentVersionId) throw error('当前成片版本还没有渲染候选,不能换封面');

  // 解析并重新核验冻结谱系(原片完整指纹 + LUT),拿到封面取材 clip 与色彩快照。
  const snapshot = await loadSnapshot({
    db,
    projectId,
    batchId,
    batchVersionId: lineage.batchVersionId,
    planId,
    outputVersionId: lineage.currentVersionId,
    storageRoot,
    dataRootPath,
    signal,
  });
  const coverClip = snapshot.coverClip;
  if (timeUs < coverClip.sourceStartUs || timeUs >= coverClip.sourceEndUs) {
    throw error('封面冻结时间点不在第一镜头原片区间内');
  }

  // 1. 就地改写 arrangement.cover.timeUs(与 narration 就地升级同一套 json_set)。
  db.prepare(`
    UPDATE batch_output_versions
    SET arrangementJson = json_set(arrangementJson, '$.cover.timeUs', ?)
    WHERE id = ?
  `).run(timeUs, lineage.currentVersionId);

  // 2. 定位最新成功渲染候选的封面产物(工作区预览与导出都从这里取材)。
  const candidate = db.prepare(`
    SELECT a.id AS attemptId, a.resultJson
    FROM batch_tasks t
    JOIN batch_task_attempts a ON a.taskId = t.id AND a.attemptNumber = t.attemptCount
    WHERE t.projectId = ? AND t.batchId = ? AND t.workType = 'render'
      AND t.targetKind = 'output_version' AND t.targetId = ? AND t.status = 'succeeded'
      AND a.status = 'succeeded'
    ORDER BY t.createdAt DESC, t.id DESC LIMIT 1
  `).get(projectId, batchId, lineage.currentVersionId) as {
    attemptId: string;
    resultJson: string | null;
  } | undefined;
  if (!candidate?.resultJson) throw error('当前成片版本没有可用的渲染候选');
  const record = parseJson(candidate.resultJson, '渲染候选结果') as Record<string, unknown> | null;
  const coverRelativePath = record && typeof record.coverRelativePath === 'string' ? record.coverRelativePath : '';
  if (!coverRelativePath) throw error('渲染候选缺少封面产物路径');
  let coverAbsolutePath: string;
  try {
    coverAbsolutePath = resolveStoragePath(storageRoot, coverRelativePath);
    assertNoStorageSymlink(storageRoot, coverRelativePath);
  } catch {
    throw error('候选封面路径不安全');
  }
  const coverStat = fs.lstatSync(coverAbsolutePath);
  if (coverStat.isSymbolicLink() || !coverStat.isFile()) throw error('候选封面文件缺失');

  // 3. 从原片按新时间点抽帧,临时文件 + 原子覆盖候选封面。
  const outputSize = BATCH_OUTPUT_PRESETS[coverClip.preset] ?? BATCH_OUTPUT_PRESETS['3:4'];
  const coverTemp = `${coverAbsolutePath}.${crypto.randomUUID()}.tmp.jpg`;
  try {
    assertSignal(signal);
    const colorFragments = buildBatchRenderColorFilterFragments({ colorSnapshot: coverClip.colorSnapshot, lutPath: coverClip.lutPath });
    await runFfmpeg([
      '-ss', (timeUs / 1_000_000).toFixed(6), '-i', coverClip.sourcePath,
      '-frames:v', '1', '-vf', [
        'fps=24', `scale=${outputSize.width}:${outputSize.height}:force_original_aspect_ratio=increase`,
        `crop=${outputSize.width}:${outputSize.height}`, 'setsar=1', ...colorFragments, 'format=yuv420p',
      ].join(','), '-q:v', '2', '-f', 'image2', '-y', coverTemp,
    ], { signal });
    assertSignal(signal);
    // 换封面抽帧后重放同一套冻结标题合成,保证"换封面不丢标题"。
    await applyFrozenCoverTitleToFile(db, planId, coverTemp, outputSize);
    const regeneratedStat = fs.lstatSync(coverTemp);
    if (regeneratedStat.isSymbolicLink() || !regeneratedStat.isFile() || regeneratedStat.size <= 0) {
      throw error('封面抽帧产物为空');
    }
    const coverChecksum = await computeFingerprintFromFile(coverTemp);
    await fsp.rename(coverTemp, coverAbsolutePath);

    // 4. 同步渲染尝试的封面指纹:导出发布时会按渲染结果里的 checksum 复核。
    db.prepare(`
      UPDATE batch_task_attempts
      SET resultJson = json_set(resultJson, '$.coverChecksum', ?)
      WHERE id = ?
    `).run(coverChecksum, candidate.attemptId);

    return {
      planId,
      outputVersionId: lineage.currentVersionId,
      timeUs,
      coverRelativePath,
      coverChecksum,
    };
  } catch (caught) {
    await fsp.unlink(coverTemp).catch(() => undefined);
    if (signal.aborted) throw error('任务已中止');
    throw caught;
  }
}

export { normalizeArrangement as normalizeBatchRenderArrangement };
