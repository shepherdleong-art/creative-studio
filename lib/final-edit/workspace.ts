import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { defaultTextStyle, splitCoverTitle, timelineGaps } from './domain.ts';
import { calculateOverlapScore } from './overlap.ts';
import { scanFinalEditBgm } from './bgm.ts';
import { runFinalEditHeavyJob } from './heavy-job-lock.ts';
import { getFinalEditTtsAdapter } from './adapters/tts-registry.ts';
import { resolveStoragePath, toStorageRelativePath } from './storage-path.ts';
import {
  FINAL_EDIT_FPS,
  FINAL_EDIT_INTRO_DURATION_US,
  FINAL_EDIT_INTRO_FRAMES,
  OUTPUT_PRESETS,
  type CapacityEstimate,
  type FinalEditAssetView,
  type FinalEditGroupView,
  type FinalEditIssue,
  type FinalEditVariantView,
  type JobRef,
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

interface ScriptSnapshot {
  version: number;
  title: string;
  coverTitleParts?: { primary: string; secondary: string };
  targetDurationSec: number;
  shotSetId: string;
  segments: ScriptSegment[];
  fullScript: string;
}

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
  synthesize(input: {
    scriptDraftId: string;
    segments: Array<{ segmentId: string; narration: string }>;
    providerId: string;
    voice: string;
    speed: number;
    narrationHash: string;
  }): Promise<NarrationArtifact>;
  estimateAnalysisCost?(input: { providerId: string; requestCount: number }): number;
}

export interface PreflightInput {
  projectId: string;
  scriptDraftId: string;
  count: number;
  outputPreset: OutputPresetId;
}

export interface StartFinalEditInput extends PreflightInput {
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
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'restore_revision'; revision: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_bgm_gain'; gainDb: number }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_bgm'; trackId: string | null }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_cover'; coverKey: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'apply_proposal'; proposalId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'unbind_clip'; clipId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'bind_clip'; clipId: string; segmentId: string }
  | { scope: 'variant'; variantId: string; expectedRevision: number; type: 'set_framing'; clipId: string; scale: number; offsetX: number; offsetY: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_subtitle_cue_text'; cueId: string; text: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'move_subtitle_cue'; cueId: string; startUs: number; endUs: number }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'split_subtitle_cue'; cueId: string; splitUs: number; leftText: string; rightText: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'delete_subtitle_cue'; cueId: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_cover_title_part_text'; part: 'primary' | 'secondary'; text: string }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'set_text_style'; preset: OutputPresetId; target: 'coverPrimary' | 'coverSecondary' | 'subtitle'; style: TextStyle }
  | { scope: 'group'; groupId: string; expectedRevision: number; type: 'apply_title_preset'; presetId: string };

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
  load(groupId: string): FinalEditGroupView;
  apply(command: FinalEditCommand): MutationResult;
  enqueueRender(input: EnqueueRenderInput): Promise<JobRef>;
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

interface AssetRow {
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
function scriptFromDb(db: Database.Database, projectId: string, scriptDraftId: string): ScriptSnapshot {
  const row = db.prepare(`SELECT projectId, outputJson FROM script_drafts WHERE id = ?`).get(scriptDraftId) as { projectId: string; outputJson: string } | undefined;
  if (!row || row.projectId !== projectId) throw new FinalEditError('script_not_found', '脚本不存在或不属于当前项目', 404);
  const script = parseJson<ScriptSnapshot | null>(row.outputJson, null);
  if (!script || script.version !== 2 || !script.shotSetId || !Array.isArray(script.segments) || script.segments.length === 0) {
    throw new FinalEditError('script_invalid_v2', '脚本不是可用的 v2 脚本');
  }
  return script;
}

function assetsForScript(db: Database.Database, storageRoot: string, projectId: string, shotSetId: string): AssetRow[] {
  const rows = db.prepare(`
    SELECT id AS videoJobId, shotSetId, shotId, filename, localVideoPath, durationSec
    FROM video_jobs
    WHERE projectId = ? AND shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
    ORDER BY id
  `).all(projectId, shotSetId) as AssetRow[];
  return rows.filter((row) => {
    try {
      const resolved = resolveStoragePath(storageRoot, row.localVideoPath, { allowAbsolute: true });
      return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    } catch { return false; }
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
      issues.push({ code: 'clip_too_short', severity: 'warning', message: '人工片段短于 0.5 秒', targetId: clip.id });
    }
  }
  return issues;
}

export function planTimeline(assets: PreparedAsset[], bodyFrames: number, variantIndex: number, segments: ScriptSegment[], autoUseLimit = 2): VideoTimeline {
  const clips: TimelineClip[] = [];
  const rangeCursor = new Map<string, number>();
  const timelineUseCount = new Map<string, number>();
  let cursor = 0;
  const candidates = assets
    .filter((asset) => !asset.autoUseDisabled && asset.existingUsageCount < autoUseLimit)
    .flatMap((asset) => asset.analysis.usableRanges
      .map((range, rangeIndex) => ({
        asset,
        rangeIndex,
        startFrame: Math.max(0, Math.ceil(range.startUs * FINAL_EDIT_FPS / 1_000_000)),
        endFrame: Math.min(Math.floor(asset.durationUs * FINAL_EDIT_FPS / 1_000_000), Math.floor(range.endUs * FINAL_EDIT_FPS / 1_000_000)),
        qualityScore: Math.max(0, Math.min(1, Number(range.qualityScore) || 0)),
      }))
      .filter((candidate) => candidate.endFrame - candidate.startFrame >= 12));
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
        const score = (directReference ? 10 : 0) + candidate.qualityScore * 3 - repeated * 2 - candidate.asset.existingUsageCount - rotation / Math.max(1, candidates.length);
        return { ...candidate, key, rangeStart, available, score };
      })
      .filter((candidate) => candidate.available >= 12)
      .sort((left, right) => right.score - left.score);
    const candidate = ranked[0];
    if (!candidate) break;
    const remainingSegment = Math.max(12, Math.ceil((segmentIndex + 1) * bodyFrames / Math.max(1, segments.length)) - cursor);
    const length = Math.min(84, remainingSegment, candidate.available, bodyFrames - cursor);
    if (length < 12) break;
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

  const preflight = async (input: PreflightInput): Promise<CapacityEstimate> => {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) throw new FinalEditError('invalid_count', '生成数量必须是 1～5');
    if (!(input.outputPreset in OUTPUT_PRESETS)) throw new FinalEditError('invalid_output_preset', '不支持的输出比例');
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(input.projectId);
    if (!project) throw new FinalEditError('project_not_found', '项目不存在', 404);
    const script = scriptFromDb(db, input.projectId, input.scriptDraftId);
    const assets = assetsForScript(db, storageRoot, input.projectId, script.shotSetId);
    if (assets.length === 0) throw new FinalEditError('no_succeeded_videos', '当前脚本分镜组没有可读取的成功视频');
    const totalSec = assets.reduce((sum, asset) => sum + Math.max(0, Number(asset.durationSec || 0)) * 0.7, 0);
    const estimatedCompleteCount = Math.min(input.count, Math.floor(totalSec / Math.max(1, script.targetDurationSec)));
    const coverCandidateCount = countCoverCandidates(db, input.projectId, script.shotSetId);
    const warnings: string[] = [];
    if (estimatedCompleteCount < input.count) warnings.push(`预计只有 ${estimatedCompleteCount} 条可完整覆盖，其余草稿会保留缺口`);
    if (coverCandidateCount < input.count) warnings.push('独特封面底图不足，重复封面将阻止导出');
    return { assetCount: assets.length, videoJobIds: assets.map((asset) => asset.videoJobId), coverCandidateCount, requestedCount: input.count, estimatedCompleteCount, warnings };
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
      cover: parseJson(String(row.coverJson), { coverKey: null, kind: null, sourceUrl: null }),
      issues: parseJson<FinalEditIssue[]>(String(row.issuesJson), []),
      maxOverlap: Number(parseJson<{ maxScore?: number }>(String(row.overlapJson), {}).maxScore || 0),
      revision: Number(row.revision),
      lastRenderedRevision: row.lastRenderedRevision == null ? null : Number(row.lastRenderedRevision),
      renderStatus: (db.prepare(`SELECT status FROM final_edit_jobs WHERE variantId = ? AND kind = 'render' ORDER BY createdAt DESC LIMIT 1`).get(String(row.id)) as { status: string } | undefined)?.status || null,
    } satisfies FinalEditVariantView));
    const script = parseJson<ScriptSnapshot>(String(group.scriptSnapshotJson), {} as ScriptSnapshot);
    const assets = assetsForScript(db, storageRoot, String(group.projectId), String(group.shotSetId)).map((asset) => {
      const analysis = db.prepare(`SELECT * FROM final_edit_asset_analysis WHERE videoJobId = ?`).get(asset.videoJobId) as Record<string, unknown> | undefined;
      const generated = analysis ? parseJson<VideoAnalysisResult>(String(analysis.generatedJson), {} as VideoAnalysisResult) : null;
      const manual = analysis ? parseJson<Partial<VideoAnalysisResult>>(String(analysis.manualOverrideJson), {}) : {};
      const effective = generated ? { ...generated, ...manual } : null;
      const fingerprint = analysis ? String(analysis.fileFingerprint) : '';
      const relative = path.relative(storageRoot, asset.localVideoPath).split(path.sep).map(encodeURIComponent).join('/');
      const usage = db.prepare(`SELECT COUNT(*) AS count FROM final_edit_usage WHERE assetKind = 'video' AND assetKey = ?`).get(fingerprint) as { count: number };
      return {
        videoJobId: asset.videoJobId,
        shotSetId: asset.shotSetId,
        shotId: asset.shotId,
        filename: asset.filename || asset.videoJobId,
        previewUrl: `/api/videos/${relative}`,
        durationUs: Number(parseJson<{ durationUs?: number }>(String(analysis?.mediaJson || '{}'), {}).durationUs || Number(asset.durationSec || 0) * 1_000_000),
        fingerprint,
        analysisStatus: (analysis?.status || 'pending') as FinalEditAssetView['analysisStatus'],
        summary: effective?.summary || '',
        autoUseDisabled: Boolean(analysis?.autoUseDisabled),
        usageCount: Number(usage?.count || 0),
      } satisfies FinalEditAssetView;
    });
    const jobs = db.prepare(`SELECT id, variantId, kind, status, phase, progress, estimatedCost, costCurrency, errorCode, errorMessage FROM final_edit_jobs WHERE groupId = ? ORDER BY createdAt DESC`).all(groupId) as FinalEditGroupView['jobs'];
    const bgmTracks = db.prepare(`SELECT id, relativePath, durationUs FROM final_edit_bgm_tracks WHERE status='ready' ORDER BY relativePath`).all() as FinalEditGroupView['bgmTracks'];
    const coverCandidates = db.prepare(`SELECT ia.id FROM shots s JOIN image_assets ia ON ia.id=s.latestGeneratedImageId WHERE s.shotSetId=? AND s.latestGeneratedImageId IS NOT NULL ORDER BY s.indexNum`).all(String(group.shotSetId)) as Array<{ id: string }>;
    return {
      id: String(group.id), projectId: String(group.projectId), scriptDraftId: String(group.scriptDraftId), shotSetId: String(group.shotSetId),
      status: String(group.status), phase: String(group.phase), revision: Number(group.revision),
      narrationDurationUs: Number(group.narrationDurationUs),
      totalDurationUs: FINAL_EDIT_INTRO_DURATION_US + Number(group.narrationDurationUs),
      coverTitle: parseJson(String(group.coverTitleJson), { primary: { id: 'primary', text: script.title, textSource: 'script' }, secondary: { id: 'secondary', text: '', textSource: 'script' } }),
      subtitleCues: parseJson<SubtitleCue[]>(String(group.subtitleStateJson), []),
      textStyles: parseJson(String(group.textStylesJson), buildStyles()),
      variants, assets, bgmTracks,
      coverCandidates: coverCandidates.map((candidate) => ({ coverKey: `image:${candidate.id}`, sourceUrl: `/api/final-edit-groups/${String(group.id)}/cover-candidates/${encodeURIComponent(`image:${candidate.id}`)}` })),
      jobs,
    };
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
    const updateJob = (phase: string, progress: number) => db.prepare(`UPDATE final_edit_jobs SET status = 'running', phase = ?, progress = ?, startedAt = COALESCE(startedAt, ?) WHERE id = ?`).run(phase, progress, now(), jobId);
    try {
      updateJob('analyzing', 0.1);
      const rows = assetsForScript(db, storageRoot, input.projectId, script.shotSetId);
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
      }
      if (prepared.length === 0) throw new FinalEditError('no_succeeded_videos', '没有可读取的视频素材');

      updateJob('synthesizing', 0.45);
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
        : await deps.synthesize({ scriptDraftId: input.scriptDraftId, segments: normalizedSegments, providerId: input.providerId, voice: input.voice, speed: input.speed, narrationHash });
      validateNarrationAlignment(narration, script.segments.map((segment) => segment.narration).join(''));

      updateJob('planning', 0.7);
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
      const transaction = db.transaction(() => {
        db.prepare(`UPDATE final_edit_groups SET narrationAudioPath=?, narrationDurationUs=?, wordTimingsJson=?, subtitleStateJson=?, status='ready', phase='saving', revision=revision+1, updatedAt=? WHERE id=?`).run(narration.relativePath, narration.durationUs, JSON.stringify(narration.wordTimings), JSON.stringify(cues), now(), groupId);
        for (let index = 0; index < input.count; index += 1) {
          const variantIndex = nextIndex + index;
          const timeline = planTimeline(prepared, bodyFrames, variantIndex - 1, script.segments.map((segment, i) => ({ ...segment, id: segment.id || `segment-${i + 1}` })), autoUseLimit);
          const cover = covers[variantIndex - 1] ? { coverKey: `image:${covers[variantIndex - 1].imageAssetId}`, kind: 'storyboard_image' as const, sourceUrl: `/api/final-edit-groups/${groupId}/cover-candidates/${encodeURIComponent(`image:${covers[variantIndex - 1].imageAssetId}`)}` } : { coverKey: null, kind: null, sourceUrl: null };
          const issues = issueList(timeline, cover.coverKey, true);
          const variant: FinalEditVariantView = { id: uuidv4(), indexNum: variantIndex, outputPreset: input.outputPreset, timeline, bgm: { trackId: bgmTracks.length ? bgmTracks[(variantIndex - 1) % bgmTracks.length].id : null, gainDb: -16, loop: true, fadeOutSec: 0.8 }, cover, issues, maxOverlap: 0, revision: 0, lastRenderedRevision: null, renderStatus: null };
          variants.push(variant);
          db.prepare(`INSERT INTO final_edit_variants (id, groupId, indexNum, outputPreset, timelineJson, bgmJson, coverJson, issuesJson, overlapJson, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 0, ?, ?)`).run(variant.id, groupId, variant.indexNum, variant.outputPreset, JSON.stringify(timeline), JSON.stringify(variant.bgm), JSON.stringify(cover), JSON.stringify(issues), now(), now());
          db.prepare(`INSERT OR IGNORE INTO final_edit_revisions (scopeKind, scopeId, revision, stateJson, commandJson, createdAt) VALUES ('variant', ?, 0, ?, '{"type":"initial"}', ?)`).run(variant.id, JSON.stringify({ timeline, bgm: variant.bgm, cover, issues }), now());
          const uniqueFingerprints = new Set(timeline.clips.map((clip) => clip.sourceFingerprint));
          for (const fingerprint of uniqueFingerprints) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'video', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, fingerprint, now());
          for (const asset of prepared) if (uniqueFingerprints.has(asset.fingerprint)) asset.existingUsageCount += 1;
          if (cover.coverKey) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'cover', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, cover.coverKey, now());
          if (variant.bgm.trackId) db.prepare(`INSERT OR IGNORE INTO final_edit_usage (scopeKind, scopeId, projectId, shotSetId, groupId, variantId, assetKind, assetKey, createdAt) VALUES ('draft', ?, ?, ?, ?, ?, 'bgm', ?, ?)`).run(`${variant.id}:0`, input.projectId, script.shotSetId, groupId, variant.id, variant.bgm.trackId, now());
        }
        for (let left = 0; left < variants.length; left += 1) {
          let maxScore = 0;
          for (let right = 0; right < variants.length; right += 1) if (left !== right) maxScore = Math.max(maxScore, calculateOverlapScore(overlapInput(variants[left]), overlapInput(variants[right])).score);
          db.prepare(`UPDATE final_edit_variants SET overlapJson=? WHERE id=?`).run(JSON.stringify({ maxScore }), variants[left].id);
        }
        db.prepare(`UPDATE final_edit_groups SET phase='ready', status=?, updatedAt=? WHERE id=?`).run(variants.some((variant) => variant.issues.some((issue) => issue.severity === 'blocking')) ? 'partial' : 'ready', now(), groupId);
        db.prepare(`UPDATE final_edit_jobs SET status='succeeded', phase='succeeded', progress=1, outputJson=?, finishedAt=? WHERE id=?`).run(JSON.stringify({ groupId, variantIds: variants.map((variant) => variant.id) }), now(), jobId);
      });
      transaction();
    } catch (error) {
      const code = error instanceof FinalEditError ? error.code : 'prepare_failed';
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE final_edit_groups SET status='failed', phase=?, updatedAt=? WHERE id=?`).run(code, now(), groupId);
      db.prepare(`UPDATE final_edit_jobs SET status='failed', phase='failed', errorCode=?, errorMessage=?, finishedAt=? WHERE id=?`).run(code, message, now(), jobId);
      if (deps.runJobsInline) throw error;
    }
  };

  const start = async (input: StartFinalEditInput): Promise<JobRef> => {
    await preflight(input);
    const script = scriptFromDb(db, input.projectId, input.scriptDraftId);
    const narrationHash = sha256(JSON.stringify({ scriptDraftId: input.scriptDraftId, narration: script.segments.map((segment) => segment.narration), providerId: input.providerId, voice: input.voice, speed: input.speed, adapterVersion: 1 }));
    let group = db.prepare(`SELECT id FROM final_edit_groups WHERE projectId=? AND scriptDraftId=? AND narrationHash=?`).get(input.projectId, input.scriptDraftId, narrationHash) as { id: string } | undefined;
    const groupId = group?.id || uuidv4();
    if (!group) {
      const titleParts = script.coverTitleParts || splitCoverTitle(script.title);
      db.prepare(`INSERT INTO final_edit_groups (id, projectId, scriptDraftId, shotSetId, scriptSnapshotJson, narrationHash, analysisProviderId, narrationConfigJson, coverTitleJson, textStylesJson, status, phase, revision, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'validating', 0, ?, ?)`).run(groupId, input.projectId, input.scriptDraftId, script.shotSetId, JSON.stringify(script), narrationHash, input.analysisProviderId || '', JSON.stringify({ providerId: input.providerId, voice: input.voice, speed: input.speed }), JSON.stringify({ primary: { id: 'primary', text: titleParts.primary, textSource: 'script' }, secondary: { id: 'secondary', text: titleParts.secondary, textSource: 'script' } }), JSON.stringify(buildStyles()), now(), now());
      group = { id: groupId };
    }
    const jobId = uuidv4();
    const requestKey = sha256(JSON.stringify({ kind: 'prepare', groupId, count: input.count, outputPreset: input.outputPreset, at: Date.now() }));
    const provider = db.prepare(`SELECT costPerThousandCharacters FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(input.providerId) as { costPerThousandCharacters: number } | undefined;
    if (!provider) throw new FinalEditError('tts_provider_unavailable', '口播配音供应商不存在或未启用');
    const ttsCost = getFinalEditTtsAdapter(input.providerId).estimateCost({ text: script.segments.map((segment) => segment.narration).join(''), costPerThousandCharacters: provider.costPerThousandCharacters });
    const analysisCount = assetsForScript(db, storageRoot, input.projectId, script.shotSetId).length;
    const analysisCost = input.analysisProviderId && deps.estimateAnalysisCost ? deps.estimateAnalysisCost({ providerId: input.analysisProviderId, requestCount: analysisCount }) : 0;
    const estimatedCost = Number((ttsCost + analysisCost).toFixed(6));
    db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt) VALUES (?, ?, ?, 'prepare', 'queued', 'validating', 0, ?, ?, ?, 'CNY', ?)`).run(jobId, input.projectId, groupId, requestKey, JSON.stringify(input), estimatedCost, now());
    if (deps.runJobsInline) await prepare(jobId, groupId, input, script);
    else void runFinalEditHeavyJob(() => prepare(jobId, groupId, input, script));
    const status = (db.prepare(`SELECT status FROM final_edit_jobs WHERE id=?`).get(jobId) as { status: string }).status;
    return { id: jobId, groupId, kind: 'prepare', status };
  };

  const resumePrepareJob = async (jobId: string) => {
    const row = db.prepare(`SELECT groupId, inputSnapshotJson FROM final_edit_jobs WHERE id=? AND kind='prepare' AND status='queued'`).get(jobId) as { groupId: string; inputSnapshotJson: string } | undefined;
    if (!row) return;
    const input = parseJson<StartFinalEditInput | null>(row.inputSnapshotJson, null);
    if (!input) throw new FinalEditError('prepare_snapshot_invalid', '准备任务快照损坏');
    const script = scriptFromDb(db, input.projectId, input.scriptDraftId);
    await runFinalEditHeavyJob(() => prepare(jobId, row.groupId, input, script));
  };

  const apply = (command: FinalEditCommand): MutationResult => {
    if (command.scope === 'variant') {
      const row = db.prepare(`SELECT * FROM final_edit_variants WHERE id=?`).get(command.variantId) as Record<string, unknown> | undefined;
      if (!row) throw new FinalEditError('variant_not_found', '成片草稿不存在', 404);
      if (Number(row.revision) !== command.expectedRevision) throw new FinalEditError('revision_conflict', '草稿已被其他操作更新', 409, { expectedRevision: command.expectedRevision, currentRevision: Number(row.revision) });
      let timeline = parseJson<VideoTimeline>(String(row.timelineJson), { fps: 24, introFrames: 20, bodyFrames: 0, clips: [] });
      let bgm = parseJson<{ trackId: string | null; gainDb: number; loop: boolean; fadeOutSec: number }>(String(row.bgmJson), { trackId: null, gainDb: -16, loop: true, fadeOutSec: 0.8 });
      let cover = parseJson<{ coverKey: string | null; kind: 'storyboard_image' | 'video_keyframe' | null; sourceUrl: string | null }>(String(row.coverJson), { coverKey: null, kind: null, sourceUrl: null });
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
        if (!command.coverKey.startsWith('image:')) throw new FinalEditError('cover_not_found', '封面来源不可用', 404);
        const imageId = command.coverKey.slice('image:'.length);
        const exists = db.prepare(`SELECT 1 FROM shots s JOIN final_edit_groups g ON g.id=? WHERE s.latestGeneratedImageId=? AND s.shotSetId=g.shotSetId`).get(String(row.groupId), imageId);
        if (!exists) throw new FinalEditError('cover_not_found', '封面不属于当前分镜组', 404);
        cover = { coverKey: command.coverKey, kind: 'storyboard_image', sourceUrl: `/api/final-edit-groups/${String(row.groupId)}/cover-candidates/${encodeURIComponent(command.coverKey)}` };
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
    const cues = parseJson<SubtitleCue[]>(String(row.subtitleStateJson), []);
    const coverTitle = parseJson<{ primary: { id: 'primary'; text: string; textSource: 'script' | 'manual' }; secondary: { id: 'secondary'; text: string; textSource: 'script' | 'manual' } }>(String(row.coverTitleJson), { primary: { id: 'primary', text: '', textSource: 'script' }, secondary: { id: 'secondary', text: '', textSource: 'script' } });
    const textStyles = parseJson<FinalEditGroupView['textStyles']>(String(row.textStylesJson), buildStyles());
    if (command.type === 'set_subtitle_cue_text') {
      const cue = cues.find((item) => item.id === command.cueId);
      if (!cue) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      cue.text = command.text.replace(/[\r\n]+/g, ''); cue.textSource = 'manual';
    }
    if (command.type === 'move_subtitle_cue') {
      const cue = cues.find((item) => item.id === command.cueId);
      if (!cue) throw new FinalEditError('subtitle_not_found', '字幕不存在', 404);
      if (command.startUs < 0 || command.endUs > Number(row.narrationDurationUs) || command.endUs - command.startUs < Math.round(1_000_000 / 24)) throw new FinalEditError('subtitle_out_of_range', '字幕时间超出正文或短于一帧');
      const other = cues.find((item) => item.id !== cue.id && command.startUs < item.endUs && command.endUs > item.startUs);
      if (other) throw new FinalEditError('subtitle_overlap', '字幕时间不能重叠');
      cue.startUs = command.startUs; cue.endUs = command.endUs; cue.timingSource = 'manual';
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
    const revision = Number(row.revision) + 1;
    db.transaction(() => {
      db.prepare(`INSERT INTO final_edit_revisions (scopeKind, scopeId, revision, stateJson, commandJson, createdAt) VALUES ('group', ?, ?, ?, ?, ?)`).run(command.groupId, revision, JSON.stringify({ cues, coverTitle, textStyles }), JSON.stringify(command), now());
      db.prepare(`UPDATE final_edit_groups SET subtitleStateJson=?, coverTitleJson=?, textStylesJson=?, revision=?, updatedAt=? WHERE id=?`).run(JSON.stringify(cues), JSON.stringify(coverTitle), JSON.stringify(textStyles), revision, now(), command.groupId);
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
      const row = db.prepare(`SELECT localVideoPath FROM video_jobs WHERE id=? AND projectId=? AND shotSetId=?`).get(videoJobId, group.projectId, group.shotSetId) as { localVideoPath: string | null } | undefined;
      if (!row?.localVideoPath) throw new FinalEditError('video_file_missing', `视频素材 ${videoJobId} 缺失`);
      const clip = variant.timeline.clips.find((item) => item.videoJobId === videoJobId)!;
      return { videoJobId, relativePath: toRelative(row.localVideoPath), fingerprint: clip.sourceFingerprint };
    });
    let coverRelativePath = '';
    if (variant.cover.coverKey?.startsWith('image:')) {
      const imageId = variant.cover.coverKey.slice('image:'.length);
      const row = db.prepare(`SELECT ia.path FROM image_assets ia JOIN shots s ON s.latestGeneratedImageId=ia.id WHERE ia.id=? AND s.shotSetId=? LIMIT 1`).get(imageId, group.shotSetId) as { path: string } | undefined;
      if (!row) throw new FinalEditError('cover_missing', '封面底图缺失');
      coverRelativePath = toRelative(row.path);
    } else {
      throw new FinalEditError('cover_missing', '当前封面来源无法渲染');
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

  return { preflight, start, load, apply, enqueueRender, resumePrepareJob };
}
