import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { probeDurationSec, probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { assertNoStorageSymlink, resolveStoragePath, toStorageRelativePath } from '../final-edit/storage-path.ts';
import { buildColorFilterFragments, upgradeColorSnapshot, type ColorSnapshotV1 } from './color-pipeline.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from './fingerprint.ts';
import { listAssetSources, resolveSourceFilePath } from './media-catalog.ts';
import { resolveManagedLutPath } from './lut-catalog.ts';

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
      v.id AS versionId, v.batchId, v.inputState,
      b.id AS productionBatchId, b.projectId, b.deletedAt
    FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    WHERE o.id = ? AND p.id = ? AND v.id = ? AND b.id = ? AND b.projectId = ?
  `).get(input.outputVersionId, input.planId, input.batchVersionId, input.batchId, input.projectId) as {
    planId: string; batchVersionId: string; seq: number; outputVersionId: string; versionNumber: number;
    arrangementJson: string; versionId: string; batchId: string; inputState: 'draft' | 'frozen'; productionBatchId: string; projectId: string; deletedAt: string | null;
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
    clips: resolvedClips,
    coverClip,
  };
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
  if (mode === 'narration') return `${source},atrim=duration=${durationSec.toFixed(6)},apad,atrim=duration=${durationSec.toFixed(6)},asetpts=PTS-STARTPTS[aout]`;
  return `${source},anullsrc=channel_layout=stereo:sample_rate=48000`; // replaced by caller for silent lavfi input
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
  const targetDurationSec = targetDurationUs / 1_000_000;
  const { storageRoot, jobDir } = outputDirectory(input);
  const videoTemp = path.join(jobDir, `.video-${crypto.randomUUID()}.mp4.tmp`);
  const videoFinal = path.join(jobDir, 'video.mp4');
  const coverTemp = path.join(jobDir, `.cover-${crypto.randomUUID()}.jpg.tmp`);
  const coverFinal = path.join(jobDir, 'cover.jpg');
  try {
    const args: string[] = [];
    snapshot.clips.forEach((clip) => {
      args.push('-ss', (clip.sourceStartUs / 1_000_000).toFixed(6), '-t', ((clip.sourceEndUs - clip.sourceStartUs) / 1_000_000).toFixed(6), '-i', clip.sourcePath);
    });
    const audioInput = snapshot.clips.length;
    if (narrationPath) args.push('-i', narrationPath);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const filters = snapshot.clips.map((clip, index) => clipFilter(index, clip, outputSize.width, outputSize.height, (clip.timelineEndUs - clip.timelineStartUs) / 1_000_000));
    filters.push(`${snapshot.clips.map((_, index) => `[clip${index}]`).join('')}concat=n=${snapshot.clips.length}:v=1:a=0[vconcat]`);
    if (targetDurationSec > visualDurationUs / 1_000_000 + 1e-6) filters.push(`[vconcat]tpad=stop_mode=clone:stop_duration=${(targetDurationSec - visualDurationUs / 1_000_000).toFixed(6)},trim=duration=${targetDurationSec.toFixed(6)},setpts=PTS-STARTPTS[vout]`);
    else filters.push(`[vconcat]trim=duration=${targetDurationSec.toFixed(6)},setpts=PTS-STARTPTS[vout]`);
    if (narrationPath) filters.push(audioFilter(audioInput, targetDurationSec, 'narration'));
    else filters.push(`[${audioInput}:a]aresample=48000,apad,atrim=duration=${targetDurationSec.toFixed(6)},asetpts=PTS-STARTPTS[aout]`);
    report({ phase: 'rendering', completed: 0, total: targetDurationSec, percent: 0, description: audioMode === 'narration' ? '渲染画面与已核验 narration' : '渲染视觉候选与静音占位轨' });
    assertSignal(signal);
    await runFfmpeg([
      ...args,
      '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-t', targetDurationSec.toFixed(6), '-r', '24',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', '-y', videoTemp,
    ], {
      signal,
      onProgressSec: (seconds) => {
        const completed = Math.max(0, Math.min(targetDurationSec, seconds));
        report({ phase: 'rendering', completed, total: targetDurationSec, percent: targetDurationSec > 0 ? completed / targetDurationSec : null, description: 'FFmpeg 实际媒体时间' });
      },
    });
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
    report({ phase: 'verifying', completed: null, total: null, percent: null, description: '校验正式渲染产物' });
    assertSignal(signal);
    const probe = await probeVideoMedia(videoTemp);
    if (
      probe.errorMessage
      || probe.width !== outputSize.width
      || probe.height !== outputSize.height
      || Math.abs(probe.fps - 24) > 0.2
      || probe.durationUs <= 0
      || Math.abs(probe.durationUs / 1_000_000 - targetDurationSec) > 0.12
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
    report({ phase: 'ready', completed: targetDurationSec, total: targetDurationSec, percent: 1, description: '正式渲染完成' });
    return {
      projectId: snapshot.projectId, batchId: snapshot.batchId, batchVersionId: snapshot.batchVersionId,
      planId: snapshot.planId, outputVersionId: snapshot.outputVersionId, planSeq: snapshot.planSeq,
      outputVersionNumber: snapshot.outputVersionNumber, preset: normalizedPreset,
      width: outputSize.width, height: outputSize.height, fps: 24, durationUs: probe.durationUs,
      audioMode, productionReady: audioMode === 'narration',
      subtitleCues: narrationSegments,
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

export { normalizeArrangement as normalizeBatchRenderArrangement };
