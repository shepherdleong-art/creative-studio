import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { defaultTextStyle, splitCoverTitle, timelineGaps } from './domain.ts';
import { calculateOverlapScore } from './overlap.ts';
import { scanFinalEditBgm } from './bgm.ts';
import { parseCoverKey, resolveCoverCandidateFile } from './cover-candidates.ts';
import { materializeVideoFrame } from './video-frame.ts';
import { runFinalEditHeavyJob } from './heavy-job-lock.ts';
import { getFinalEditTtsAdapter } from './adapters/tts-registry.ts';
import { resolveStoragePath, toStorageRelativePath } from './storage-path.ts';
import { buildMixcutContext } from './mixcut-context.ts';
import {
  buildMixcutEditingScriptSnapshot,
  buildMixcutTaskScriptSnapshot,
  type MixcutSourceScript,
  type MixcutTaskScriptSnapshot,
} from './mixcut-script.ts';
import {
  deleteShotSetExternalAsset as deleteImportedShotSetExternalAsset,
  importShotSetExternalAssets as importUploadedShotSetExternalAssets,
  listShotSetExternalAssets as listImportedShotSetExternalAssets,
  MaterialImportError,
  resolveImportedExternalAssetVideoPath,
  resolveShotSetExternalAssetMedia as resolveImportedShotSetExternalAssetMedia,
  type ExternalAssetImportResult,
  type ShotSetExternalAssetImportInput,
} from './material-import.ts';
import { assertTtsSpeed } from './tts-speed.ts';
import { preparePreviewCacheKey } from './prepare-preview.ts';
import {
  FINAL_EDIT_FPS,
  FINAL_EDIT_INTRO_DURATION_US,
  FINAL_EDIT_INTRO_FRAMES,
  OUTPUT_PRESETS,
  type CapacityEstimate,
  type FinalEditAssetView,
  type FinalEditExternalAssetView,
  type FinalEditGroupView,
  type FinalEditIssue,
  type FinalEditVariantView,
  type JobRef,
  type MixcutContextResponse,
  type OutputPresetId,
  type SubtitleCue,
  type TimelineClip,
  type TextStyle,
  type VideoTimeline,
} from './types.ts';

interface ScriptSegment {
  id?: string;
  shotId: string;
  narration: string;
  subtitle: string;
}

type ScriptSnapshot = MixcutTaskScriptSnapshot;

interface VideoAnalysisResult {
  summary: string;
  sellingPoints: string[];
  semanticTags: string[];
  usableRanges: Array<{ startUs: number; endUs: number; qualityScore: number }>;
  qualityIssues: string[];
  coverFrameTimesUs: number[];
}

interface NarrationArtifact {
  relativePath: string;
  durationUs: number;
  segmentTimings: Array<{ segmentId: string; startUs: number; endUs: number }>;
  wordTimings: Array<{ text: string; startUs: number; endUs: number }>;
}

export interface FinalEditWorkspaceDependencies {
  db: Database.Database;
  storageRoot: string;
  runJobsInline?: boolean;
  probeVideo(input: { filePath: string; videoJobId: string }): Promise<{ durationUs: number; width: number; height: number; fps: number }>;
  analyzeVideo(input: { filePath: string; videoJobId: string; shotSetId: string; providerId: string }): Promise<VideoAnalysisResult>;
  materializeCoverFrame?(input: { sourcePath: string; cacheNamespace: string; cacheKey: string; frameUs: number }): Promise<void>;
  synthesize(input: {
    scriptDraftId: string;
    segments: Array<{ segmentId: string; narration: string }>;
    providerId: string;
    voice: string;
    speed: number;
    narrationHash: string;
  }): Promise<NarrationArtifact>;
  warmPreview?(input: {
    jobId: string;
    groupId: string;
    variant: FinalEditVariantView;
    sources: Array<{ videoJobId: string; absolutePath: string }>;
    narrationAbsolutePath: string;
    relativePath: string;
  }): Promise<{ relativePath: string }>;
  estimateAnalysisCost?(input: { providerId: string; requestCount: number }): number;
  validateAnalysisProvider?(providerId: string): boolean;
  validateTtsProvider?(providerId: string): boolean;
}

export interface PreflightInput {
  projectId: string;
  scriptDraftId?: string;
  shotSetId?: string;
  editedNarrationText?: string;
  selectedMaterialKeys?: string[];
  providerId?: string;
  voice?: string;
  speed?: number;
  analysisProviderId?: string;
  count: number;
  outputPreset: OutputPresetId;
}

export interface StartFinalEditInput extends PreflightInput {
  providerId: string;
  voice: string;
  speed: number;
  analysisProviderId?: string;
  draftGroupId?: string;
}

export interface EnsureMixcutDraftInput {
  projectId: string;
  shotSetId: string;
  scriptDraftId?: string;
  editedNarrationText: string;
  selectedMaterialKeys: string[];
  providerId: string;
  voice: string;
  speed: number;
  analysisProviderId?: string;
}

export type FinalEditCommand =
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'delete_clip'; clipId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'move_clip'; clipId: string; timelineInFrame: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'trim_clip'; clipId: string; sourceInFrame: number; sourceOutFrame: number; timelineInFrame: number; timelineOutFrame: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'replace_clip'; clipId: string; videoJobId: string; sourceFingerprint: string; sourceInFrame: number; sourceOutFrame: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'insert_clip'; videoJobId: string; sourceFingerprint: string; sourceInFrame: number; sourceOutFrame: number; timelineInFrame: number; timelineOutFrame: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'swap_clips'; leftClipId: string; rightClipId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'restore_revision'; revision: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_bgm_gain'; gainDb: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_bgm'; trackId: string | null }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_cover'; coverKey: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_cover_framing'; scale: number; offsetX: number; offsetY: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'apply_proposal'; proposalId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'unbind_clip'; clipId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'bind_clip'; clipId: string; segmentId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_framing'; clipId: string; scale: number; offsetX: number; offsetY: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_subtitle_cue_text'; cueId: string; text: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'move_subtitle_cue'; cueId: string; startUs: number; endUs: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'trim_subtitle_cue'; cueId: string; startUs: number; endUs: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'insert_subtitle_cue'; segmentId: string; text: string; startUs: number; endUs: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'split_subtitle_cue'; cueId: string; splitUs: number; leftText: string; rightText: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'delete_subtitle_cue'; cueId: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_cover_title_part_text'; part: 'primary' | 'secondary'; text: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_text_style'; preset: OutputPresetId; target: 'coverPrimary' | 'coverSecondary' | 'subtitle'; style: TextStyle }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'reset_text_style'; preset: OutputPresetId; target: 'coverPrimary' | 'coverSecondary' | 'subtitle' }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'apply_title_preset'; presetId: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_mixcut_script_state'; scriptDraftId?: string; editedNarrationText: string; selectedMaterialKeys: string[]; providerId?: string; analysisProviderId?: string; voice: string; speed: number };

export interface EnqueueRenderInput {
  groupId: string;
  variantId: string;
  expectedGroupRevision: number;
  expectedVariantRevision: number;
  overlayBundleId: string;
}

export interface MutationResult {
  scope: 'group' | 'variant';
  view: FinalEditGroupView | FinalEditVariantView;
}

export interface FinalEditWorkspace {
  preflight(input: PreflightInput): Promise<CapacityEstimate>;
  start(input: StartFinalEditInput): Promise<JobRef>;
  ensureMixcutDraft(input: EnsureMixcutDraftInput): FinalEditGroupView;
  load(groupId: string): FinalEditGroupView;
  apply(command: FinalEditCommand): MutationResult;
  enqueueRender(input: EnqueueRenderInput): Promise<JobRef>;
  // JUDGMENT CALL (new, not covered by JC-1..JC-5): the plan's illustrative
  // signature shows a synchronous MixcutContextResponse return, but JC-2
  // requires per-video probeVideoMedia (ffprobe subprocess) calls to
  // populate videoAssets[] duration/width/height — genuinely async I/O — so
  // this is Promise-returning like the other read/command methods that touch
  // the filesystem or a job pipeline (start/enqueueRender).
  getMixcutContext(projectId: string, requestedShotSetId?: string | null): Promise<MixcutContextResponse>;
  listShotSetExternalAssets(projectId: string, shotSetId: string): FinalEditExternalAssetView[];
  importShotSetExternalAssets(input: ShotSetExternalAssetImportInput): Promise<ExternalAssetImportResult>;
  resolveShotSetExternalAssetMedia(projectId: string, shotSetId: string, assetId: string, kind: 'video' | 'thumbnail'): { relativePath: string; mimeType: string };
  deleteShotSetExternalAsset(input: { projectId: string; shotSetId: string; assetId: string }): { deleted: true };
}

export interface FinalEditWorkspaceRuntime extends FinalEditWorkspace {
  resumePrepareJob(jobId: string): Promise<void>;
}

export class FinalEditError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'FinalEditError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const MIXCUT_PREPARE_PHASE_RANGES = {
  analyzing: [0, 0.3],
  synthesizing: [0.3, 0.55],
  matching: [0.55, 0.8],
  previewing: [0.8, 1],
} as const;

interface AssetRow {
  assetKey?: string;
  source?: 'module4' | 'external';
  videoJobId: string;
  shotSetId: string;
  shotId: string | null;
  filename: string | null;
  localVideoPath: string;
  durationSec: number | null;
}

interface PreparedAsset extends AssetRow {
  durationUs: number;
  fingerprint: string;
  analysis: VideoAnalysisResult;
  autoUseDisabled: boolean;
  existingUsageCount: number;
}

function now() { return new Date().toISOString(); }
function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function sha256(value: string | Buffer) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validateTtsSpeed(speed: number): void {
  try { assertTtsSpeed(speed); }
  catch (error) { throw new FinalEditError('invalid_tts_speed', error instanceof Error ? error.message : '语速无效'); }
}
function resolveTaskScript(db: Database.Database, input: Pick<PreflightInput, 'projectId' | 'scriptDraftId' | 'shotSetId' | 'editedNarrationText'>): ScriptSnapshot {
  const scriptDraftId = String(input.scriptDraftId || '').trim();
  if (!scriptDraftId) {
    try {
      return buildMixcutTaskScriptSnapshot({ shotSetId: String(input.shotSetId || ''), editedNarrationText: String(input.editedNarrationText || '') });
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === 'shot_set_required') throw new FinalEditError('shot_set_required', '手工文案必须明确当前分镜组');
      throw new FinalEditError('narration_text_required', '请输入混剪文案');
    }
  }
  const row = db.prepare(`SELECT projectId, outputJson, createdAt FROM script_drafts WHERE id = ?`).get(scriptDraftId) as { projectId: string; outputJson: string; createdAt: string } | undefined;
  if (!row || row.projectId !== input.projectId) throw new FinalEditError('script_not_found', '脚本不存在或不属于当前项目', 404);
  const source = parseJson<MixcutSourceScript | null>(row.outputJson, null);
  if (!source || source.version !== 2 || !source.shotSetId || !Array.isArray(source.segments) || source.segments.length === 0) {
    throw new FinalEditError('script_invalid_v2', '脚本不是可用的 v2 脚本');
  }
  if (input.shotSetId && source.shotSetId !== input.shotSetId) throw new FinalEditError('script_shot_set_mismatch', '脚本不属于当前分镜组');
  try {
    return buildMixcutTaskScriptSnapshot({
      sourceDraftId: scriptDraftId,
      sourceScriptUpdatedAt: row.createdAt || null,
      sourceScript: source,
      shotSetId: source.shotSetId,
      editedNarrationText: String(input.editedNarrationText == null ? source.segments.map((segment) => segment.narration || segment.subtitle || '').join('\n') : input.editedNarrationText),
    });
  } catch {
    throw new FinalEditError('narration_text_required', '请输入混剪文案');
  }
}

function resolveEditingScript(db: Database.Database, input: Pick<EnsureMixcutDraftInput, 'projectId' | 'scriptDraftId' | 'shotSetId' | 'editedNarrationText'>): ScriptSnapshot {
  const scriptDraftId = String(input.scriptDraftId || '').trim();
  if (!scriptDraftId) return buildMixcutEditingScriptSnapshot({ shotSetId: input.shotSetId, editedNarrationText: input.editedNarrationText });
  const row = db.prepare(`SELECT projectId, outputJson, createdAt FROM script_drafts WHERE id=?`).get(scriptDraftId) as { projectId: string; outputJson: string; createdAt: string } | undefined;
  if (!row || row.projectId !== input.projectId) throw new FinalEditError('script_not_found', '脚本不存在或不属于当前项目', 404);
  const source = parseJson<MixcutSourceScript | null>(row.outputJson, null);
  if (!source || source.version !== 2 || !source.shotSetId || !Array.isArray(source.segments)) throw new FinalEditError('script_invalid_v2', '脚本不是可用的 v2 脚本');
  if (source.shotSetId !== input.shotSetId) throw new FinalEditError('script_shot_set_mismatch', '脚本不属于当前分镜组');
  return buildMixcutEditingScriptSnapshot({ sourceDraftId: scriptDraftId, sourceScriptUpdatedAt: row.createdAt || null, sourceScript: source, shotSetId: input.shotSetId, editedNarrationText: input.editedNarrationText });
}

function assetsForScript(db: Database.Database, storageRoot: string, projectId: string, shotSetId: string): AssetRow[] {
  const rows = db.prepare(`
    SELECT id AS videoJobId, shotSetId, shotId, filename, localVideoPath, durationSec
    FROM video_jobs
    WHERE projectId = ? AND shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
    ORDER BY id
  `).all(projectId, shotSetId) as Array<Omit<AssetRow, 'assetKey' | 'source'>>;
  return rows.filter((row) => {
    try {
      const resolved = resolveStoragePath(storageRoot, row.localVideoPath, { allowAbsolute: true });
      return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    } catch { return false; }
  }).map((row) => ({ ...row, assetKey: `module4:${row.videoJobId}`, source: 'module4' as const }));
}

function selectedAssets(db: Database.Database, storageRoot: string, projectId: string, shotSetId: string, requestedKeys?: string[]): AssetRow[] {
  const module4 = assetsForScript(db, storageRoot, projectId, shotSetId);
  const requested = requestedKeys == null ? module4.map((asset) => asset.assetKey!) : [...new Set(requestedKeys.map(String))];
  if (requested.length === 0) throw new FinalEditError('materials_required', '请至少选择一个可用视频素材');
  const module4ByKey = new Map(module4.map((asset) => [asset.assetKey, asset]));
  return requested.map((assetKey) => {
    const moduleAsset = module4ByKey.get(assetKey);
    if (moduleAsset) return moduleAsset;
    if (assetKey.startsWith('module4:')) throw new FinalEditError('material_not_ready', '所选模块 4 素材不存在、未完成或不属于当前分镜组');
    if (!assetKey.startsWith('external:')) throw new FinalEditError('material_key_invalid', '素材标识格式无效');
    const assetId = assetKey.slice('external:'.length);
    const row = db.prepare(`
      SELECT id, projectId, shotSetId, originalFilename, relativePath, durationUs, status
      FROM final_edit_external_assets WHERE id=?
    `).get(assetId) as { id: string; projectId: string; shotSetId: string; originalFilename: string; relativePath: string; durationUs: number; status: string } | undefined;
    if (!row || row.projectId !== projectId || row.shotSetId !== shotSetId || row.status !== 'ready') {
      throw new FinalEditError('material_not_ready', '所选外部素材不存在、未完成或不属于当前分镜组');
    }
    let absolutePath: string;
    try { absolutePath = resolveImportedExternalAssetVideoPath(storageRoot, { projectId, shotSetId }, row.relativePath); }
    catch { throw new FinalEditError('material_not_ready', '所选外部素材路径无效'); }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) throw new FinalEditError('material_not_ready', '所选外部素材文件缺失');
    return {
      assetKey,
      source: 'external',
      // Keep filesystem/cache namespaces portable to Windows. The canonical
      // selected key remains external:<id>; only this internal media id avoids
      // the colon that Windows filenames reject.
      videoJobId: `external-asset-${assetId}`,
      shotSetId,
      shotId: null,
      filename: row.originalFilename,
      localVideoPath: absolutePath,
      durationSec: Number(row.durationUs || 0) / 1_000_000,
    };
  });
}

function countCoverCandidates(db: Database.Database, projectId: string, shotSetId: string): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT s.latestGeneratedImageId) AS count
    FROM shots s JOIN shot_sets ss ON ss.id = s.shotSetId
    JOIN image_assets ia ON ia.id = s.latestGeneratedImageId
    WHERE ss.projectId = ? AND ss.id = ? AND s.latestGeneratedImageId IS NOT NULL
  `).get(projectId, shotSetId) as { count: number };
  return Number(row?.count || 0);
}

function buildStyles() {
  return Object.fromEntries((Object.keys(OUTPUT_PRESETS) as OutputPresetId[]).map((preset) => {
    const width = OUTPUT_PRESETS[preset].width;
    return [preset, {
      coverPrimary: defaultTextStyle('coverPrimary', width),
      coverSecondary: defaultTextStyle('coverSecondary', width),
      subtitle: defaultTextStyle('subtitle', width),
    }];
  })) as FinalEditGroupView['textStyles'];
}

const DEFAULT_COVER_FRAMING = { scale: 1, offsetX: 0, offsetY: 0 } as const;

function normalizeCover(value: unknown): FinalEditVariantView['cover'] {
  const cover = (value && typeof value === 'object' ? value : {}) as Partial<FinalEditVariantView['cover']>;
  return {
    coverKey: typeof cover.coverKey === 'string' ? cover.coverKey : null,
    kind: cover.kind === 'storyboard_image' || cover.kind === 'video_keyframe' ? cover.kind : null,
    sourceUrl: typeof cover.sourceUrl === 'string' ? cover.sourceUrl : null,
    framing: {
      scale: Number.isFinite(cover.framing?.scale) ? Number(cover.framing?.scale) : DEFAULT_COVER_FRAMING.scale,
      offsetX: Number.isFinite(cover.framing?.offsetX) ? Number(cover.framing?.offsetX) : DEFAULT_COVER_FRAMING.offsetX,
      offsetY: Number.isFinite(cover.framing?.offsetY) ? Number(cover.framing?.offsetY) : DEFAULT_COVER_FRAMING.offsetY,
    },
  };
}

function issueList(timeline: VideoTimeline, coverKey: string | null, narrationReady: boolean): FinalEditIssue[] {
  const issues: FinalEditIssue[] = [];
  for (const gap of timelineGaps(timeline.bodyFrames, timeline.clips)) {
    issues.push({ code: 'timeline_gap', severity: 'blocking', message: `正文 ${gap.startFrame}–${gap.endFrame} 帧缺少画面` });
  }
  const sorted = [...timeline.clips].sort((a, b) => a.timelineInFrame - b.timelineInFrame);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].timelineInFrame < sorted[index - 1].timelineOutFrame) {
      issues.push({ code: 'timeline_overlap', severity: 'blocking', message: '视频片段发生重叠', targetId: sorted[index].id });
    }
  }
  if (!coverKey) issues.push({ code: 'cover_missing', severity: 'blocking', message: '缺少可用的独立封面底图' });
  if (!narrationReady) issues.push({ code: 'alignment_failed', severity: 'blocking', message: '字幕尚未获得可靠的强制对齐结果' });
  for (const clip of timeline.clips) {
    if (clip.timelineOutFrame - clip.timelineInFrame < 12) {
      issues.push({ code: 'clip_too_short', severity: 'warning', message: '片段短于 0.5 秒', targetId: clip.id });
    }
  }
  return issues;
}

export function planTimeline(assets: PreparedAsset[], bodyFrames: number, variantIndex: number, segments: ScriptSegment[], autoUseLimit = 2): VideoTimeline {
  const minimumClipFrames = 24;
  const maximumClipFrames = 84;
  const clips: TimelineClip[] = [];
  const rangeCursor = new Map<string, number>();
  const timelineUseCount = new Map<string, number>();
  let cursor = 0;
  const candidates = assets
    .filter((asset) => !asset.autoUseDisabled && asset.existingUsageCount < autoUseLimit)
    .flatMap((asset) => {
      const mediaEndFrame = Math.floor(asset.durationUs * FINAL_EDIT_FPS / 1_000_000);
      const normalized = asset.analysis.usableRanges
        .map((range) => ({
          startFrame: Math.max(0, Math.ceil(range.startUs * FINAL_EDIT_FPS / 1_000_000)),
          endFrame: Math.min(mediaEndFrame, Math.floor(range.endUs * FINAL_EDIT_FPS / 1_000_000)),
          qualityScore: Math.max(0, Math.min(1, Number(range.qualityScore) || 0)),
        }))
        .filter((range) => range.endFrame - range.startFrame >= minimumClipFrames)
        .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
      const merged: typeof normalized = [];
      for (const range of normalized) {
        const previous = merged.at(-1);
        if (previous && range.startFrame <= previous.endFrame) {
          previous.endFrame = Math.max(previous.endFrame, range.endFrame);
          previous.qualityScore = Math.max(previous.qualityScore, range.qualityScore);
        } else merged.push({ ...range });
      }
      return merged.map((range, rangeIndex) => ({
        asset,
        rangeIndex,
        ...range,
      }));
    });
  const totalAvailableFrames = candidates.reduce((sum, candidate) => sum + candidate.endFrame - candidate.startFrame, 0);
  const safeOffsetPerRange = Math.floor(Math.max(0, totalAvailableFrames - bodyFrames) / Math.max(1, candidates.length));
  while (cursor < bodyFrames && candidates.length > 0) {
    const segmentIndex = Math.min(segments.length - 1, Math.floor(cursor / Math.max(1, bodyFrames / segments.length)));
    const segment = segments[segmentIndex];
    const ranked = candidates
      .map((candidate, index) => {
        const key = `${candidate.asset.videoJobId}:${candidate.rangeIndex}`;
        const rotatedStart = candidate.startFrame + (safeOffsetPerRange > 0 ? (variantIndex * 12) % (safeOffsetPerRange + 1) : 0);
        const rangeStart = rangeCursor.get(key) ?? rotatedStart;
        const available = candidate.endFrame - rangeStart;
        const directReference = Boolean(segment?.shotId && candidate.asset.shotId === segment.shotId);
        const repeated = timelineUseCount.get(candidate.asset.videoJobId) || 0;
        const rotation = ((index - variantIndex) % candidates.length + candidates.length) % candidates.length;
        const score = (directReference ? 10 : 0) + candidate.qualityScore * 3 - repeated * 12 - candidate.asset.existingUsageCount - rotation / Math.max(1, candidates.length);
        return { ...candidate, key, rangeStart, available, score };
      })
      .filter((candidate) => candidate.available >= minimumClipFrames)
      .sort((left, right) => right.score - left.score);
    const remainingSegment = Math.max(12, Math.ceil((segmentIndex + 1) * bodyFrames / Math.max(1, segments.length)) - cursor);
    const remainingBody = bodyFrames - cursor;
    let selected: (typeof ranked)[number] | null = null;
    let length = 0;
    for (const candidate of ranked) {
      const segmentTarget = remainingSegment >= minimumClipFrames && remainingSegment <= maximumClipFrames ? remainingSegment : maximumClipFrames;
      let candidateLength = Math.min(segmentTarget, candidate.available, remainingBody);
      const tail = remainingBody - candidateLength;
      if (tail > 0 && tail < minimumClipFrames) candidateLength -= minimumClipFrames - tail;
      if (candidateLength < minimumClipFrames) continue;
      selected = candidate;
      length = candidateLength;
      break;
    }
    const candidate = selected;
    if (!candidate) break;
    clips.push({
      id: uuidv4(),
      videoJobId: candidate.asset.videoJobId,
      sourceFingerprint: candidate.asset.fingerprint,
      sourceInFrame: candidate.rangeStart,
      sourceOutFrame: candidate.rangeStart + length,
      timelineInFrame: cursor,
      timelineOutFrame: cursor + length,
      boundSegmentId: segment?.id || null,
      framing: { scale: 1, offsetX: 0, offsetY: 0 },
      manualUseOverride: false,
    });
    rangeCursor.set(candidate.key, candidate.rangeStart + length);
    timelineUseCount.set(candidate.asset.videoJobId, (timelineUseCount.get(candidate.asset.videoJobId) || 0) + 1);
    cursor += length;
  }
  return { fps: FINAL_EDIT_FPS, introFrames: FINAL_EDIT_INTRO_FRAMES, bodyFrames, clips };
}

function contentChars(value: string): string[] {
  return Array.from(value.normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase());
}

function lcsLength(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0) as number[];
  for (const value of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index += 1) {
      const before = previous[index];
      previous[index] = value === right[index - 1] ? diagonal + 1 : Math.max(previous[index], previous[index - 1]);
      diagonal = before;
    }
  }
  return previous[right.length];
}

export function validateNarrationAlignment(narration: NarrationArtifact, sourceText: string): void {
  if (!narration.wordTimings.length) throw new FinalEditError('alignment_failed', '强制对齐没有返回词级时间');
  let previousEndUs = 0;
  for (const word of narration.wordTimings) {
    if (!word.text.trim() || word.startUs < previousEndUs || word.endUs <= word.startUs || word.endUs > narration.durationUs) {
      throw new FinalEditError('alignment_failed', '强制对齐时间倒退、越界或包含空词');
    }
    previousEndUs = word.endUs;
  }
  const expected = contentChars(sourceText);
  const actual = contentChars(narration.wordTimings.map((word) => word.text).join(''));
  if (lcsLength(expected, actual) / Math.max(1, expected.length) < 0.95) {
    throw new FinalEditError('alignment_failed', '强制对齐文本覆盖率低于 95%');
  }
}

function splitSubtitleText(text: string, maxChars = 16): string[] {
  const pieces = text.replace(/[\r\n]+/g, '').split(/(?<=[，。！？；,.!?;])/u).filter(Boolean);
  const result: string[] = [];
  for (const piece of pieces.length ? pieces : [text]) {
    const chars = Array.from(piece);
    while (chars.length > maxChars) result.push(chars.splice(0, maxChars).join(''));
    if (chars.length) result.push(chars.join(''));
  }
  return result.filter((piece) => piece.trim());
}

export function buildAlignedSubtitleCues(script: ScriptSnapshot, narration: NarrationArtifact): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (let index = 0; index < script.segments.length; index += 1) {
    const segment = script.segments[index];
    const segmentId = segment.id || `segment-${index + 1}`;
    const timing = narration.segmentTimings.find((item) => item.segmentId === segmentId);
    if (!timing || timing.startUs < 0 || timing.endUs > narration.durationUs || timing.endUs <= timing.startUs) {
      throw new FinalEditError('alignment_failed', `缺少 ${segmentId} 的可靠时间范围`);
    }
    const parts = splitSubtitleText(segment.subtitle || segment.narration);
    const weights = parts.map((part) => Math.max(1, contentChars(part).length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let cursor = timing.startUs;
    parts.forEach((text, partIndex) => {
      const endUs = partIndex === parts.length - 1
        ? timing.endUs
        : Math.round(cursor + (timing.endUs - timing.startUs) * weights[partIndex] / totalWeight);
      cues.push({ id: uuidv4(), segmentId, text, startUs: cursor, endUs, textSource: 'script', timingSource: 'aligned' });
      cursor = endUs;
    });
  }
  return cues;
}

function overlapInput(variant: FinalEditVariantView) {
  const files: Record<string, number> = {};
  const sequence: string[] = [];
  for (const clip of variant.timeline.clips) {
    const duration = (clip.timelineOutFrame - clip.timelineInFrame) / FINAL_EDIT_FPS;
    files[clip.sourceFingerprint] = (files[clip.sourceFingerprint] || 0) + duration;
    if (sequence.at(-1) !== clip.sourceFingerprint) sequence.push(clip.sourceFingerprint);
  }
  return { files, sequence, bgmKey: variant.bgm.trackId, coverKey: variant.cover.coverKey };
}

export function createFinalEditWorkspace(deps: FinalEditWorkspaceDependencies): FinalEditWorkspaceRuntime {
  const { db, storageRoot } = deps;
  const materialDeps = {
    db,
    storageRoot,
    probeVideo: deps.probeVideo,
    materializeThumbnail: (input: { sourcePath: string; cacheNamespace: string; cacheKey: string; frameUs: number }) => materializeVideoFrame({ storageRoot, ...input }),
  };
  const translateMaterialError = (error: unknown): never => {
    if (error instanceof MaterialImportError) throw new FinalEditError(error.code, error.message, error.status, error.details);
    throw error;
  };

  const preflight = async (input: PreflightInput): Promise<CapacityEstimate> => {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) throw new FinalEditError('invalid_count', '生成数量必须是 1～5');
    if (!(input.outputPreset in OUTPUT_PRESETS)) throw new FinalEditError('invalid_output_preset', '不支持的输出比例');
    if (input.selectedMaterialKeys !== undefined && !Array.isArray(input.selectedMaterialKeys)) throw new FinalEditError('material_key_invalid', '素材选择必须是数组');
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(input.projectId);
    if (!project) throw new FinalEditError('project_not_found', '项目不存在', 404);
    const script = resolveTaskScript(db, input);
    const assets = selectedAssets(db, storageRoot, input.projectId, script.shotSetId, input.selectedMaterialKeys);
    if (assets.length === 0) throw new FinalEditError('no_succeeded_videos', '当前脚本分镜组没有可读取的成功视频');
    const totalSec = assets.reduce((sum, asset) => sum + Math.max(0, Number(asset.durationSec || 0)) * 0.7, 0);
    const estimatedCompleteCount = Math.min(input.count, Math.floor(totalSec / Math.max(1, script.targetDurationSec)));
    const coverCandidateCount = countCoverCandidates(db, input.projectId, script.shotSetId);
    const warnings: string[] = [];
    if (estimatedCompleteCount < input.count) warnings.push(`预计只有 ${estimatedCompleteCount} 条可完整覆盖，其余草稿会保留缺口`);
    if (coverCandidateCount < input.count) warnings.push('独特封面底图不足，重复封面将阻止导出');
    let estimatedCost: number | null = null;
    if (input.providerId) {
      if (!input.voice?.trim()) throw new FinalEditError('tts_selection_required', '必须明确选择音色');
      validateTtsSpeed(Number(input.speed));
      const provider = db.prepare(`SELECT costPerThousandCharacters FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(input.providerId) as { costPerThousandCharacters: number } | undefined;
      if (!provider) throw new FinalEditError('tts_provider_unavailable', '口播配音供应商不存在或未启用');
      if (deps.validateTtsProvider && !deps.validateTtsProvider(input.providerId)) throw new FinalEditError('tts_provider_unconfigured', '口播配音供应商尚未配置 API Key');
      const ttsCost = getFinalEditTtsAdapter(input.providerId).estimateCost({ text: script.segments.map((segment) => segment.narration).join(''), costPerThousandCharacters: provider.costPerThousandCharacters });
      if (input.analysisProviderId && deps.validateAnalysisProvider && !deps.validateAnalysisProvider(input.analysisProviderId)) {
        throw new FinalEditError('analysis_provider_unavailable', '视觉分析供应商不存在、未配置或不支持图片理解');
      }
      const analysisCost = input.analysisProviderId && deps.estimateAnalysisCost ? deps.estimateAnalysisCost({ providerId: input.analysisProviderId, requestCount: assets.length }) : 0;
      estimatedCost = Number((ttsCost + analysisCost).toFixed(6));
    }
    return { assetCount: assets.length, videoJobIds: assets.map((asset) => asset.videoJobId), coverCandidateCount, requestedCount: input.count, estimatedCompleteCount, estimatedCost, costCurrency: 'CNY', warnings };
  };

  const load = (groupId: string): FinalEditGroupView => {
    const group = db.prepare(`SELECT * FROM final_edit_groups WHERE id = ?`).get(groupId) as Record<string, unknown> | undefined;
    if (!group) throw new FinalEditError('group_not_found', '成片组不存在', 404);
    const variants = (db.prepare(`SELECT * FROM final_edit_variants WHERE groupId = ? ORDER BY indexNum`).all(groupId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      indexNum: Number(row.indexNum),
      outputPreset: String(row.outputPreset) as OutputPresetId,
      timeline: parseJson<VideoTimeline>(String(row.timelineJson), { fps: 24, introFrames: 20, bodyFrames: 0, clips: [] }),
      bgm: parseJson(String(row.bgmJson), { trackId: null, gainDb: -16, loop: true, fadeOutSec: 0.8 }),
      cover: normalizeCover(parseJson(String(row.coverJson), {})),
      issues: parseJson<FinalEditIssue[]>(String(row.issuesJson), []),
      maxOverlap: Number(parseJson<{ maxScore?: number }>(String(row.overlapJson), {}).maxScore || 0),
      revision: Number(row.revision),
      lastRenderedRevision: row.lastRenderedRevision == null ? null : Number(row.lastRenderedRevision),
      renderStatus: (db.prepare(`SELECT status FROM final_edit_jobs WHERE variantId = ? AND kind = 'render' ORDER BY createdAt DESC LIMIT 1`).get(String(row.id)) as { status: string } | undefined)?.status || null,
      previewUrl: row.previewRelativePath
        ? `/api/videos/${String(row.previewRelativePath).split(/[\\/]+/).map(encodeURIComponent).join('/')}`
        : null,
    } satisfies FinalEditVariantView));
    const script = parseJson<ScriptSnapshot>(String(group.scriptSnapshotJson), {} as ScriptSnapshot);
    const selectedKeys = parseJson<unknown[]>(String(group.selectedMaterialKeysJson || '[]'), []).map(String);
    const selectedKeySet = new Set(selectedKeys);
    const module4Assets = assetsForScript(db, storageRoot, String(group.projectId), String(group.shotSetId))
      .filter((asset) => selectedKeySet.size === 0 || selectedKeySet.has(asset.assetKey!));
    const externalAssets = selectedKeys.filter((key) => key.startsWith('external:')).flatMap((assetKey) => {
      const id = assetKey.slice('external:'.length);
      const row = db.prepare(`SELECT id, shotSetId, originalFilename, relativePath, durationUs FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=?`).get(id, String(group.projectId), String(group.shotSetId)) as { id: string; shotSetId: string; originalFilename: string; relativePath: string; durationUs: number } | undefined;
      if (!row) return [];
      try {
        const absolutePath = resolveImportedExternalAssetVideoPath(storageRoot, { projectId: String(group.projectId), shotSetId: String(group.shotSetId) }, row.relativePath);
        return [{ assetKey, source: 'external' as const, videoJobId: `external-asset-${id}`, shotSetId: row.shotSetId, shotId: null, filename: row.originalFilename, localVideoPath: absolutePath, durationSec: row.durationUs / 1_000_000 }];
      } catch { return []; }
    });
    const assets = [...module4Assets, ...externalAssets].map((asset) => {
      const analysis = db.prepare(`SELECT * FROM final_edit_asset_analysis WHERE videoJobId = ?`).get(asset.videoJobId) as Record<string, unknown> | undefined;
      const generated = analysis ? parseJson<VideoAnalysisResult>(String(analysis.generatedJson), {} as VideoAnalysisResult) : null;
      const manual = analysis ? parseJson<Partial<VideoAnalysisResult>>(String(analysis.manualOverrideJson), {}) : {};
      const effective = generated ? { ...generated, ...manual } : null;
      const fingerprint = analysis ? String(analysis.fileFingerprint) : '';
      const usage = db.prepare(`SELECT COUNT(*) AS count FROM final_edit_usage WHERE assetKind = 'video' AND assetKey = ?`).get(fingerprint) as { count: number };
      const externalId = asset.source === 'external' ? asset.assetKey!.slice('external:'.length) : null;
      const relative = asset.source === 'external' ? '' : path.relative(storageRoot, asset.localVideoPath).split(path.sep).map(encodeURIComponent).join('/');
      return {
        assetKey: asset.assetKey,
        source: asset.source,
        videoJobId: asset.videoJobId,
        shotSetId: asset.shotSetId,
        shotId: asset.shotId,
        filename: asset.filename || asset.videoJobId,
        previewUrl: externalId
          ? `/api/projects/${String(group.projectId)}/final-edit/shot-sets/${String(group.shotSetId)}/external-assets/${externalId}/media`
          : `/api/videos/${relative}`,
        thumbnailUrl: externalId
          ? `/api/projects/${String(group.projectId)}/final-edit/shot-sets/${String(group.shotSetId)}/external-assets/${externalId}/thumbnail`
          : `/api/final-edit-groups/${groupId}/assets/${asset.videoJobId}/thumbnail`,
        durationUs: Number(parseJson<{ durationUs?: number }>(String(analysis?.mediaJson || '{}'), {}).durationUs || Number(asset.durationSec || 0) * 1_000_000),
        fingerprint,
        analysisStatus: (analysis?.status || 'pending') as FinalEditAssetView['analysisStatus'],
        summary: effective?.summary || '',
        autoUseDisabled: Boolean(analysis?.autoUseDisabled),
        usageCount: Number(usage?.count || 0),
      } satisfies FinalEditAssetView;
    });
    const jobs = db.prepare(`SELECT id, variantId, kind, status, phase, progress, estimatedCost, costCurrency, errorCode, errorMessage, startedAt, finishedAt, createdAt FROM final_edit_jobs WHERE groupId = ? ORDER BY createdAt DESC`).all(groupId) as FinalEditGroupView['jobs'];
    const bgmTracks = db.prepare(`SELECT id, relativePath, durationUs FROM final_edit_bgm_tracks WHERE status='ready' ORDER BY relativePath`).all() as FinalEditGroupView['bgmTracks'];
    const imageCoverCandidates = db.prepare(`SELECT ia.id FROM shots s JOIN image_assets ia ON ia.id=s.latestGeneratedImageId WHERE s.shotSetId=? AND s.latestGeneratedImageId IS NOT NULL ORDER BY s.indexNum`).all(String(group.shotSetId)) as Array<{ id: string }>;
    const videoCoverCandidates = (db.prepare(`
      SELECT vj.id AS videoJobId, a.generatedJson
      FROM video_jobs vj
      JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id
      WHERE vj.projectId=? AND vj.shotSetId=? AND vj.status='succeeded' AND a.status='succeeded'
      ORDER BY vj.id
    `).all(String(group.projectId), String(group.shotSetId)) as Array<{ videoJobId: string; generatedJson: string }>).flatMap((row) => {
      const generated = parseJson<{ coverFrameTimesUs?: unknown[] }>(row.generatedJson, {});
      return (generated.coverFrameTimesUs || [])
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .slice(0, 3)
        .map((frameUs) => ({ videoJobId: row.videoJobId, frameUs }));
    });
    return {
      id: String(group.id), projectId: String(group.projectId), scriptDraftId: String(group.scriptDraftId), shotSetId: String(group.shotSetId),
      status: String(group.status), phase: String(group.phase), revision: Number(group.revision),
      script: {
        sourceDraftId: String(group.scriptDraftId || '') || null,
        title: script.title || '',
        importedNarrationText: script.sourceNarrationText || '',
        editedNarrationText: String(group.editedNarrationText || script.editedNarrationText || script.fullScript || ''),
        syncState: group.scriptSyncState === 'modified' ? 'modified' : 'synced',
        sourceScriptUpdatedAt: group.sourceScriptUpdatedAt == null ? null : String(group.sourceScriptUpdatedAt),
        narrationConfig: (() => {
          const config = parseJson<{ providerId?: unknown; voice?: unknown; speed?: unknown }>(String(group.narrationConfigJson), {});
          return { providerId: String(config.providerId || ''), voice: String(config.voice || ''), speed: Number(config.speed || 1) };
        })(),
        selectedMaterialKeys: selectedKeys,
      },
      narrationDurationUs: Number(group.narrationDurationUs),
      totalDurationUs: FINAL_EDIT_INTRO_DURATION_US + Number(group.narrationDurationUs),
      coverTitle: parseJson(String(group.coverTitleJson), { primary: { id: 'primary', text: script.title, textSource: 'script' }, secondary: { id: 'secondary', text: '', textSource: 'script' } }),
      subtitleCues: parseJson<SubtitleCue[]>(String(group.subtitleStateJson), []),
      textStyles: parseJson(String(group.textStylesJson), buildStyles()),
      variants, assets, bgmTracks,
      coverCandidates: [
        ...imageCoverCandidates.map((candidate) => ({ kind: 'storyboard_image' as const, coverKey: `image:${candidate.id}`, sourceUrl: `/api/final-edit-groups/${String(group.id)}/cover-candidates/${encodeURIComponent(`image:${candidate.id}`)}` })),
        ...videoCoverCandidates.map((candidate) => {
          const coverKey = `video:${candidate.videoJobId}:${candidate.frameUs}`;
          return { kind: 'video_keyframe' as const, coverKey, sourceUrl: `/api/final-edit-groups/${String(group.id)}/cover-candidates/${encodeURIComponent(coverKey)}` };
        }),
      ],
      jobs,
    };
  };

  const ensureMixcutDraft = (input: EnsureMixcutDraftInput): FinalEditGroupView => {
    const ownership = db.prepare(`SELECT 1 FROM shot_sets WHERE id=? AND projectId=?`).get(input.shotSetId, input.projectId);
    if (!ownership) throw new FinalEditError('shot_set_not_found', '分镜组不存在或不属于当前项目', 404);
    if (!input.providerId.trim() || !input.voice.trim()) throw new FinalEditError('tts_selection_required', '必须明确选择口播配音供应商和音色');
    validateTtsSpeed(input.speed);
    const provider = db.prepare(`SELECT 1 FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(input.providerId);
    if (!provider) throw new FinalEditError('tts_provider_unavailable', '口播配音供应商不存在或未启用');
    const script = resolveEditingScript(db, input);
    const selectedMaterialKeys = input.selectedMaterialKeys.length
      ? selectedAssets(db, storageRoot, input.projectId, input.shotSetId, input.selectedMaterialKeys).map((asset) => asset.assetKey!)
      : [];
    const groupId = uuidv4();
    const titleParts = script.coverTitleParts || splitCoverTitle(script.title);
    const createdAt = now();
    const narrationHash = sha256(JSON.stringify({ kind: 'editing-draft', groupId }));
    db.prepare(`INSERT INTO final_edit_groups (id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash, analysisProviderId, narrationConfigJson, coverTitleJson, textStylesJson, editedNarrationText, scriptSyncState, sourceScriptUpdatedAt, selectedMaterialKeysJson, status, phase, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'editing', 'editing', 0, ?, ?)`).run(groupId, input.projectId, script.sourceDraftId || '', input.shotSetId, JSON.stringify(script), narrationHash, input.analysisProviderId || '', JSON.stringify({ providerId: input.providerId, voice: input.voice, speed: input.speed }), JSON.stringify({ primary: { id: 'primary', text: titleParts.primary, textSource: 'script' }, secondary: { id: 'secondary', text: titleParts.secondary, textSource: 'script' } }), JSON.stringify(buildStyles()), script.editedNarrationText, script.scriptSyncState, script.sourceScriptUpdatedAt, JSON.stringify(selectedMaterialKeys), createdAt, createdAt);
    return load(groupId);
  };

  const refreshOverlap = (groupId: string) => {
    const view = load(groupId);
    const coverCounts = new Map<string, number>();
    for (const variant of view.variants) if (variant.cover.coverKey) coverCounts.set(variant.cover.coverKey, (coverCounts.get(variant.cover.coverKey) || 0) + 1);
    for (const variant of view.variants) {
      let maxScore = 0;
      for (const other of view.variants) {
        if (variant.id === other.id) continue;
        maxScore = Math.max(maxScore, calculateOverlapScore(overlapInput(variant), overlapInput(other)).score);
      }
      const issues = variant.issues.filter((issue) => issue.code !== 'high_overlap' && issue.code !== 'duplicate_cover');
      if (maxScore >= 0.7) issues.push({ code: 'high_overlap', severity: 'warning', message: `与同组成片的最高重合度为 ${Math.round(maxScore * 100)}%` });
      if (variant.cover.coverKey && (coverCounts.get(variant.cover.coverKey) || 0) > 1) issues.push({ code: 'duplicate_cover', severity: 'blocking', message: '同组成片必须使用不同的封面底图' });
      db.prepare(`UPDATE final_edit_variants SET overlapJson=?, issuesJson=? WHERE id=?`).run(JSON.stringify({ maxScore }), JSON.stringify(issues), variant.id);
    }
  };

  const prepare = async (jobId: string, groupId: string, input: StartFinalEditInput, script: ScriptSnapshot): Promise<void> => {
    const phaseRank = (phase: string) => ['analyzing', 'synthesizing', 'matching', 'previewing'].indexOf(phase);
    const updateJob = (phase: string, progress: number) => {
      const current = db.prepare(`SELECT phase, progress FROM final_edit_jobs WHERE id=? AND status='running'`).get(jobId) as { phase: string; progress: number } | undefined;
      if (!current) return;
      if (progress < current.progress || (progress === current.progress && phaseRank(phase) < phaseRank(current.phase))) return;
      db.transaction(() => {
        db.prepare(`UPDATE final_edit_jobs SET phase=?, progress=? WHERE id=? AND status='running'`).run(phase, progress, jobId);
        db.prepare(`UPDATE final_edit_groups SET phase=?, updatedAt=? WHERE id=?`).run(phase, now(), groupId);
      })();
    };
    try {
      updateJob('analyzing', 0);
      const rows = selectedAssets(db, storageRoot, input.projectId, script.shotSetId, input.selectedMaterialKeys);
      const prepared: PreparedAsset[] = [];
      for (const row of rows) {
        const fingerprint = sha256(fs.readFileSync(row.localVideoPath));
        const media = await deps.probeVideo({ filePath: row.localVideoPath, videoJobId: row.videoJobId });
        let analysis: VideoAnalysisResult;
        const analysisProviderId = input.analysisProviderId || '';
        let analysisModel = '';
        try { analysisModel = String((db.prepare(`SELECT COALESCE(NULLIF(model, ''), defaultModel, '') AS model FROM script_providers WHERE id=?`).get(analysisProviderId) as { model?: string } | undefined)?.model || ''); } catch { /* isolated domain tests omit provider tables */ }
        const cached = db.prepare(`SELECT fileFingerprint, providerId, model, status, mediaJson, generatedJson FROM final_edit_asset_analysis WHERE videoJobId=?`).get(row.videoJobId) as { fileFingerprint: string; providerId: string; model: string; status: string; mediaJson: string; generatedJson: string } | undefined;
        try {
          analysis = cached?.fileFingerprint === fingerprint && cached.providerId === analysisProviderId && cached.model === analysisModel && cached.status === 'succeeded'
            ? parseJson<VideoAnalysisResult>(cached.generatedJson, {} as VideoAnalysisResult)
            : await deps.analyzeVideo({ filePath: row.localVideoPath, videoJobId: row.videoJobId, shotSetId: row.shotSetId, providerId: analysisProviderId });
          db.prepare(`
            INSERT INTO final_edit_asset_analysis
              (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, updatedAt, analyzedAt)
            VALUES (?, ?, ?, ?, ?, '1', 'succeeded', ?, ?, ?, ?)
            ON CONFLICT(videoJobId) DO UPDATE SET shotSetId=excluded.shotSetId, fileFingerprint=excluded.fileFingerprint,
              providerId=excluded.providerId, model=excluded.model, status='succeeded', mediaJson=excluded.mediaJson, generatedJson=excluded.generatedJson,
              errorCode=NULL, errorMessage=NULL, analyzedAt=excluded.analyzedAt, updatedAt=excluded.updatedAt
          `).run(row.videoJobId, row.shotSetId, fingerprint, analysisProviderId, analysisModel, JSON.stringify(media), JSON.stringify(analysis), now(), now());
          for (const frameUs of (analysis.coverFrameTimesUs || []).slice(0, 3)) {
            const lastSafeFrameUs = Math.max(0, media.durationUs - Math.max(50_000, Math.ceil(1_000_000 / Math.max(1, media.fps))));
            const safeFrameUs = Math.max(0, Math.min(lastSafeFrameUs, frameUs));
            const frameInput = { sourcePath: row.localVideoPath, cacheNamespace: path.join('covers', groupId), cacheKey: `video:${row.videoJobId}:${safeFrameUs}:${fingerprint}`, frameUs: safeFrameUs };
            try {
              if (deps.materializeCoverFrame) await deps.materializeCoverFrame(frameInput);
              else await materializeVideoFrame({ storageRoot, ...frameInput });
            } catch { /* 封面候选抽帧失败不应淘汰已经成功分析的完整视频。 */ }
          }
        } catch (error) {
          analysis = { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [], qualityIssues: ['analysis_failed'], coverFrameTimesUs: [] };
          db.prepare(`
            INSERT INTO final_edit_asset_analysis
              (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, errorCode, errorMessage, updatedAt)
            VALUES (?, ?, ?, ?, ?, '1', 'failed', ?, '{}', 'analysis_failed', ?, ?)
            ON CONFLICT(videoJobId) DO UPDATE SET providerId=excluded.providerId, model=excluded.model, status='failed', mediaJson=excluded.mediaJson, errorCode='analysis_failed', errorMessage=excluded.errorMessage, updatedAt=excluded.updatedAt
          `).run(row.videoJobId, row.shotSetId, fingerprint, analysisProviderId, analysisModel, JSON.stringify(media), error instanceof Error ? error.message : String(error), now());
        }
        const analysisState = db.prepare(`SELECT manualOverrideJson, autoUseDisabled FROM final_edit_asset_analysis WHERE videoJobId=?`).get(row.videoJobId) as { manualOverrideJson: string; autoUseDisabled: number } | undefined;
        const manual = parseJson<Partial<VideoAnalysisResult>>(analysisState?.manualOverrideJson || '{}', {});
        const usage = db.prepare(`SELECT COUNT(*) AS count FROM final_edit_usage WHERE projectId=? AND shotSetId=? AND assetKind='video' AND assetKey=?`).get(input.projectId, script.shotSetId, fingerprint) as { count: number };
        prepared.push({
          ...row,
          ...media,
          fingerprint,
          analysis: { ...analysis, ...manual },
          autoUseDisabled: Boolean(analysisState?.autoUseDisabled),
          existingUsageCount: Number(usage?.count || 0),
        });
        updateJob('analyzing', prepared.length / Math.max(1, rows.length) * 0.3);
      }
      if (prepared.length === 0) throw new FinalEditError('no_succeeded_videos', '没有可读取的视频素材');

      updateJob('synthesizing', 0.3);
      const narrationHash = String((db.prepare(`SELECT narrationHash FROM final_edit_groups WHERE id = ?`).get(groupId) as { narrationHash: string }).narrationHash);
      const normalizedSegments = script.segments.map((segment, index) => ({ segmentId: segment.id || `segment-${index + 1}`, narration: segment.narration }));
      const existingNarration = db.prepare(`SELECT narrationAudioPath, narrationDurationUs, wordTimingsJson, subtitleStateJson FROM final_edit_groups WHERE id=?`).get(groupId) as { narrationAudioPath: string | null; narrationDurationUs: number; wordTimingsJson: string; subtitleStateJson: string };
      const existingCues = parseJson<SubtitleCue[]>(existingNarration.subtitleStateJson, []);
      const reusingNarration = Boolean(existingNarration.narrationAudioPath && existingNarration.narrationDurationUs > 0 && parseJson<unknown[]>(existingNarration.wordTimingsJson, []).length > 0);
      const narration = reusingNarration
        ? {
            relativePath: existingNarration.narrationAudioPath!,
            durationUs: existingNarration.narrationDurationUs,
            wordTimings: parseJson<Array<{ text: string; startUs: number; endUs: number }>>(existingNarration.wordTimingsJson, []),
            segmentTimings: normalizedSegments.map((segment) => {
              const matching = existingCues.filter((cue) => cue.segmentId === segment.segmentId);
              return { segmentId: segment.segmentId, startUs: Math.min(...matching.map((cue) => cue.startUs)), endUs: Math.max(...matching.map((cue) => cue.endUs)) };
            }),
          }
        : await deps.synthesize({ scriptDraftId: String(input.scriptDraftId || ''), segments: normalizedSegments, providerId: input.providerId, voice: input.voice, speed: input.speed, narrationHash });
      validateNarrationAlignment(narration, script.segments.map((segment) => segment.narration).join(''));

      updateJob('synthesizing', 0.55);
      updateJob('matching', 0.55);
      const bodyFrames = Math.ceil(narration.durationUs * FINAL_EDIT_FPS / 1_000_000);
      const cues = reusingNarration ? existingCues : buildAlignedSubtitleCues(script, narration);
      const covers = db.prepare(`
        SELECT s.latestGeneratedImageId AS imageAssetId, ia.path
        FROM shots s JOIN image_assets ia ON ia.id = s.latestGeneratedImageId
        WHERE s.shotSetId = ? AND s.latestGeneratedImageId IS NOT NULL
        ORDER BY s.indexNum
      `).all(script.shotSetId) as Array<{ imageAssetId: string; path: string }>;
      const bgmTracks = await scanFinalEditBgm(db, storageRoot);
      const settings = db.prepare(`SELECT autoUseLimit FROM final_edit_project_settings WHERE projectId=?`).get(input.projectId) as { autoUseLimit: number } | undefined;
      const autoUseLimit = Math.max(1, Math.min(10, Number(settings?.autoUseLimit || 2)));
      const variants: FinalEditVariantView[] = [];
      const nextIndex = Number((db.prepare(`SELECT COALESCE(MAX(indexNum), 0) AS value FROM final_edit_variants WHERE groupId=?`).get(groupId) as { value: number }).value) + 1;
      for (let index = 0; index < input.count; index += 1) {
        const variantIndex = nextIndex + index;
        const timeline = planTimeline(prepared, bodyFrames, variantIndex - 1, script.segments.map((segment, i) => ({ ...segment, id: segment.id || `segment-${i + 1}` })), autoUseLimit);
        const cover = covers[variantIndex - 1]
          ? { coverKey: `image:${covers[variantIndex - 1].imageAssetId}`, kind: 'storyboard_image' as const, sourceUrl: `/api/final-edit-groups/${groupId}/cover-candidates/${encodeURIComponent(`image:${covers[variantIndex - 1].imageAssetId}`)}`, framing: { ...DEFAULT_COVER_FRAMING } }
          : { coverKey: null, kind: null, sourceUrl: null, framing: { ...DEFAULT_COVER_FRAMING } };
        const issues = issueList(timeline, cover.coverKey, true);
        const variantId = `prepare-${sha256(`${jobId}:${variantIndex}`).slice(0, 32)}`;
        variants.push({ id: variantId, indexNum: variantIndex, outputPreset: input.outputPreset, timeline, bgm: { trackId: bgmTracks.length ? bgmTracks[(variantIndex - 1) % bgmTracks.length].id : null, gainDb: -16, loop: true, fadeOutSec: 0.8 }, cover, issues, maxOverlap: 0, revision: 0, lastRenderedRevision: null, renderStatus: null, previewUrl: null });
        updateJob('matching', 0.55 + ((index + 1) / input.count) * 0.25);
      }
      updateJob('previewing', 0.8);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const previewPaths = new Map<string, string>();
      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index];
        if (deps.warmPreview) {
          const usedVideoJobIds = new Set(variant.timeline.clips.map((clip) => clip.videoJobId));
          const previewCacheKey = preparePreviewCacheKey({
            timeline: variant.timeline,
            sources: prepared
              .filter((asset) => usedVideoJobIds.has(asset.videoJobId))
              .map((asset) => ({ videoJobId: asset.videoJobId, fingerprint: asset.fingerprint })),
            narration: { hash: narrationHash, relativePath: narration.relativePath, durationUs: narration.durationUs },
            outputPreset: variant.outputPreset,
          });
          const relativePath = path.join('final-edits', 'previews', 'prepare', jobId, `${previewCacheKey}.mp4`);
          const warmed = await deps.warmPreview({
            jobId, groupId, variant,
            sources: prepared.map((asset) => ({ videoJobId: asset.videoJobId, absolutePath: asset.localVideoPath })),
            narrationAbsolutePath: resolveStoragePath(storageRoot, narration.relativePath),
            relativePath,
          });
          previewPaths.set(variant.id, warmed.relativePath);
        }
        updateJob('previewing', 0.8 + ((index + 1) / variants.length) * 0.19);
      }
      const transaction = db.transaction(() => {
        db.prepare(`UPDATE final_edit_groups SET narrationAudioPath=?, narrationDurationUs=?, wordTimingsJson=?, subtitleStateJson=?, status=?, phase='ready', revision=revision+1, updatedAt=? WHERE id=?`).run(narration.relativePath, narration.durationUs, JSON.stringify(narration.wordTimings), JSON.stringify(cues), variants.some((variant) => variant.issues.some((issue) => issue.severity === 'blocking')) ? 'partial' : 'ready', now(), groupId);
        for (let index = 0; index < variants.length; index += 1) {
          const variant = variants[index];
          db.prepare(`INSERT INTO final_edit_variants (id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, issuesJson, overlapJson, revision, previewRelativePath, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, ?, ?, ?)`).run(variant.id, groupId, variant.indexNum, variant.outputPreset, JSON.stringify(variant.timeline), JSON.stringify(variant.bgm), JSON.stringify(variant.cover), JSON.stringify(variant.issues), previewPaths.get(variant.id) || null, now(), now());
          db.prepare(`INSERT OR IGNORE INTO final_edit_revisions (scopeKind, scopeId, revision, stateJson, commandJson, createdAt) VALUES ('variant', ?, 0, ?, '{"type":"initial"}', ?)`).run(variant.id, JSON.stringify({ timeline: variant.timeline, bgm: variant.bgm, cover: variant.cover, issues: variant.issues }), now());
          const uniqueFingerprints = new Set(variant.timeline.clips.map((clip) => clip.sourceFingerprint));
          for (const fingerprint of uniqueFingerprints) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'video', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, fingerprint, now());
          for (const asset of prepared) if (uniqueFingerprints.has(asset.fingerprint)) asset.existingUsageCount += 1;
          if (variant.cover.coverKey) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'cover', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, variant.cover.coverKey, now());
          if (variant.bgm.trackId) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'bgm', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, variant.bgm.trackId, now());
        }
        for (let left = 0; left < variants.length; left += 1) {
          let maxScore = 0;
          for (let right = 0; right < variants.length; right += 1) if (left !== right) maxScore = Math.max(maxScore, calculateOverlapScore(overlapInput(variants[left]), overlapInput(variants[right])).score);
          db.prepare(`UPDATE final_edit_variants SET overlapJson=? WHERE id=?`).run(JSON.stringify({ maxScore }), variants[left].id);
        }
        db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, errorCode=NULL, errorMessage=NULL, finishedAt=? WHERE id=? AND status='running'`).run(JSON.stringify({ groupId, variantIds: variants.map((variant) => variant.id), previewRelativePaths: Object.fromEntries(previewPaths) }), now(), jobId);
      });
      transaction();
    } catch (error) {
      const code = error instanceof FinalEditError ? error.code : 'prepare_failed';
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE final_edit_groups SET status='failed', updatedAt=? WHERE id=?`).run(now(), groupId);
      db.prepare(`UPDATE final_edit_jobs SET status='failed', errorCode=?, errorMessage=?, finishedAt=? WHERE id=?`).run(code, message, now(), jobId);
      if (deps.runJobsInline) throw error;
    }
  };

  const start = async (input: StartFinalEditInput): Promise<JobRef> => {
    let script: ScriptSnapshot;
    let executionInput = input;
    if (input.draftGroupId) {
      const draft = db.prepare(`SELECT projectId, shotSetId, scriptSnapshotJson, narrationConfigJson, analysisProviderId, selectedMaterialKeysJson FROM final_edit_groups WHERE id=?`).get(input.draftGroupId) as { projectId: string; shotSetId: string; scriptSnapshotJson: string; narrationConfigJson: string; analysisProviderId: string; selectedMaterialKeysJson: string } | undefined;
      if (!draft || draft.projectId !== input.projectId) throw new FinalEditError('draft_not_found', '混剪草稿不存在或不属于当前项目', 404);
      script = parseJson<ScriptSnapshot>(draft.scriptSnapshotJson, {} as ScriptSnapshot);
      const config = parseJson<{ providerId?: string; voice?: string; speed?: number }>(draft.narrationConfigJson, {});
      executionInput = {
        ...input,
        scriptDraftId: '',
        shotSetId: draft.shotSetId,
        editedNarrationText: script.editedNarrationText,
        selectedMaterialKeys: parseJson<unknown[]>(draft.selectedMaterialKeysJson, []).map(String),
        providerId: String(config.providerId || ''),
        voice: String(config.voice || ''),
        speed: Number(config.speed ?? 1),
        analysisProviderId: draft.analysisProviderId,
      };
    } else {
      script = resolveTaskScript(db, input);
    }
    if (!executionInput.providerId.trim() || !executionInput.voice.trim()) throw new FinalEditError('tts_selection_required', '必须明确选择口播配音供应商和音色');
    validateTtsSpeed(executionInput.speed);
    await preflight(executionInput);
    if (!script.segments.length) throw new FinalEditError('narration_text_required', '请输入混剪文案');
    const selectedMaterialKeys = selectedAssets(db, storageRoot, executionInput.projectId, script.shotSetId, executionInput.selectedMaterialKeys).map((asset) => asset.assetKey!);
    const normalizedInput: StartFinalEditInput = {
      ...executionInput,
      scriptDraftId: script.sourceDraftId || '',
      shotSetId: script.shotSetId,
      editedNarrationText: script.editedNarrationText,
      selectedMaterialKeys,
    };
    const provider = db.prepare(`SELECT costPerThousandCharacters FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(executionInput.providerId) as { costPerThousandCharacters: number } | undefined;
    if (!provider) throw new FinalEditError('tts_provider_unavailable', '口播配音供应商不存在或未启用');
    // A generate action creates a new editable group. Reusing a group by its
    // narration hash appended variants to the old group, so requesting one
    // output after earlier runs appeared as three or four outputs in the UI.
    const groupId = uuidv4();
    // The v1 schema also made narrationHash unique per project/script. Include
    // this generation id so new groups remain compatible with existing DBs.
    const narrationHash = sha256(JSON.stringify({ scriptDraftId: normalizedInput.scriptDraftId, narration: script.segments.map((segment) => segment.narration), providerId: executionInput.providerId, voice: executionInput.voice, speed: executionInput.speed, adapterVersion: 1, generationId: groupId }));
    const titleParts = script.coverTitleParts || splitCoverTitle(script.title);
    const jobId = uuidv4();
    const requestKey = sha256(JSON.stringify({ kind: 'prepare', groupId, count: executionInput.count, outputPreset: executionInput.outputPreset, at: Date.now() }));
    const ttsCost = getFinalEditTtsAdapter(executionInput.providerId).estimateCost({ text: script.segments.map((segment) => segment.narration).join(''), costPerThousandCharacters: provider.costPerThousandCharacters });
    const analysisCount = selectedMaterialKeys.length;
    const analysisCost = executionInput.analysisProviderId && deps.estimateAnalysisCost ? deps.estimateAnalysisCost({ providerId: executionInput.analysisProviderId, requestCount: analysisCount }) : 0;
    const estimatedCost = Number((ttsCost + analysisCost).toFixed(6));
    const jobSnapshot = { version: 1 as const, input: normalizedInput, scriptSnapshot: script };
    const createdAt = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO final_edit_groups (id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash, analysisProviderId, narrationConfigJson, coverTitleJson, textStylesJson, editedNarrationText, scriptSyncState, sourceScriptUpdatedAt, selectedMaterialKeysJson, status, phase, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'validating', 0, ?, ?)`).run(groupId, executionInput.projectId, normalizedInput.scriptDraftId, script.shotSetId, JSON.stringify(script), narrationHash, executionInput.analysisProviderId || '', JSON.stringify({ providerId: executionInput.providerId, voice: executionInput.voice, speed: executionInput.speed }), JSON.stringify({ primary: { id: 'primary', text: titleParts.primary, textSource: 'script' }, secondary: { id: 'secondary', text: titleParts.secondary, textSource: 'script' } }), JSON.stringify(buildStyles()), script.editedNarrationText, script.scriptSyncState, script.sourceScriptUpdatedAt, JSON.stringify(selectedMaterialKeys), createdAt, createdAt);
      db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt) VALUES (?, ?, ?, 'prepare', 'queued', 'analyzing', 0, ?, ?, ?, 'CNY', ?)`).run(jobId, executionInput.projectId, groupId, requestKey, JSON.stringify(jobSnapshot), estimatedCost, createdAt);
    })();
    if (deps.runJobsInline) await resumePrepareJob(jobId);
    else void resumePrepareJob(jobId);
    const status = (db.prepare(`SELECT status FROM final_edit_jobs WHERE id=?`).get(jobId) as { status: string }).status;
    return { id: jobId, groupId, kind: 'prepare', status };
  };

  const resumePrepareJob = async (jobId: string) => {
    const row = db.prepare(`SELECT groupId, inputSnapshotJson FROM final_edit_jobs WHERE id=? AND kind='prepare' AND status='queued'`).get(jobId) as { groupId: string; inputSnapshotJson: string } | undefined;
    if (!row) return;
    const snapshot = parseJson<{ version?: number; input?: StartFinalEditInput; scriptSnapshot?: ScriptSnapshot } | null>(row.inputSnapshotJson, null);
    let input = snapshot?.input;
    let script = snapshot?.scriptSnapshot;
    // Compatibility for prepare jobs written before Phase 2: their group copy
    // is already immutable and is safe to use. Recovery must never re-read
    // mutable script_drafts.
    if (!input || !script) {
      input = parseJson<StartFinalEditInput | null>(row.inputSnapshotJson, null) || undefined;
      const groupSnapshot = db.prepare(`SELECT scriptSnapshotJson FROM final_edit_groups WHERE id=?`).get(row.groupId) as { scriptSnapshotJson: string } | undefined;
      script = groupSnapshot ? parseJson<ScriptSnapshot | null>(groupSnapshot.scriptSnapshotJson, null) || undefined : undefined;
    }
    if (!input || !script || !Array.isArray(script.segments)) {
      db.prepare(`UPDATE final_edit_jobs SET status='failed', errorCode='prepare_snapshot_invalid', errorMessage='准备任务快照损坏', finishedAt=? WHERE id=? AND status='queued'`).run(now(), jobId);
      return;
    }
    const claimed = db.prepare(`UPDATE final_edit_jobs SET status='running', phase='analyzing', progress=0, attempt=attempt+1, startedAt=?, finishedAt=NULL WHERE id=? AND kind='prepare' AND status='queued'`).run(now(), jobId);
    if (!claimed.changes) return;
    db.prepare(`UPDATE final_edit_groups SET status='running', phase='analyzing', updatedAt=? WHERE id=?`).run(now(), row.groupId);
    await runFinalEditHeavyJob(() => prepare(jobId, row.groupId, input!, script!));
  };

  const apply = (command: FinalEditCommand): MutationResult => {
    if (command.scope === 'variant') {
      const row = db.prepare(`SELECT * FROM final_edit_variants WHERE id=?`).get(command.variantId) as Record<string, unknown> | undefined;
      if (!row) throw new FinalEditError('variant_not_found', '成片草稿不存在', 404);
      if (Number(row.revision) !== command.expectedRevision) throw new FinalEditError('revision_conflict', '草稿已被其他操作更新', 409, { expectedRevision: command.expectedRevision, currentRevision: Number(row.revision) });
      let timeline = parseJson<VideoTimeline>(String(row.timelineJson), { fps: 24, introFrames: 20, bodyFrames: 0, clips: [] });
      let bgm = parseJson<{ trackId: string | null; gainDb: number; loop: boolean; fadeOutSec: number }>(String(row.bgmJson), { trackId: null, gainDb: -16, loop: true, fadeOutSec: 0.8 });
      let cover = normalizeCover(parseJson(String(row.coverJson), {}));
      if (command.type === 'apply_proposal') {
        const proposal = db.prepare(`SELECT baseRevision, proposalJson, status FROM final_edit_proposals WHERE id=? AND variantId=?`).get(command.proposalId, command.variantId) as { baseRevision: number; proposalJson: string; status: string } | undefined;
        if (!proposal || proposal.status !== 'ready') throw new FinalEditError('proposal_not_ready', 'AI 候选不存在或不可应用', 404);
        if (proposal.baseRevision !== Number(row.revision)) {
          db.prepare(`UPDATE final_edit_proposals SET status='stale' WHERE id=?`).run(command.proposalId);
          throw new FinalEditError('proposal_stale', '草稿已变化，AI 候选不能覆盖当前编辑', 409);
        }
        const proposed = parseJson<{ timeline?: VideoTimeline }>(proposal.proposalJson, {});
        if (!proposed.timeline) throw new FinalEditError('proposal_invalid', 'AI 候选数据损坏');
        for (let index = 0; index < proposed.timeline.clips.length; index += 1) {
          const clip = proposed.timeline.clips[index];
          const overlapsSource = proposed.timeline.clips.slice(index + 1).some((other) => other.sourceFingerprint === clip.sourceFingerprint && clip.sourceInFrame < other.sourceOutFrame && clip.sourceOutFrame > other.sourceInFrame);
          if (overlapsSource) throw new FinalEditError('source_range_overlap', 'AI 候选重复使用了同一素材的重叠源区间');
        }
        timeline = proposed.timeline;
      }
      if (command.type === 'restore_revision') {
        const historical = db.prepare(`SELECT stateJson FROM final_edit_revisions WHERE scopeKind='variant' AND scopeId=? AND revision=?`).get(command.variantId, command.revision) as { stateJson: string } | undefined;
        if (!historical) throw new FinalEditError('revision_not_found', '要恢复的历史版本不存在', 404);
        const state = parseJson<{ timeline: VideoTimeline; bgm: typeof bgm; cover: typeof cover } | null>(historical.stateJson, null);
        if (!state) throw new FinalEditError('revision_invalid', '历史版本数据损坏');
        timeline = state.timeline; bgm = state.bgm; cover = state.cover;
      }
      if (command.type === 'delete_clip') timeline.clips = timeline.clips.filter((clip) => clip.id !== command.clipId);
      if (command.type === 'swap_clips') {
        const ordered = [...timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
        const leftIndex = ordered.findIndex((clip) => clip.id === command.leftClipId);
        const rightIndex = ordered.findIndex((clip) => clip.id === command.rightClipId);
        if (leftIndex < 0 || rightIndex < 0) throw new FinalEditError('clip_not_found', '要交换的视频片段不存在', 404);
        if (Math.abs(leftIndex - rightIndex) !== 1) throw new FinalEditError('clips_not_adjacent', '只能交换相邻的视频片段');
        const first = ordered[Math.min(leftIndex, rightIndex)];
        const second = ordered[Math.max(leftIndex, rightIndex)];
        const gap = second.timelineInFrame - first.timelineOutFrame;
        const firstDuration = first.timelineOutFrame - first.timelineInFrame;
        const secondDuration = second.timelineOutFrame - second.timelineInFrame;
        const start = first.timelineInFrame;
        second.timelineInFrame = start;
        second.timelineOutFrame = start + secondDuration;
        first.timelineInFrame = second.timelineOutFrame + gap;
        first.timelineOutFrame = first.timelineInFrame + firstDuration;
      }
      if (command.type === 'insert_clip') {
        const source = db.prepare(`SELECT a.fileFingerprint FROM video_jobs vj JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id JOIN final_edit_groups g ON g.id=? WHERE vj.id=? AND vj.projectId=g.projectId AND vj.shotSetId=g.shotSetId`).get(String(row.groupId), command.videoJobId) as { fileFingerprint: string } | undefined;
        if (!source || source.fileFingerprint !== command.sourceFingerprint) throw new FinalEditError('shot_set_mismatch', '插入素材不属于当前分镜组或文件已变化');
        timeline.clips.push({
          id: uuidv4(), videoJobId: command.videoJobId, sourceFingerprint: command.sourceFingerprint,
          sourceInFrame: Math.round(command.sourceInFrame), sourceOutFrame: Math.round(command.sourceOutFrame),
          timelineInFrame: Math.round(command.timelineInFrame), timelineOutFrame: Math.round(command.timelineOutFrame),
          boundSegmentId: null, framing: { scale: 1, offsetX: 0, offsetY: 0 }, manualUseOverride: true,
        });
      }
      if (command.type === 'move_clip' || command.type === 'trim_clip' || command.type === 'replace_clip') {
        const clip = timeline.clips.find((item) => item.id === command.clipId);
        if (!clip) throw new FinalEditError('clip_not_found', '视频片段不存在', 404);
        if (command.type === 'move_clip') {
          const duration = clip.timelineOutFrame - clip.timelineInFrame;
          clip.timelineInFrame = Math.round(command.timelineInFrame);
          clip.timelineOutFrame = clip.timelineInFrame + duration;
        }
        if (command.type === 'trim_clip') {
          clip.sourceInFrame = Math.round(command.sourceInFrame); clip.sourceOutFrame = Math.round(command.sourceOutFrame);
          clip.timelineInFrame = Math.round(command.timelineInFrame); clip.timelineOutFrame = Math.round(command.timelineOutFrame);
        }
        if (command.type === 'replace_clip') {
          const source = db.prepare(`SELECT vj.shotSetId, a.fileFingerprint, a.mediaJson FROM video_jobs vj JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id JOIN final_edit_groups g ON g.id=? WHERE vj.id=? AND vj.projectId=g.projectId AND vj.shotSetId=g.shotSetId`).get(String(row.groupId), command.videoJobId) as { shotSetId: string; fileFingerprint: string; mediaJson: string } | undefined;
          if (!source || source.fileFingerprint !== command.sourceFingerprint) throw new FinalEditError('shot_set_mismatch', '替换素材不属于当前分镜组或文件已变化');
          clip.videoJobId = command.videoJobId; clip.sourceFingerprint = command.sourceFingerprint;
          clip.sourceInFrame = Math.round(command.sourceInFrame); clip.sourceOutFrame = Math.round(command.sourceOutFrame);
        }
      }
      if (command.type === 'set_bgm_gain') bgm.gainDb = Math.max(-40, Math.min(0, command.gainDb));
      if (command.type === 'set_bgm') {
        if (command.trackId && !db.prepare(`SELECT 1 FROM final_edit_bgm_tracks WHERE id=? AND status='ready'`).get(command.trackId)) throw new FinalEditError('bgm_not_found', 'BGM 不存在或不可用', 404);
        bgm.trackId = command.trackId;
      }
      if (command.type === 'set_cover') {
        const parsedKey = parseCoverKey(command.coverKey);
        if (!parsedKey) throw new FinalEditError('cover_not_found', '封面候选格式无效', 404);
        let kind: FinalEditVariantView['cover']['kind'];
        if (parsedKey.kind === 'storyboard_image') {
          const exists = db.prepare(`SELECT 1 FROM shots s JOIN final_edit_groups g ON g.id=? WHERE s.latestGeneratedImageId=? AND s.shotSetId=g.shotSetId`).get(String(row.groupId), parsedKey.imageId);
          if (!exists) throw new FinalEditError('cover_not_found', '封面不属于当前分镜组', 404);
          kind = 'storyboard_image';
        } else {
          const candidate = db.prepare(`
            SELECT a.generatedJson
            FROM video_jobs vj
            JOIN final_edit_asset_analysis a ON a.videoJobId=vj.id
            JOIN final_edit_groups g ON g.id=?
            WHERE vj.id=? AND vj.projectId=g.projectId AND vj.shotSetId=g.shotSetId AND a.status='succeeded'
          `).get(String(row.groupId), parsedKey.videoJobId) as { generatedJson: string } | undefined;
          const frames = candidate ? parseJson<{ coverFrameTimesUs?: unknown[] }>(candidate.generatedJson, {}).coverFrameTimesUs || [] : [];
          if (!frames.some((value) => Number(value) === parsedKey.frameUs)) throw new FinalEditError('cover_not_found', '视频关键帧封面不属于当前分镜组', 404);
          kind = 'video_keyframe';
        }
        cover = { coverKey: command.coverKey, kind, sourceUrl: `/api/final-edit-groups/${String(row.groupId)}/cover-candidates/${encodeURIComponent(command.coverKey)}`, framing: cover.framing };
      }
      if (command.type === 'set_cover_framing') {
        cover.framing = {
          scale: Math.max(1, Math.min(3, command.scale)),
          offsetX: Math.max(-1, Math.min(1, command.offsetX)),
          offsetY: Math.max(-1, Math.min(1, command.offsetY)),
        };
      }
      if (command.type === 'unbind_clip' || command.type === 'bind_clip' || command.type === 'set_framing') {
        const clip = timeline.clips.find((item) => item.id === command.clipId);
        if (!clip) throw new FinalEditError('clip_not_found', '视频片段不存在', 404);
        if (command.type === 'unbind_clip') clip.boundSegmentId = null;
        if (command.type === 'bind_clip') clip.boundSegmentId = command.segmentId;
        if (command.type === 'set_framing') clip.framing = { scale: Math.max(1, Math.min(3, command.scale)), offsetX: Math.max(-1, Math.min(1, command.offsetX)), offsetY: Math.max(-1, Math.min(1, command.offsetY)) };
      }
      for (const clip of timeline.clips) {
        if (clip.timelineInFrame < 0 || clip.timelineOutFrame > timeline.bodyFrames || clip.timelineOutFrame <= clip.timelineInFrame || clip.sourceInFrame < 0 || clip.sourceOutFrame <= clip.sourceInFrame) throw new FinalEditError('source_out_of_range', '片段时间范围无效');
        const analysis = db.prepare(`SELECT mediaJson FROM final_edit_asset_analysis WHERE videoJobId=? AND fileFingerprint=?`).get(clip.videoJobId, clip.sourceFingerprint) as { mediaJson: string } | undefined;
        const sourceFrames = Math.floor(Number(parseJson<{ durationUs?: number }>(analysis?.mediaJson || '{}', {}).durationUs || 0) * 24 / 1_000_000);
        if (!analysis || clip.sourceOutFrame > sourceFrames) throw new FinalEditError('source_out_of_range', '片段超出源视频真实时长');
      }
      const orderedClips = [...timeline.clips].sort((left, right) => left.timelineInFrame - right.timelineInFrame);
      if (orderedClips.some((clip, index) => index > 0 && clip.timelineInFrame < orderedClips[index - 1].timelineOutFrame)) throw new FinalEditError('timeline_overlap', '视频片段不能重叠');
      const issues = issueList(timeline, cover.coverKey, true);
      const revision = Number(row.revision) + 1;
      const groupId = String(row.groupId);
      db.transaction(() => {
        db.prepare(`INSERT INTO final_edit_revisions (scopeKind, scopeId, revision, stateJson, commandJson, createdAt) VALUES ('variant', ?, ?, ?, ?, ?)`).run(command.variantId, revision, JSON.stringify({ timeline, bgm, cover, issues }), JSON.stringify(command), now());
        db.prepare(`UPDATE final_edit_variants SET timelineJson=?, bgmJson=?, coverJson=?, issuesJson=?, revision=?, updatedAt=? WHERE id=?`).run(JSON.stringify(timeline), JSON.stringify(bgm), JSON.stringify(cover), JSON.stringify(issues), revision, now(), command.variantId);
        const ownership = db.prepare(`SELECT g.projectId, g.shotSetId, g.id AS groupId FROM final_edit_groups g WHERE g.id=?`).get(groupId) as { projectId: string; shotSetId: string; groupId: string };
        db.prepare(`DELETE FROM final_edit_usage WHERE scopeKind='draft' AND variantId=?`).run(command.variantId);
        for (const fingerprint of new Set(timeline.clips.map((clip) => clip.sourceFingerprint))) db.prepare(`INSERT INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'video', ?, ?)`).run(`${command.variantId}:${revision}`, ownership.projectId, ownership.shotSetId, ownership.groupId, command.variantId, fingerprint, now());
        if (cover.coverKey) db.prepare(`INSERT INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'cover', ?, ?)`).run(`${command.variantId}:${revision}`, ownership.projectId, ownership.shotSetId, ownership.groupId, command.variantId, cover.coverKey, now());
        if (bgm.trackId) db.prepare(`INSERT INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'bgm', ?, ?)`).run(`${command.variantId}:${revision}`, ownership.projectId, ownership.shotSetId, ownership.groupId, command.variantId, bgm.trackId, now());
        if (command.type === 'apply_proposal') db.prepare(`UPDATE final_edit_proposals SET status='applied', appliedAt=? WHERE id=?`).run(now(), command.proposalId);
      })();
      refreshOverlap(groupId);
      const view = load(groupId).variants.find((variant) => variant.id === command.variantId)!;
      return { scope: 'variant', view };
    }

    const row = db.prepare(`SELECT * FROM final_edit_groups WHERE id=?`).get(command.groupId) as Record<string, unknown> | undefined;
    if (!row) throw new FinalEditError('group_not_found', '成片组不存在', 404);
    if (Number(row.revision) !== command.expectedRevision) throw new FinalEditError('revision_conflict', '成片组已被其他操作更新', 409, { expectedRevision: command.expectedRevision, currentRevision: Number(row.revision) });
    if (command.type === 'set_mixcut_script_state' && row.status !== 'editing') throw new FinalEditError('draft_not_editable', '只能修改编辑中的混剪草稿', 409);
    const cues = parseJson<SubtitleCue[]>(String(row.subtitleStateJson), []);
    const coverTitle = parseJson<{ primary: { id: 'primary'; text: string; textSource: 'script' | 'manual' }; secondary: { id: 'secondary'; text: string; textSource: 'script' | 'manual' } }>(String(row.coverTitleJson), { primary: { id: 'primary', text: '', textSource: 'script' }, secondary: { id: 'secondary', text: '', textSource: 'script' } });
    const textStyles = parseJson<FinalEditGroupView['textStyles']>(String(row.textStylesJson), buildStyles());
    let mixcutScriptSnapshot = parseJson<ScriptSnapshot>(String(row.scriptSnapshotJson), {} as ScriptSnapshot);
    let narrationConfig = parseJson<{ providerId: string; voice: string; speed: number }>(String(row.narrationConfigJson), { providerId: '', voice: '', speed: 1 });
    let selectedMaterialKeys = parseJson<unknown[]>(String(row.selectedMaterialKeysJson || '[]'), []).map(String);
    let analysisProviderId = String(row.analysisProviderId || '');
    const validateCueRange = (cueId: string | null, startUs: number, endUs: number) => {
      const frameUs = Math.round(1_000_000 / FINAL_EDIT_FPS);
      if (startUs < 0 || endUs > Number(row.narrationDurationUs) || endUs - startUs < frameUs) throw new FinalEditError('subtitle_out_of_range', '字幕时间超出正文或短于一帧');
      if (cues.some((item) => item.id !== cueId && startUs < item.endUs && endUs > item.startUs)) throw new FinalEditError('subtitle_overlap', '字幕时间不能重叠');
    };
    if (command.type === 'set_subtitle_cue_text') {
      const cue = cues.find((item) => item.id === command.cueId);
      if (!cue) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      cue.text = command.text.replace(/[\r\n]+/g, ''); cue.textSource = 'manual';
    }
    if (command.type === 'move_subtitle_cue' || command.type === 'trim_subtitle_cue') {
      const cue = cues.find((item) => item.id === command.cueId);
      if (!cue) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      validateCueRange(cue.id, command.startUs, command.endUs);
      cue.startUs = command.startUs; cue.endUs = command.endUs; cue.timingSource = 'manual';
      cues.sort((a, b) => a.startUs - b.startUs);
    }
    if (command.type === 'insert_subtitle_cue') {
      const text = command.text.replace(/[\r\n]+/g, '').trim();
      if (!text) throw new FinalEditError('subtitle_text_empty', '字幕文字不能为空');
      validateCueRange(null, command.startUs, command.endUs);
      cues.push({ id: uuidv4(), segmentId: command.segmentId, text, startUs: command.startUs, endUs: command.endUs, textSource: 'manual', timingSource: 'manual' });
      cues.sort((a, b) => a.startUs - b.startUs);
    }
    if (command.type === 'split_subtitle_cue') {
      const cueIndex = cues.findIndex((item) => item.id === command.cueId);
      const cue = cues[cueIndex];
      if (!cue) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      const frameUs = Math.round(1_000_000 / 24);
      if (command.splitUs - cue.startUs < frameUs || cue.endUs - command.splitUs < frameUs) throw new FinalEditError('subtitle_out_of_range', '拆分点两侧都必须至少保留一帧');
      const clean = (value: string) => value.replace(/[\r\n]+/g, '').trim();
      if (!clean(command.leftText) || !clean(command.rightText)) throw new FinalEditError('subtitle_text_empty', '拆分后的字幕不能为空');
      cues.splice(cueIndex, 1,
        { ...cue, id: uuidv4(), text: clean(command.leftText), endUs: command.splitUs, textSource: 'manual', timingSource: 'manual' },
        { ...cue, id: uuidv4(), text: clean(command.rightText), startUs: command.splitUs, textSource: 'manual', timingSource: 'manual' });
    }
    if (command.type === 'delete_subtitle_cue') {
      const cueIndex = cues.findIndex((item) => item.id === command.cueId);
      if (cueIndex < 0) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      cues.splice(cueIndex, 1);
    }
    if (command.type === 'set_cover_title_part_text') {
      const text = command.text.replace(/[\r\n]+/g, '');
      if (command.part === 'primary') coverTitle.primary = { ...coverTitle.primary, text, textSource: 'manual' };
      else coverTitle.secondary = { ...coverTitle.secondary, text, textSource: 'manual' };
    }
    if (command.type === 'set_text_style') {
      if (!(command.preset in OUTPUT_PRESETS)) throw new FinalEditError('invalid_output_preset', '不支持的输出比例');
      textStyles[command.preset][command.target] = command.style;
    }
    if (command.type === 'reset_text_style') {
      if (!(command.preset in OUTPUT_PRESETS)) throw new FinalEditError('invalid_output_preset', '不支持的输出比例');
      textStyles[command.preset][command.target] = defaultTextStyle(command.target, OUTPUT_PRESETS[command.preset].width);
    }
    if (command.type === 'apply_title_preset') {
      const preset = db.prepare(`SELECT stylesByPresetJson FROM final_edit_title_presets WHERE id=?`).get(command.presetId) as { stylesByPresetJson: string } | undefined;
      if (!preset) throw new FinalEditError('preset_not_found', '标题预设不存在', 404);
      const stored = parseJson<Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }>>(preset.stylesByPresetJson, {} as Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle }>);
      for (const outputPreset of Object.keys(OUTPUT_PRESETS) as OutputPresetId[]) {
        if (!stored[outputPreset]) throw new FinalEditError('invalid_title_preset', '标题预设数据不完整');
        textStyles[outputPreset].coverPrimary = structuredClone(stored[outputPreset].coverPrimary);
        textStyles[outputPreset].coverSecondary = structuredClone(stored[outputPreset].coverSecondary);
      }
    }
    if (command.type === 'set_mixcut_script_state') {
      const editedNarrationText = String(command.editedNarrationText || '');
      if (!command.voice.trim()) throw new FinalEditError('tts_selection_required', '必须明确选择音色');
      validateTtsSpeed(command.speed);
      selectedMaterialKeys = command.selectedMaterialKeys.length
        ? selectedAssets(db, storageRoot, String(row.projectId), String(row.shotSetId), command.selectedMaterialKeys).map((asset) => asset.assetKey!)
        : [];
      const sourceScript: MixcutSourceScript | null = mixcutScriptSnapshot.source === 'module3'
        ? {
            version: 2,
            title: mixcutScriptSnapshot.title,
            coverTitleParts: mixcutScriptSnapshot.coverTitleParts,
            targetDurationSec: mixcutScriptSnapshot.targetDurationSec,
            shotSetId: String(row.shotSetId),
            segments: mixcutScriptSnapshot.sourceSegments || [],
            fullScript: mixcutScriptSnapshot.sourceNarrationText || '',
          }
        : null;
      mixcutScriptSnapshot = command.scriptDraftId !== undefined
        ? resolveEditingScript(db, { projectId: String(row.projectId), shotSetId: String(row.shotSetId), scriptDraftId: command.scriptDraftId, editedNarrationText })
        : buildMixcutEditingScriptSnapshot({ sourceDraftId: mixcutScriptSnapshot.sourceDraftId, sourceScriptUpdatedAt: mixcutScriptSnapshot.sourceScriptUpdatedAt, sourceScript, shotSetId: String(row.shotSetId), editedNarrationText });
      const providerId = String(command.providerId ?? narrationConfig.providerId).trim();
      if (!providerId || !db.prepare(`SELECT 1 FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(providerId)) throw new FinalEditError('tts_provider_unavailable', '口播配音供应商不存在或未启用');
      narrationConfig = { providerId, voice: command.voice.trim(), speed: command.speed };
      analysisProviderId = String(command.analysisProviderId ?? analysisProviderId);
    }
    const revision = Number(row.revision) + 1;
    db.transaction(() => {
      db.prepare(`INSERT INTO final_edit_revisions (scopeKind, scopeId, revision, stateJson, commandJson, createdAt) VALUES ('group', ?, ?, ?, ?, ?)`).run(command.groupId, revision, JSON.stringify({ cues, coverTitle, textStyles, scriptSnapshot: mixcutScriptSnapshot, narrationConfig, selectedMaterialKeys }), JSON.stringify(command), now());
      if (command.type === 'set_mixcut_script_state') {
        db.prepare(`UPDATE final_edit_groups SET scriptDraftId=?, analysisProviderId=?, subtitleStateJson=?, coverTitleJson=?, textStylesJson=?, scriptSnapshotJson=?, editedNarrationText=?, scriptSyncState=?, sourceScriptUpdatedAt=?, narrationConfigJson=?, selectedMaterialKeysJson=?, revision=?, updatedAt=? WHERE id=?`).run(mixcutScriptSnapshot.sourceDraftId || '', analysisProviderId, JSON.stringify(cues), JSON.stringify(coverTitle), JSON.stringify(textStyles), JSON.stringify(mixcutScriptSnapshot), mixcutScriptSnapshot.editedNarrationText, mixcutScriptSnapshot.scriptSyncState, mixcutScriptSnapshot.sourceScriptUpdatedAt, JSON.stringify(narrationConfig), JSON.stringify(selectedMaterialKeys), revision, now(), command.groupId);
      } else {
        db.prepare(`UPDATE final_edit_groups SET subtitleStateJson=?, coverTitleJson=?, textStylesJson=?, revision=?, updatedAt=? WHERE id=?`).run(JSON.stringify(cues), JSON.stringify(coverTitle), JSON.stringify(textStyles), revision, now(), command.groupId);
      }
    })();
    return { scope: 'group', view: load(command.groupId) };
  };

  const enqueueRender = async (input: EnqueueRenderInput): Promise<JobRef> => {
    const group = load(input.groupId);
    const variant = group.variants.find((item) => item.id === input.variantId);
    if (!variant) throw new FinalEditError('variant_not_found', '成片草稿不存在', 404);
    if (group.revision !== input.expectedGroupRevision || variant.revision !== input.expectedVariantRevision) throw new FinalEditError('revision_conflict', '导出前版本已变化', 409);
    const blocking = variant.issues.find((issue) => issue.severity === 'blocking');
    if (blocking) throw new FinalEditError(blocking.code, blocking.message);
    if (variant.cover.coverKey && db.prepare(`SELECT 1 FROM final_edit_variants WHERE groupId=? AND id<>? AND json_extract(coverJson, '$.coverKey')=? LIMIT 1`).get(group.id, variant.id, variant.cover.coverKey)) {
      throw new FinalEditError('duplicate_cover', '同组成片必须使用不同的封面底图');
    }
    const bundle = db.prepare(`SELECT relativeDir, manifestJson FROM final_edit_overlay_bundles WHERE id=? AND groupId=? AND groupRevision=? AND status='ready'`).get(input.overlayBundleId, group.id, group.revision) as { relativeDir: string; manifestJson: string } | undefined;
    if (!bundle) throw new FinalEditError('overlay_bundle_stale', '文字图层缺失或已经过期');
    const groupRow = db.prepare(`SELECT narrationAudioPath FROM final_edit_groups WHERE id=?`).get(group.id) as { narrationAudioPath: string | null };
    if (!groupRow.narrationAudioPath) throw new FinalEditError('audio_file_missing', '口播音频文件缺失');
    const toRelative = (absoluteOrRelative: string) => {
      try { return toStorageRelativePath(storageRoot, absoluteOrRelative); }
      catch { throw new FinalEditError('unsafe_path', '素材路径不在 storage 目录内'); }
    };
    const sourceIds = [...new Set(variant.timeline.clips.map((clip) => clip.videoJobId))];
    const sources = sourceIds.map((videoJobId) => {
      if (videoJobId.startsWith('external-asset-')) {
        const assetId = videoJobId.slice('external-asset-'.length);
        const external = db.prepare(`SELECT relativePath FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=? AND status='ready'`).get(assetId, group.projectId, group.shotSetId) as { relativePath: string } | undefined;
        if (!external) throw new FinalEditError('video_file_missing', `外部视频素材 ${assetId} 缺失`);
        const clip = variant.timeline.clips.find((item) => item.videoJobId === videoJobId)!;
        let absolutePath: string;
        try { absolutePath = resolveImportedExternalAssetVideoPath(storageRoot, { projectId: group.projectId, shotSetId: group.shotSetId }, external.relativePath); }
        catch (error) { throw new FinalEditError('unsafe_path', error instanceof Error ? error.message : '外部素材路径无效'); }
        return { videoJobId, relativePath: toRelative(absolutePath), fingerprint: clip.sourceFingerprint, externalScope: { projectId: group.projectId, shotSetId: group.shotSetId } };
      }
      const row = db.prepare(`SELECT localVideoPath FROM video_jobs WHERE id=? AND projectId=? AND shotSetId=?`).get(videoJobId, group.projectId, group.shotSetId) as { localVideoPath: string | null } | undefined;
      if (!row?.localVideoPath) throw new FinalEditError('video_file_missing', `视频素材 ${videoJobId} 缺失`);
      const clip = variant.timeline.clips.find((item) => item.videoJobId === videoJobId)!;
      return { videoJobId, relativePath: toRelative(row.localVideoPath), fingerprint: clip.sourceFingerprint };
    });
    if (!variant.cover.coverKey) throw new FinalEditError('cover_missing', '封面底图缺失');
    let coverRelativePath = '';
    try {
      const coverFile = await resolveCoverCandidateFile({ db, storageRoot, group: { id: group.id, projectId: group.projectId, shotSetId: group.shotSetId }, coverKey: variant.cover.coverKey });
      coverRelativePath = coverFile.relativePath;
    } catch (error) {
      throw new FinalEditError('cover_missing', error instanceof Error ? error.message : '封面底图缺失');
    }
    const bgmTrack = variant.bgm.trackId
      ? db.prepare(`SELECT id, relativePath, fileFingerprint FROM final_edit_bgm_tracks WHERE id=? AND status='ready'`).get(variant.bgm.trackId) as { id: string; relativePath: string; fileFingerprint: string } | undefined
      : undefined;
    if (variant.bgm.trackId && !bgmTrack) throw new FinalEditError('bgm_missing', '所选 BGM 已失效或文件不可用');
    const id = uuidv4();
    const snapshot = {
      groupRevision: group.revision, variantRevision: variant.revision,
      group: { coverTitle: group.coverTitle, subtitleCues: group.subtitleCues, narrationDurationUs: group.narrationDurationUs },
      variant, sources, coverRelativePath, narrationRelativePath: toRelative(groupRow.narrationAudioPath),
      bgm: bgmTrack ? { ...bgmTrack, gainDb: variant.bgm.gainDb, loop: variant.bgm.loop, fadeOutSec: variant.bgm.fadeOutSec } : null,
      overlayBundle: { id: input.overlayBundleId, relativeDir: bundle.relativeDir, manifest: parseJson(bundle.manifestJson, {}) },
    };
    db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, variantId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt) VALUES (?, ?, ?, ?, 'render', 'queued', 'preflight', 0, ?, ?, 0, 'CNY', ?)`).run(id, group.projectId, group.id, variant.id, sha256(JSON.stringify({ id, snapshot })), JSON.stringify(snapshot), now());
    return { id, groupId: group.id, variantId: variant.id, kind: 'render', status: 'queued' };
  };

  const getMixcutContext = async (projectId: string, requestedShotSetId?: string | null): Promise<MixcutContextResponse> => {
    // Query/aggregation logic lives in ./mixcut-context.ts so it can be
    // exercised directly by scripts/final-edit-mixcut-flow.test.ts against an
    // isolated in-memory db, without going through this closure's full
    // FinalEditWorkspaceDependencies (probeVideo/analyzeVideo/synthesize
    // stubs it doesn't need). This method's only job is the project-not-found
    // -> FinalEditError translation, since FinalEditError is owned by this
    // file (see mixcut-context.ts's file header for why that split avoids a
    // circular import).
    const context = await buildMixcutContext(db, storageRoot, projectId, requestedShotSetId ?? null);
    if (!context) throw new FinalEditError('project_not_found', '项目不存在', 404);
    return context;
  };

  const listShotSetExternalAssets = (projectId: string, shotSetId: string) => {
    try { return listImportedShotSetExternalAssets(materialDeps, projectId, shotSetId); }
    catch (error) { return translateMaterialError(error); }
  };
  const importShotSetExternalAssets = async (input: ShotSetExternalAssetImportInput) => {
    try { return await importUploadedShotSetExternalAssets(materialDeps, input); }
    catch (error) { return translateMaterialError(error); }
  };
  const resolveShotSetExternalAssetMedia = (projectId: string, shotSetId: string, assetId: string, kind: 'video' | 'thumbnail') => {
    try { return resolveImportedShotSetExternalAssetMedia(materialDeps, projectId, shotSetId, assetId, kind); }
    catch (error) { return translateMaterialError(error); }
  };
  const deleteShotSetExternalAsset = (input: { projectId: string; shotSetId: string; assetId: string }) => {
    try { return deleteImportedShotSetExternalAsset(materialDeps, input); }
    catch (error) { return translateMaterialError(error); }
  };

  return {
    preflight, start, ensureMixcutDraft, load, apply, enqueueRender, resumePrepareJob, getMixcutContext,
    listShotSetExternalAssets, importShotSetExternalAssets, resolveShotSetExternalAssetMedia, deleteShotSetExternalAsset,
  };
}
