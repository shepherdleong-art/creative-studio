import { createHash } from 'node:crypto';
import { splitNarrationForDisplay } from '../subtitle-display.ts';
import { splitBatchScriptSentences } from './script-sentences.ts';

/**
 * Phase E 联合分配器。
 *
 * 这个模块故意不依赖 SQLite、文件、代理或网络。调用方必须先把批次版本
 * 的冻结输入整理成 FrozenBatchInput；分配器只在内存中计算可追溯的时间线。
 * 输入和输出类型对旧的脚本计划保持了少量兼容别名，便于持久化 seam 在
 * 不同历史快照上渐进迁移。
 */

export const BATCH_ALLOCATION_RULE_VERSION = 'batch-allocation-v1';
export const BATCH_ALLOCATION_SCHEMA_VERSION = 'batch-arrangement-v1';

type JsonRecord = Record<string, unknown>;

export interface AllocationSceneInput {
  startUs: number;
  endUs: number;
  description?: string;
  labels?: string[];
  qualityScore?: number;
  quality?: number;
  semanticScore?: number;
  hookScore?: number;
}

export interface AllocationRangeInput {
  startUs: number;
  endUs: number;
  qualityScore?: number;
  quality?: number;
}

export interface AllocationAssetInput {
  assetId?: string;
  id?: string;
  analysisId?: string;
  contentFingerprint?: string;
  durationUs?: number;
  analysisJson?: unknown;
  analysis?: unknown;
  scenes?: AllocationSceneInput[];
  usableRanges?: AllocationRangeInput[] | Array<[number, number]>;
  coverFrameTimesUs?: number[];
  colorSnapshot?: unknown;
  excluded?: boolean;
}

export interface AllocationSegmentInput {
  id?: string;
  segmentId?: string;
  sentenceId?: string;
  sourceSegmentId?: string;
  text?: string;
  narration?: string;
  subtitle?: string;
  startUs?: number;
  endUs?: number;
  durationUs?: number;
  keywords?: string[];
  visualKeywords?: string[];
  semanticScores?: Record<string, number> | number[];
  scores?: Record<string, number> | number[];
  hookScores?: Record<string, number>;
  shotId?: string;
}

export interface AllocationLockInput {
  planId?: string;
  outputPlanId?: string;
  segmentId?: string;
  sentenceId?: string;
  assetId?: string;
  assetKey?: string;
  contentFingerprint?: string;
  sourceStartUs?: number;
  sourceEndUs?: number;
  startUs?: number;
  endUs?: number;
}

export interface AllocationPlanInput {
  planId?: string;
  id?: string;
  scriptSnapshotId?: string;
  title?: string;
  bodyText?: string;
  segments?: AllocationSegmentInput[];
  scriptSegments?: AllocationSegmentInput[];
  script?: JsonRecord;
  scriptSnapshot?: JsonRecord;
  planJson?: unknown;
  lockedSegments?: AllocationLockInput[];
  locks?: AllocationLockInput[];
  coverAssetIds?: string[];
  musicTrackIds?: string[];
}

export interface AllocationPresetInput {
  id?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
}

export interface FrozenBatchInput {
  projectId?: string;
  batchId?: string;
  batchVersionId?: string;
  ruleVersion?: string;
  allocationRuleVersion?: string;
  seed?: string | number;
  fps?: number;
  preset?: string | AllocationPresetInput;
  outputPreset?: string | AllocationPresetInput;
  targetDurationUs?: number;
  targetDurationSec?: number;
  defaultsJson?: unknown;
  defaults?: unknown;
  settings?: JsonRecord;
  plans?: AllocationPlanInput[];
  outputPlans?: AllocationPlanInput[];
  scripts?: AllocationPlanInput[];
  assets?: AllocationAssetInput[];
  assetPool?: AllocationAssetInput[];
  exclusions?: Array<{ assetId: string; reason?: string }>;
  excludedAssetIds?: string[];
  lockedSegments?: AllocationLockInput[];
  locks?: AllocationLockInput[];
  musicTrackIds?: string[];
  bgmTrackIds?: string[];
}

export interface AllocationClip {
  clipId: string;
  segmentId: string;
  sourceSegmentId: string;
  assetId: string;
  contentFingerprint: string;
  sourceStartUs: number;
  sourceEndUs: number;
  timelineStartUs: number;
  timelineEndUs: number;
  locked: boolean;
  reason: string;
  semanticScore: number;
  sceneIndex?: number;
}

export interface AllocationArrangement {
  schemaVersion: string;
  preset: string | AllocationPresetInput;
  fps: number;
  targetDurationUs: number;
  clips: AllocationClip[];
  cover: { assetId: string | null; timeUs: number | null };
  /** 只保存冻结色彩身份,不保存 LUT/代理路径。 */
  colorSnapshots: Record<string, unknown>;
  /** 仅占位:分配阶段不合成或验证口播。 */
  audio: { ready: boolean; productionReady: boolean; status: 'pending' | 'ready'; reason: string };
  /** 配音执行器会把占位升级为 productionReady=true 的已核验本地口播快照。 */
  narration: {
    ready: boolean;
    productionReady: boolean;
    status: 'pending' | 'ready';
    durationUs: number | null;
    reason: string;
    schemaVersion?: string;
    mode?: 'silent_placeholder' | 'local_ready';
    audioRelativePath?: string;
    audioFingerprint?: string;
    segments?: Array<{
      id: string;
      sourceSegmentId: string;
      text: string;
      startUs: number;
      endUs: number;
      timingSource?: 'estimated' | 'aligned';
    }>;
  };
  subtitle: {
    ready: boolean;
    productionReady: false;
    status: 'estimated' | 'pending';
    cues: Array<{
      id: string;
      sourceSegmentId: string;
      text: string;
      startUs: number;
      endUs: number;
      timingSource: 'estimated';
    }>;
  };
  /** 先保留轨道事实,不存路径或代理身份。 */
  music: { trackId: string | null };
  warnings: string[];
  blockers: string[];
}

export interface AllocationOutput {
  planId: string;
  scriptSnapshotId: string | null;
  title: string;
  status: 'available' | 'blocked';
  arrangement: AllocationArrangement;
  warnings: string[];
  blockers: string[];
}

export interface AllocationDifferencePair {
  leftPlanId: string;
  rightPlanId: string;
  identicalTimeline: boolean;
  sameOpening: boolean;
  sourceOverlapRatio: number;
  materialOverlapRatio: number;
  sameCover: boolean;
  sameMusic: boolean;
}

export interface AllocationSummary {
  planCount: number;
  availableCount: number;
  blockedCount: number;
  assetUsage: Record<string, number>;
  differences: AllocationDifferencePair[];
  forcedReuseCount: number;
  semanticDegradationCount: number;
}

export interface AllocationExclusion {
  assetId: string;
  reason: string;
}

export interface AllocationResult {
  schemaVersion: string;
  ruleVersion: string;
  seed: string;
  inputFingerprint: string;
  status: 'completed' | 'partial' | 'blocked';
  outputs: AllocationOutput[];
  /** 兼容消费者用语;与 outputs 同一引用语义。 */
  plans: AllocationOutput[];
  summary: AllocationSummary;
  exclusions: AllocationExclusion[];
  warnings: string[];
  blockers: string[];
}

interface NormalizedScene {
  startUs: number;
  endUs: number;
  qualityScore: number;
  labels: string[];
  index: number;
}

interface NormalizedAsset {
  assetId: string;
  analysisId: string;
  fingerprint: string;
  durationUs: number;
  scenes: NormalizedScene[];
  coverFrameTimesUs: number[];
  analysisFallback: boolean;
  colorSnapshot: unknown;
}

interface NormalizedSegment {
  id: string;
  sourceSegmentId: string;
  text: string;
  startUs: number;
  endUs: number;
  keywords: string[];
  semanticScores: Record<string, number> | number[];
  hookScores: Record<string, number>;
  shotId?: string;
}

interface NormalizedPlan {
  planId: string;
  scriptSnapshotId: string | null;
  title: string;
  targetDurationUs: number;
  segments: NormalizedSegment[];
  locks: AllocationLockInput[];
  coverAssetIds: string[];
  musicTrackIds: string[];
}

interface NormalizedInput {
  projectId: string;
  batchId: string;
  batchVersionId: string;
  ruleVersion: string;
  seed: string;
  fps: number;
  preset: string | AllocationPresetInput;
  targetDurationUs: number;
  plans: NormalizedPlan[];
  assets: NormalizedAsset[];
  exclusions: AllocationExclusion[];
  excludedAssetIds: string[];
  locks: AllocationLockInput[];
  musicTrackIds: string[];
}

interface UsedInterval {
  assetId: string;
  startUs: number;
  endUs: number;
  planId: string;
  segmentId: string;
}

interface ExistingOutput {
  planId?: string;
  scriptSnapshotId?: string | null;
  title?: string;
  status?: 'available' | 'blocked';
  warnings?: string[];
  blockers?: string[];
  arrangement?: Partial<AllocationArrangement> & { clips?: AllocationClip[]; cover?: AllocationArrangement['cover']; music?: AllocationArrangement['music'] };
  clips?: AllocationClip[];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

function nonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function stableHash(value: string): number {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function colorIdentity(value: unknown): JsonRecord {
  const record = asRecord(value);
  return {
    lutId: typeof record.lutId === 'string' ? record.lutId : null,
    lutFingerprint: typeof record.lutFingerprint === 'string' ? record.lutFingerprint : '',
    colorPipelineVersion: typeof record.colorPipelineVersion === 'string' ? record.colorPipelineVersion : 'color-v1',
    interpolation: typeof record.interpolation === 'string' ? record.interpolation : 'trilinear',
    outputContract: typeof record.outputContract === 'string' ? record.outputContract : 'sdr-v1',
  };
}

function presetIdentity(value: unknown): string | AllocationPresetInput {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    width: Number.isFinite(Number(record.width)) ? Number(record.width) : undefined,
    height: Number.isFinite(Number(record.height)) ? Number(record.height) : undefined,
    aspectRatio: typeof record.aspectRatio === 'string' ? record.aspectRatio : undefined,
  };
}

function normalizeRange(raw: unknown): AllocationRangeInput | null {
  if (Array.isArray(raw)) {
    const startUs = finite(raw[0]);
    const endUs = finite(raw[1]);
    return endUs > startUs ? { startUs, endUs } : null;
  }
  const record = asRecord(raw);
  const startUs = finite(record.startUs ?? record.start ?? record.from);
  const endUs = finite(record.endUs ?? record.end ?? record.to);
  return endUs > startUs ? {
    startUs,
    endUs,
    qualityScore: finite(record.qualityScore ?? record.quality, 0.5),
  } : null;
}

function normalizeScenes(raw: unknown, durationUs: number): NormalizedScene[] {
  const scenes: NormalizedScene[] = [];
  for (const [index, candidate] of arrayFrom(raw).entries()) {
    const range = normalizeRange(candidate);
    if (!range) continue;
    const record = asRecord(candidate);
    scenes.push({
      startUs: Math.max(0, range.startUs),
      endUs: Math.min(durationUs > 0 ? durationUs : range.endUs, range.endUs),
      qualityScore: clamp(record.qualityScore ?? record.quality ?? range.qualityScore, 0.5),
      labels: arrayFrom(record.labels).map(String).filter(Boolean),
      index,
    });
  }
  return scenes.filter((scene) => scene.endUs > scene.startUs);
}

function normalizeAsset(rawAsset: AllocationAssetInput): NormalizedAsset {
  const raw = asRecord(parseJson(rawAsset.analysisJson ?? rawAsset.analysis));
  const rawDurationUs = finite(raw.durationUs ?? raw.duration ?? rawAsset.durationUs);
  const rawScenes = rawAsset.scenes ?? arrayFrom(raw.scenes) as AllocationSceneInput[];
  const rawRanges = rawAsset.usableRanges ?? arrayFrom(raw.usableRanges) as Array<[number, number]>;
  let durationUs = Math.max(0, rawDurationUs);
  const scenes = normalizeScenes(rawScenes, durationUs || Number.MAX_SAFE_INTEGER);
  const ranges = normalizeScenes(rawRanges, durationUs || Number.MAX_SAFE_INTEGER);
  const normalizedScenes = scenes.length ? scenes : ranges;
  const analysisFallback = normalizedScenes.length === 0 && durationUs > 0;
  if (!durationUs) {
    durationUs = normalizedScenes.reduce((max, scene) => Math.max(max, scene.endUs), 0);
  }
  if (!normalizedScenes.length && durationUs > 0) {
    normalizedScenes.push({ startUs: 0, endUs: durationUs, qualityScore: 0.5, labels: [], index: 0 });
  }
  return {
    assetId: nonEmptyString(rawAsset.assetId ?? rawAsset.id),
    analysisId: nonEmptyString(rawAsset.analysisId, ''),
    fingerprint: nonEmptyString(rawAsset.contentFingerprint, ''),
    durationUs,
    scenes: normalizedScenes
      .map((scene, index) => ({ ...scene, endUs: Math.min(scene.endUs, durationUs), index }))
      .filter((scene) => scene.endUs > scene.startUs),
    coverFrameTimesUs: arrayFrom(rawAsset.coverFrameTimesUs ?? raw.coverFrameTimesUs)
      .map((value) => Math.max(0, Math.min(durationUs, Math.round(finite(value)))))
      .filter((value, index, values) => values.indexOf(value) === index),
    analysisFallback,
    colorSnapshot: colorIdentity(rawAsset.colorSnapshot ?? raw.colorSnapshot),
  };
}

/** 分配器的脚本断句唯一实现；语义匹配句段构造也用它，保证两侧句段完全一致。 */
export function splitAllocationScriptBody(body: string): string[] {
  // 去标点形态:给分配与语义匹配;句界与口播侧出自同一次切分,
  // 句数不可能再分叉(连续终止标点归前一句)。
  return splitBatchScriptSentences(body).map(({ text }) => text);
}

function splitBody(body: string): string[] {
  return splitAllocationScriptBody(body);
}

function segmentCandidates(plan: AllocationPlanInput): unknown[] {
  const fromPlanJson = asRecord(parseJson(plan.planJson));
  const script = asRecord(plan.script ?? plan.scriptSnapshot);
  const body = parseJson(plan.bodyText);
  const bodyRecord = asRecord(body);
  const candidates = [
    plan.segments,
    plan.scriptSegments,
    arrayFrom(fromPlanJson.segments) as AllocationSegmentInput[],
    arrayFrom(script.segments) as AllocationSegmentInput[],
    arrayFrom(bodyRecord.segments) as AllocationSegmentInput[],
  ].find((candidate) => Array.isArray(candidate) && candidate.length);
  if (candidates) return candidates;
  const text = typeof body === 'string' ? body : nonEmptyString(plan.bodyText);
  return splitBody(text).map((value) => ({ text: value }));
}

function normalizeSegment(raw: unknown, index: number, targetDurationUs: number, count: number, planId: string): NormalizedSegment {
  const record = asRecord(raw);
  const id = nonEmptyString(record.id ?? record.segmentId ?? record.sentenceId ?? record.sourceSegmentId, `${planId}:segment:${index + 1}`);
  const sourceSegmentId = nonEmptyString(record.sourceSegmentId, id);
  const startUs = Math.max(0, finite(record.startUs, index * targetDurationUs / Math.max(1, count)));
  const suppliedEndUs = finite(record.endUs, 0);
  const suppliedDurationUs = finite(record.durationUs, 0);
  const defaultDurationUs = targetDurationUs > 0 ? targetDurationUs / Math.max(1, count) : 2_000_000;
  const durationUs = suppliedDurationUs > 0
    ? suppliedDurationUs
    : suppliedEndUs > startUs ? suppliedEndUs - startUs : defaultDurationUs;
  const endUs = Math.max(startUs + 1, suppliedEndUs > startUs ? suppliedEndUs : startUs + durationUs);
  const rawScores = record.semanticScores ?? record.scores ?? {};
  const scoreRecord = asRecord(rawScores);
  return {
    id,
    sourceSegmentId,
    text: nonEmptyString(record.text ?? record.narration ?? record.subtitle, ''),
    startUs,
    endUs,
    keywords: arrayFrom(record.keywords ?? record.visualKeywords).map(String).filter(Boolean),
    semanticScores: Array.isArray(rawScores) ? rawScores.map((value) => finite(value)) : Object.fromEntries(Object.entries(scoreRecord).map(([key, value]) => [key, clamp(value)])),
    hookScores: Object.fromEntries(Object.entries(asRecord(record.hookScores)).map(([key, value]) => [key, clamp(value)])),
    shotId: typeof record.shotId === 'string' ? record.shotId : undefined,
  };
}

/** 从计划自身的脚本快照读目标时长；整批默认值只作兜底，历史快照没有该字段时回落默认。 */
function scriptTargetDurationUs(rawPlan: AllocationPlanInput, fallbackUs: number): number {
  const script = asRecord(rawPlan.script ?? rawPlan.scriptSnapshot);
  const targetDurationSec = finite(script.targetDurationSec, 0);
  return targetDurationSec > 0 ? Math.max(1, Math.round(targetDurationSec * 1_000_000)) : fallbackUs;
}

function normalizePlan(rawPlan: AllocationPlanInput, index: number, targetDurationUs: number): NormalizedPlan {
  const planJson = asRecord(parseJson(rawPlan.planJson));
  const planId = nonEmptyString(rawPlan.planId ?? rawPlan.id, `plan-${index + 1}`);
  const scriptSnapshotId = nonEmptyString(rawPlan.scriptSnapshotId, '') || null;
  const planTargetDurationUs = scriptTargetDurationUs(rawPlan, targetDurationUs);
  const segments = segmentCandidates(rawPlan).map((segment, segmentIndex, all) => normalizeSegment(segment, segmentIndex, planTargetDurationUs, all.length, planId));
  // renderer 只接受连续时间线。保留显式合法时间，否则按句段时长稳定地
  // 从 0 累加，避免数据库里的旧脚本空白/重叠把不合法 arrangement 传下去。
  const explicitTimelineIsContinuous = segments.length > 0
    && segments[0]?.startUs === 0
    && segments.every((segment, segmentIndex) => segmentIndex === 0 || segment.startUs === segments[segmentIndex - 1]!.endUs);
  const normalizedSegments = explicitTimelineIsContinuous
    ? segments
    : segments.reduce<NormalizedSegment[]>((result, segment) => {
      const startUs = result.at(-1)?.endUs ?? 0;
      result.push({ ...segment, startUs, endUs: startUs + Math.max(1, segment.endUs - segment.startUs) });
      return result;
    }, []);
  const locks = [...arrayFrom(rawPlan.lockedSegments), ...arrayFrom(rawPlan.locks), ...arrayFrom(planJson.lockedSegments), ...arrayFrom(planJson.locks)] as AllocationLockInput[];
  return {
    planId,
    scriptSnapshotId,
    title: nonEmptyString(rawPlan.title, ''),
    targetDurationUs: planTargetDurationUs,
    segments: normalizedSegments,
    locks,
    coverAssetIds: arrayFrom(rawPlan.coverAssetIds ?? planJson.coverAssetIds).map(String).filter(Boolean),
    musicTrackIds: arrayFrom(rawPlan.musicTrackIds ?? planJson.musicTrackIds).map(String).filter(Boolean),
  };
}

function normalizeInput(input: FrozenBatchInput): NormalizedInput {
  const defaults = { ...asRecord(parseJson(input.defaultsJson ?? input.defaults)), ...asRecord(input.settings) };
  const rawPlans = input.plans ?? input.outputPlans ?? input.scripts ?? [];
  const rawAssets = input.assets ?? input.assetPool ?? [];
  const configuredTarget = finite(input.targetDurationUs ?? defaults.targetDurationUs ?? defaults.durationUs);
  const targetDurationSec = finite(input.targetDurationSec ?? defaults.targetDurationSec);
  const targetDurationUs = configuredTarget > 0 ? configuredTarget : targetDurationSec > 0 ? Math.round(targetDurationSec * 1_000_000) : 0;
  const plans = rawPlans.map((plan, index) => normalizePlan(plan, index, targetDurationUs));
  const derivedDuration = Math.max(0, ...plans.flatMap((plan) => plan.segments.map((segment) => segment.endUs)));
  const normalizedAssets = rawAssets.map(normalizeAsset).sort((a, b) => a.assetId.localeCompare(b.assetId));
  const exclusionReasons = new Map<string, string>();
  for (const value of arrayFrom(input.exclusions)) {
    const exclusion = asRecord(value);
    const assetId = nonEmptyString(exclusion.assetId);
    if (assetId) exclusionReasons.set(assetId, nonEmptyString(exclusion.reason));
  }
  for (const assetId of arrayFrom(input.excludedAssetIds).map(String)) {
    if (assetId && !exclusionReasons.has(assetId)) exclusionReasons.set(assetId, '');
  }
  for (const asset of rawAssets.filter((entry) => entry.excluded)) {
    const assetId = nonEmptyString(asset.assetId ?? asset.id);
    if (assetId && !exclusionReasons.has(assetId)) exclusionReasons.set(assetId, '');
  }
  const exclusions = [...exclusionReasons]
    .map(([assetId, reason]) => ({ assetId, reason }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const excludedAssetIds = exclusions.map(({ assetId }) => assetId);
  return {
    projectId: nonEmptyString(input.projectId),
    batchId: nonEmptyString(input.batchId),
    batchVersionId: nonEmptyString(input.batchVersionId),
    ruleVersion: nonEmptyString(input.ruleVersion ?? input.allocationRuleVersion, BATCH_ALLOCATION_RULE_VERSION),
    seed: String(input.seed ?? '0'),
    fps: Math.max(1, finite(input.fps ?? defaults.fps, 24)),
    preset: presetIdentity(input.preset ?? input.outputPreset ?? nonEmptyString(defaults.preset ?? defaults.outputPreset, '9:16')),
    targetDurationUs: Math.max(derivedDuration, targetDurationUs),
    plans,
    assets: normalizedAssets,
    exclusions,
    excludedAssetIds,
    locks: [...arrayFrom(input.lockedSegments), ...arrayFrom(input.locks)] as AllocationLockInput[],
    musicTrackIds: arrayFrom(input.musicTrackIds ?? input.bgmTrackIds).map(String).filter(Boolean).sort(),
  };
}

function semanticScore(segment: NormalizedSegment, asset: NormalizedAsset, scene: NormalizedScene): number {
  const scores = segment.semanticScores;
  let score = 0;
  if (Array.isArray(scores)) score = finite(scores[scene.index], 0);
  else score = finite(scores[asset.assetId] ?? scores[`${asset.assetId}:${scene.index}`], 0);
  if (!score && segment.keywords.length && scene.labels.length) {
    const labels = scene.labels.map((value) => value.toLocaleLowerCase());
    const matched = segment.keywords.filter((keyword) => labels.some((label) => label.includes(keyword.toLocaleLowerCase()) || keyword.toLocaleLowerCase().includes(label)));
    score = matched.length / Math.max(1, segment.keywords.length);
  }
  return clamp(score || scene.qualityScore * 0.5);
}

function hookScore(segment: NormalizedSegment, asset: NormalizedAsset, scene: NormalizedScene): number {
  return clamp(segment.hookScores[asset.assetId] ?? segment.hookScores[`${asset.assetId}:${scene.index}`] ?? 0);
}

function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function intervalOverlaps(interval: { assetId: string; startUs: number; endUs: number }, used: UsedInterval[]): UsedInterval[] {
  return used.filter((entry) => entry.assetId === interval.assetId && overlapLength(interval.startUs, interval.endUs, entry.startUs, entry.endUs) > 0);
}

/** 场景范围内未被已用区间占用的空闲子区间(按起点升序)。 */
function freeSubIntervals(scene: NormalizedScene, used: UsedInterval[]): Array<[number, number]> {
  const free: Array<[number, number]> = [];
  let cursor = scene.startUs;
  for (const entry of used
    .filter((entry) => overlapLength(scene.startUs, scene.endUs, entry.startUs, entry.endUs) > 0)
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs)) {
    const start = Math.max(scene.startUs, entry.startUs);
    const end = Math.min(scene.endUs, entry.endUs);
    if (start > cursor) free.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (scene.endUs > cursor) free.push([cursor, scene.endUs]);
  return free.filter(([start, end]) => end - start > 0);
}

function lockForSegment(plan: NormalizedPlan, segment: NormalizedSegment, globalLocks: AllocationLockInput[]): AllocationLockInput | undefined {
  return [...plan.locks, ...globalLocks].find((lock) => {
    const lockPlanId = lock.planId ?? lock.outputPlanId;
    return (!lockPlanId || lockPlanId === plan.planId)
      && [segment.id, segment.sourceSegmentId].includes(lock.segmentId ?? lock.sentenceId ?? '');
  });
}

function normalizeExistingOutputs(value: unknown): ExistingOutput[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as JsonRecord;
  const outputs = Array.isArray(record.outputs) ? record.outputs : Array.isArray(record.plans) ? record.plans : Array.isArray(value) ? value : [];
  return outputs.map((output) => {
    const item = asRecord(output);
    return {
      planId: nonEmptyString(item.planId ?? item.id),
      scriptSnapshotId: typeof item.scriptSnapshotId === 'string' ? item.scriptSnapshotId : null,
      title: typeof item.title === 'string' ? item.title : '',
      status: item.status === 'blocked' ? 'blocked' : 'available',
      warnings: arrayFrom(item.warnings).map(String),
      blockers: arrayFrom(item.blockers).map(String),
      arrangement: asRecord(item.arrangement) as ExistingOutput['arrangement'],
      clips: arrayFrom(item.clips) as AllocationClip[],
    };
  });
}

function createArrangement(
  normalized: NormalizedInput,
  plan: NormalizedPlan,
  clips: AllocationClip[],
  cover: { assetId: string | null; timeUs: number | null },
  musicTrackId: string | null,
  warnings: string[],
  blockers: string[],
): AllocationArrangement {
  const preset = normalized.preset;
  const uniqueWarnings = [...new Set(warnings)].sort();
  const uniqueBlockers = [...new Set(blockers)].sort();
  const segmentById = new Map(plan.segments.flatMap((segment) => [
    [segment.id, segment] as const,
    [segment.sourceSegmentId, segment] as const,
  ]));
  const clipsBySegment = new Map<string, AllocationClip[]>();
  for (const clip of clips) {
    const group = clipsBySegment.get(clip.sourceSegmentId) ?? [];
    group.push(clip);
    clipsBySegment.set(clip.sourceSegmentId, group);
  }
  // 字幕按句段切一次:同一 sourceSegmentId 的多个 clip(句段内拼接)合并
  // timeline 窗口,整句只切一次 cue,不会按 chunk 重复显示整句。
  const subtitleCues = [...clipsBySegment.entries()].flatMap(([sourceSegmentId, segmentClips]) => {
    const segment = segmentById.get(sourceSegmentId) ?? segmentById.get(segmentClips[0]!.segmentId);
    if (!segment?.text.trim()) return [];
    const parts = splitNarrationForDisplay(segment.text, { maxContentCharacters: 16 });
    if (parts.length === 0) return [];
    const weights = parts.map((part) => Math.max(1, Array.from(part.displayText.replace(/\s+/gu, '')).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const windowStartUs = Math.min(...segmentClips.map((clip) => clip.timelineStartUs));
    const windowEndUs = Math.max(...segmentClips.map((clip) => clip.timelineEndUs));
    const durationUs = windowEndUs - windowStartUs;
    let cursorUs = windowStartUs;
    return parts.map((part, index) => {
      const endUs = index === parts.length - 1
        ? windowEndUs
        : Math.max(cursorUs + 1, Math.round(cursorUs + durationUs * weights[index]! / totalWeight));
      const cue = {
        id: `subtitle:${segmentClips[0]!.clipId}:${index + 1}`,
        sourceSegmentId,
        text: part.displayText,
        startUs: cursorUs,
        endUs,
        timingSource: 'estimated' as const,
      };
      cursorUs = endUs;
      return cue;
    });
  });
  return {
    schemaVersion: BATCH_ALLOCATION_SCHEMA_VERSION,
    preset,
    fps: normalized.fps,
    targetDurationUs: plan.targetDurationUs,
    clips,
    cover,
    colorSnapshots: Object.fromEntries(normalized.assets
      .filter((asset) => clips.some((clip) => clip.assetId === asset.assetId))
      .map((asset) => [asset.assetId, asset.colorSnapshot])),
    audio: { ready: false, productionReady: false, status: 'pending', reason: '联合分配只登记画面，尚未合成口播音频' },
    narration: { ready: false, productionReady: false, status: 'pending', durationUs: null, reason: '联合分配只登记画面，尚未合成或核验口播时长' },
    subtitle: {
      ready: subtitleCues.length > 0,
      productionReady: false,
      status: subtitleCues.length > 0 ? 'estimated' : 'pending',
      cues: subtitleCues,
    },
    music: { trackId: musicTrackId },
    warnings: uniqueWarnings,
    blockers: uniqueBlockers,
  };
}

interface StitchCandidate {
  asset: NormalizedAsset;
  scene: NormalizedScene;
  startUs: number;
  lengthUs: number;
  score: number;
  tie: number;
}

/**
 * 句段内拼接兜底:单区间装不下句段时,用语义最佳的场景 chunk 连续填满句段
 * 时间线(与单条混剪的多镜头拼接一致)。打分沿用单区间公式;空闲区间耗尽
 * 后允许一轮重叠兜底,与单区间路径的容忍语义一致。只在素材池有场景时调用,
 * 因此总能填满;填满后登记 stitched-segment 警告。
 */
function stitchSegment(
  normalized: NormalizedInput,
  plan: NormalizedPlan,
  segment: NormalizedSegment,
  segmentIndex: number,
  availableAssets: NormalizedAsset[],
  usedIntervals: UsedInterval[],
  usedOpeningAssets: Set<string>,
  clips: AllocationClip[],
  warnings: string[],
): void {
  const durationUs = Math.max(1, segment.endUs - segment.startUs);
  let filledUs = 0;
  let part = 0;
  let overlapFallbackUsed = false;
  while (filledUs < durationUs) {
    const remainingUs = durationUs - filledUs;
    const candidates: StitchCandidate[] = [];
    for (const ignoreUsed of [false, true]) {
      if (ignoreUsed && overlapFallbackUsed) continue;
      for (const asset of availableAssets) {
        for (const scene of asset.scenes) {
          const used = ignoreUsed ? [] : usedIntervals.filter((entry) => entry.assetId === asset.assetId);
          for (const [subStartUs, subEndUs] of freeSubIntervals(scene, used)) {
            const lengthUs = Math.min(remainingUs, subEndUs - subStartUs);
            if (lengthUs <= 0) continue;
            const overlap = ignoreUsed
              ? intervalOverlaps({ assetId: asset.assetId, startUs: subStartUs, endUs: subStartUs + lengthUs }, usedIntervals)
                .reduce((sum, entry) => sum + overlapLength(subStartUs, subStartUs + lengthUs, entry.startUs, entry.endUs), 0)
              : 0;
            const semantic = semanticScore(segment, asset, scene);
            const hook = segmentIndex === 0 && part === 0 ? hookScore(segment, asset, scene) : 0;
            const sameOpening = segmentIndex === 0 && part === 0 && usedOpeningAssets.has(asset.assetId);
            const reuseCount = usedIntervals.filter((entry) => entry.assetId === asset.assetId).length;
            candidates.push({
              asset,
              scene,
              startUs: subStartUs,
              lengthUs,
              score: semantic * 100 + hook * 8 + scene.qualityScore * 2 - reuseCount * 3 - overlap / Math.max(1, remainingUs) * 30 - (sameOpening ? 20 : 0),
              tie: stableHash(`${normalized.seed}:${plan.planId}:${segment.id}:${asset.assetId}:${scene.index}:part:${part}`),
            });
          }
        }
      }
      if (candidates.length) {
        if (ignoreUsed) overlapFallbackUsed = true;
        break;
      }
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => b.score - a.score || b.lengthUs - a.lengthUs || a.tie - b.tie || a.asset.assetId.localeCompare(b.asset.assetId) || a.startUs - b.startUs);
    const chunk = candidates[0]!;
    part += 1;
    const clip: AllocationClip = {
      clipId: `${plan.planId}:clip:${segment.id}:part:${part}`,
      segmentId: segment.id,
      sourceSegmentId: segment.sourceSegmentId,
      assetId: chunk.asset.assetId,
      contentFingerprint: chunk.asset.fingerprint,
      sourceStartUs: chunk.startUs,
      sourceEndUs: chunk.startUs + chunk.lengthUs,
      timelineStartUs: segment.startUs + filledUs,
      timelineEndUs: segment.startUs + filledUs + chunk.lengthUs,
      locked: false,
      reason: 'semantic_stitch_fallback',
      semanticScore: semanticScore(segment, chunk.asset, chunk.scene),
      sceneIndex: chunk.scene.index,
    };
    clips.push(clip);
    usedIntervals.push({ assetId: chunk.asset.assetId, startUs: clip.sourceStartUs, endUs: clip.sourceEndUs, planId: plan.planId, segmentId: segment.id });
    if (segmentIndex === 0) usedOpeningAssets.add(chunk.asset.assetId);
    filledUs += chunk.lengthUs;
  }
  if (overlapFallbackUsed) warnings.push(`source-overlap:${segment.id}`);
  if (filledUs >= durationUs) warnings.push(`stitched-segment:${segment.id}`);
}

function assignOne(
  normalized: NormalizedInput,
  plan: NormalizedPlan,
  planIndex: number,
  usedIntervals: UsedInterval[],
  usedOpeningAssets: Set<string>,
  fixedOutputs: ExistingOutput[],
): AllocationOutput {
  const availableAssets = normalized.assets.filter((asset) => !normalized.excludedAssetIds.includes(asset.assetId));
  const assetById = new Map(normalized.assets.map((asset) => [asset.assetId, asset]));
  const warnings: string[] = [];
  const blockers: string[] = [];
  const clips: AllocationClip[] = [];
  const planLocks = plan.locks;

  if (plan.segments.length === 0) blockers.push('script-segments-missing');

  for (const asset of availableAssets) {
    if (asset.analysisFallback) warnings.push(`analysis-fallback:${asset.assetId}`);
  }

  const knownSegmentIds = new Set(plan.segments.map((segment) => segment.id));
  for (const lock of [...planLocks, ...normalized.locks]) {
    const lockPlanId = lock.planId ?? lock.outputPlanId;
    if ((lockPlanId == null || lockPlanId === plan.planId)
      && !knownSegmentIds.has(lock.segmentId ?? lock.sentenceId ?? '')) {
      blockers.push(`locked-conflict:${lock.segmentId ?? lock.sentenceId ?? 'unknown'}`);
    }
  }

  const fixedForPlan = fixedOutputs.find((output) => output.planId === plan.planId);
  const fixedClips = fixedForPlan?.arrangement?.clips ?? fixedForPlan?.clips ?? [];
  if (fixedClips.length) {
    for (const clip of fixedClips) {
      if (!clip.assetId) continue;
      usedIntervals.push({ assetId: clip.assetId, startUs: clip.sourceStartUs, endUs: clip.sourceEndUs, planId: plan.planId, segmentId: clip.segmentId });
      if (clip.timelineStartUs === 0) usedOpeningAssets.add(clip.assetId);
    }
  }

  for (const [segmentIndex, segment] of plan.segments.entries()) {
    const durationUs = Math.max(1, segment.endUs - segment.startUs);
    const lock = lockForSegment(plan, segment, normalized.locks);
    if (lock) {
      const lockAssetId = lock.assetId ?? lock.assetKey ?? '';
      const asset = assetById.get(lockAssetId);
      const sourceStartUs = finite(lock.sourceStartUs ?? lock.startUs, -1);
      const sourceEndUs = finite(lock.sourceEndUs ?? lock.endUs, -1);
      const validAsset = asset && !normalized.excludedAssetIds.includes(lockAssetId);
      const validRange = validAsset && sourceStartUs >= 0 && sourceEndUs > sourceStartUs
        && sourceEndUs - sourceStartUs === durationUs
        && sourceEndUs <= asset.durationUs
        && asset.scenes.some((scene) => sourceStartUs >= scene.startUs && sourceEndUs <= scene.endUs);
      if (!validAsset || !validRange) {
        blockers.push(`locked-conflict:${segment.id}`);
        continue;
      }
      if (lock.contentFingerprint && asset.fingerprint && lock.contentFingerprint !== asset.fingerprint) {
        blockers.push(`locked-content-changed:${segment.id}`);
        continue;
      }
      const existingLockOverlap = intervalOverlaps({ assetId: asset.assetId, startUs: sourceStartUs, endUs: sourceEndUs }, usedIntervals)
        .some((entry) => entry.planId !== plan.planId || entry.segmentId !== segment.id);
      if (existingLockOverlap) {
        blockers.push(`locked-overlap:${segment.id}`);
        continue;
      }
      const clip: AllocationClip = {
        clipId: `${plan.planId}:clip:${segment.id}`,
        segmentId: segment.id,
        sourceSegmentId: segment.sourceSegmentId,
        assetId: asset.assetId,
        contentFingerprint: asset.fingerprint,
        sourceStartUs,
        sourceEndUs,
        timelineStartUs: segment.startUs,
        timelineEndUs: segment.endUs,
        locked: true,
        reason: 'manual_lock',
        semanticScore: semanticScore(segment, asset, asset.scenes[0] ?? { startUs: sourceStartUs, endUs: sourceEndUs, qualityScore: 0.5, labels: [], index: 0 }),
      };
      clips.push(clip);
      usedIntervals.push({ assetId: asset.assetId, startUs: sourceStartUs, endUs: sourceEndUs, planId: plan.planId, segmentId: segment.id });
      if (segmentIndex === 0) usedOpeningAssets.add(asset.assetId);
      continue;
    }

    const candidates: Array<{ asset: NormalizedAsset; scene: NormalizedScene; startUs: number; endUs: number; score: number; overlap: number; sameOpening: boolean; tie: number }> = [];
    for (const asset of availableAssets) {
      for (const scene of asset.scenes) {
        if (scene.endUs - scene.startUs < durationUs || asset.durationUs < durationUs) continue;
        const maxStart = scene.endUs - durationUs;
        const base = scene.startUs + Math.max(0, Math.floor((maxStart - scene.startUs) / 2));
        const starts = [scene.startUs, base, maxStart, scene.startUs + (stableHash(`${normalized.seed}:${plan.planId}:${segment.id}:${asset.assetId}:${scene.index}`) % Math.max(1, Math.floor(maxStart - scene.startUs + 1)))];
        for (const startUs of [...new Set(starts.map((value) => Math.max(scene.startUs, Math.min(maxStart, Math.round(value)))))]) {
          const endUs = startUs + durationUs;
          const overlaps = intervalOverlaps({ assetId: asset.assetId, startUs, endUs }, usedIntervals);
          const overlap = overlaps.reduce((sum, entry) => sum + overlapLength(startUs, endUs, entry.startUs, entry.endUs), 0);
          const semantic = semanticScore(segment, asset, scene);
          const hook = segmentIndex === 0 ? hookScore(segment, asset, scene) : 0;
          const sameOpening = segmentIndex === 0 && usedOpeningAssets.has(asset.assetId);
          const reuseCount = usedIntervals.filter((entry) => entry.assetId === asset.assetId).length;
          candidates.push({
            asset,
            scene,
            startUs,
            endUs,
            score: semantic * 100 + hook * 8 + scene.qualityScore * 2 - reuseCount * 3 - overlap / Math.max(1, durationUs) * 30 - (sameOpening ? 20 : 0),
            overlap,
            sameOpening,
            tie: stableHash(`${normalized.seed}:${plan.planId}:${segment.id}:${asset.assetId}:${scene.index}:${startUs}`),
          });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.overlap - b.overlap || a.tie - b.tie || a.asset.assetId.localeCompare(b.asset.assetId) || a.startUs - b.startUs);
    const candidate = candidates.find((entry) => entry.overlap === 0) ?? candidates[0];
    if (!candidate) {
      // 单区间装不下句段:素材池全空/无场景才保留 blocker,否则句段内拼接兜底。
      const poolEmpty = availableAssets.length === 0 || availableAssets.every((asset) => asset.scenes.length === 0);
      if (poolEmpty) {
        blockers.push(`no-legal-media:${segment.id}`);
        continue;
      }
      stitchSegment(normalized, plan, segment, segmentIndex, availableAssets, usedIntervals, usedOpeningAssets, clips, warnings);
      continue;
    }
    const semantic = semanticScore(segment, candidate.asset, candidate.scene);
    const reason = candidate.overlap > 0
      ? 'reuse-overlap-fallback'
      : semantic < 0.35
        ? 'semantic-backoff'
        : candidate.sameOpening
          ? 'opening-reuse-fallback'
          : 'semantic_primary';
    if (candidate.overlap > 0) warnings.push(`source-overlap:${segment.id}`);
    if (semantic < 0.35) warnings.push(`semantic-degraded:${segment.id}`);
    if (candidate.sameOpening) warnings.push(`opening-reused:${segment.id}`);
    const clip: AllocationClip = {
      clipId: `${plan.planId}:clip:${segment.id}`,
      segmentId: segment.id,
      sourceSegmentId: segment.sourceSegmentId,
      assetId: candidate.asset.assetId,
      contentFingerprint: candidate.asset.fingerprint,
      sourceStartUs: candidate.startUs,
      sourceEndUs: candidate.endUs,
      timelineStartUs: segment.startUs,
      timelineEndUs: segment.endUs,
      locked: false,
      reason,
      semanticScore: semantic,
      sceneIndex: candidate.scene.index,
    };
    clips.push(clip);
    usedIntervals.push({ assetId: candidate.asset.assetId, startUs: candidate.startUs, endUs: candidate.endUs, planId: plan.planId, segmentId: segment.id });
    if (segmentIndex === 0) usedOpeningAssets.add(candidate.asset.assetId);
  }

  const coverCandidates = plan.coverAssetIds.length ? plan.coverAssetIds : availableAssets.map((asset) => asset.assetId);
  const coverPool = coverCandidates
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is NormalizedAsset => Boolean(asset))
    .sort((a, b) => {
      const aUsed = usedOpeningAssets.has(a.assetId) ? 1 : 0;
      const bUsed = usedOpeningAssets.has(b.assetId) ? 1 : 0;
      return aUsed - bUsed || a.assetId.localeCompare(b.assetId);
    });
  const coverAsset = coverPool.length ? coverPool[planIndex % coverPool.length] : undefined;
  const coverTimeUs = coverAsset
    ? (coverAsset.coverFrameTimesUs[planIndex % Math.max(1, coverAsset.coverFrameTimesUs.length)] ?? Math.min(coverAsset.durationUs, Math.max(0, Math.round(coverAsset.durationUs * 0.15))))
    : null;
  if (!coverAsset) warnings.push('cover-unavailable');
  const musicPool = plan.musicTrackIds.length ? plan.musicTrackIds : normalized.musicTrackIds;
  const musicTrackId = musicPool.length ? musicPool[planIndex % musicPool.length] ?? null : null;
  const arrangement = createArrangement(normalized, plan, clips, { assetId: coverAsset?.assetId ?? null, timeUs: coverTimeUs }, musicTrackId, warnings, blockers);
  return {
    planId: plan.planId,
    scriptSnapshotId: plan.scriptSnapshotId,
    title: plan.title,
    status: arrangement.blockers.length ? 'blocked' : 'available',
    arrangement,
    warnings: arrangement.warnings,
    blockers: arrangement.blockers,
  };
}

function differenceSummary(outputs: AllocationOutput[]): AllocationDifferencePair[] {
  const differences: AllocationDifferencePair[] = [];
  for (let leftIndex = 0; leftIndex < outputs.length; leftIndex += 1) {
    const left = outputs[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < outputs.length; rightIndex += 1) {
      const right = outputs[rightIndex];
      const leftClips = left.arrangement.clips;
      const rightClips = right.arrangement.clips;
      const comparable = Math.min(leftClips.length, rightClips.length);
      const sameTimelineCount = leftClips.filter((clip, index) => {
        const other = rightClips[index];
        return Boolean(other && clip.assetId === other.assetId && clip.sourceStartUs === other.sourceStartUs && clip.sourceEndUs === other.sourceEndUs);
      }).length;
      const overlapTotal = leftClips.reduce((sum, clip, index) => {
        const other = rightClips[index];
        return sum + (other && clip.assetId === other.assetId ? overlapLength(clip.sourceStartUs, clip.sourceEndUs, other.sourceStartUs, other.sourceEndUs) : 0);
      }, 0);
      const leftDuration = leftClips.reduce((sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs, 0);
      const rightDuration = rightClips.reduce((sum, clip) => sum + clip.sourceEndUs - clip.sourceStartUs, 0);
      const materialSetLeft = new Set(leftClips.map((clip) => clip.assetId));
      const materialSetRight = new Set(rightClips.map((clip) => clip.assetId));
      const union = new Set([...materialSetLeft, ...materialSetRight]);
      const intersection = [...materialSetLeft].filter((assetId) => materialSetRight.has(assetId)).length;
      differences.push({
        leftPlanId: left.planId,
        rightPlanId: right.planId,
        identicalTimeline: comparable > 0 && sameTimelineCount === comparable && leftClips.length === rightClips.length,
        sameOpening: leftClips[0]?.assetId === rightClips[0]?.assetId && leftClips[0]?.sourceStartUs === rightClips[0]?.sourceStartUs,
        sourceOverlapRatio: Math.min(1, overlapTotal / Math.max(1, Math.max(leftDuration, rightDuration))),
        materialOverlapRatio: union.size ? intersection / union.size : 0,
        sameCover: left.arrangement.cover.assetId === right.arrangement.cover.assetId && left.arrangement.cover.timeUs === right.arrangement.cover.timeUs,
        sameMusic: left.arrangement.music.trackId === right.arrangement.music.trackId,
      });
    }
  }
  return differences;
}

function buildResult(normalized: NormalizedInput, outputs: AllocationOutput[]): AllocationResult {
  const differences = differenceSummary(outputs);
  const assetUsage: Record<string, number> = {};
  let forcedReuseCount = 0;
  let semanticDegradationCount = 0;
  for (const output of outputs) {
    for (const clip of output.arrangement.clips) {
      assetUsage[clip.assetId] = (assetUsage[clip.assetId] ?? 0) + 1;
      if (clip.reason.includes('reuse') || clip.reason.includes('overlap')) forcedReuseCount += 1;
      if (clip.reason.includes('degraded') || clip.reason.includes('backoff')) semanticDegradationCount += 1;
    }
  }
  const warnings = [...new Set(outputs.flatMap((output) => output.warnings))].sort();
  const blockers = [...new Set(outputs.flatMap((output) => output.blockers))].sort();
  const availableCount = outputs.filter((output) => output.status === 'available').length;
  return {
    schemaVersion: BATCH_ALLOCATION_SCHEMA_VERSION,
    ruleVersion: normalized.ruleVersion,
    seed: normalized.seed,
    inputFingerprint: digest({
      projectId: normalized.projectId,
      batchId: normalized.batchId,
      batchVersionId: normalized.batchVersionId,
      ruleVersion: normalized.ruleVersion,
      seed: normalized.seed,
      fps: normalized.fps,
      preset: normalized.preset,
      targetDurationUs: normalized.targetDurationUs,
      plans: normalized.plans,
      assets: normalized.assets,
      exclusions: normalized.exclusions,
      locks: normalized.locks,
      musicTrackIds: normalized.musicTrackIds,
    }),
    status: blockers.length === 0 ? 'completed' : availableCount > 0 ? 'partial' : 'blocked',
    outputs,
    plans: outputs,
    summary: {
      planCount: outputs.length,
      availableCount,
      blockedCount: outputs.length - availableCount,
      assetUsage: Object.fromEntries(Object.entries(assetUsage).sort(([left], [right]) => left.localeCompare(right))),
      differences,
      forcedReuseCount,
      semanticDegradationCount,
    },
    exclusions: normalized.exclusions,
    warnings,
    blockers,
  };
}

function scoreWholeBatch(outputs: AllocationOutput[]): number {
  const available = outputs.filter(({ status }) => status === 'available').length;
  const blockerCount = outputs.reduce((sum, output) => sum + output.blockers.length, 0);
  const warningCount = outputs.reduce((sum, output) => sum + output.warnings.length, 0);
  const semantic = outputs.reduce((sum, output) => (
    sum + output.arrangement.clips.reduce((clipSum, clip) => clipSum + clip.semanticScore, 0)
  ), 0);
  const overlapUs = outputs.reduce((sum, output) => sum + output.arrangement.clips
    .filter(({ reason }) => reason.includes('overlap'))
    .reduce((clipSum, clip) => clipSum + clip.sourceEndUs - clip.sourceStartUs, 0), 0);
  // 可用条数和合法性是硬目标；其后才比较整批语义质量与降级/复用。
  return available * 1_000_000_000
    - blockerCount * 100_000_000
    + Math.round(semantic * 1_000_000)
    - warningCount * 10_000
    - Math.round(overlapUs / 1_000);
}

function candidatePlanOrders(plans: NormalizedPlan[]): NormalizedPlan[][] {
  if (plans.length <= 1) return [plans];
  const candidates: NormalizedPlan[][] = [];
  const seen = new Set<string>();
  const add = (candidate: NormalizedPlan[]) => {
    const identity = candidate.map(({ planId }) => planId).join('\u0000');
    if (!seen.has(identity)) {
      seen.add(identity);
      candidates.push(candidate);
    }
  };
  add(plans);
  add([...plans].reverse());
  // 小批次穷举计划顺序，避免先处理的计划抢走后续计划唯一的高质量素材。
  // 大批次采用所有轮转及其逆序，保持有界成本，同时仍在整批得分后择优。
  if (plans.length <= 6) {
    const permute = (prefix: NormalizedPlan[], remaining: NormalizedPlan[]) => {
      if (remaining.length === 0) {
        add(prefix);
        return;
      }
      for (let index = 0; index < remaining.length; index += 1) {
        permute([...prefix, remaining[index]!], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
      }
    };
    permute([], plans);
  } else {
    for (let index = 1; index < plans.length; index += 1) {
      const rotated = [...plans.slice(index), ...plans.slice(0, index)];
      add(rotated);
      add([...rotated].reverse());
    }
  }
  return candidates;
}

/** 全批一次展开并求优,所有计划共享素材/区间/开头使用账本。 */
export function allocateBatch(input: FrozenBatchInput): AllocationResult {
  const normalized = normalizeInput(input);
  const fixedOutputs = normalizeExistingOutputs((input as JsonRecord).currentAllocation ?? (input as JsonRecord).existingAllocation);
  const originalIndex = new Map(normalized.plans.map((plan, index) => [plan.planId, index]));
  let best: { score: number; identity: string; outputs: AllocationOutput[] } | null = null;
  for (const planOrder of candidatePlanOrders(normalized.plans)) {
    const usedIntervals: UsedInterval[] = [];
    const usedOpeningAssets = new Set<string>();
    const assigned = planOrder.map((plan) => assignOne(
      normalized,
      plan,
      originalIndex.get(plan.planId) ?? 0,
      usedIntervals,
      usedOpeningAssets,
      fixedOutputs,
    ));
    const byPlan = new Map(assigned.map((output) => [output.planId, output]));
    const outputs = normalized.plans.map((plan) => byPlan.get(plan.planId)!);
    const score = scoreWholeBatch(outputs);
    const identity = planOrder.map(({ planId }) => planId).join('\u0000');
    if (!best || score > best.score || (score === best.score && identity < best.identity)) {
      best = { score, identity, outputs };
    }
  }
  return buildResult(normalized, best?.outputs ?? []);
}

/**
 * 单条重分配:currentAllocation 中的非目标计划作为固定占用,只重算目标计划。
 * 返回仍包含完整批次结果,便于页面显示差异;持久化 seam 只应写入 targetOutputPlanId。
 */
export function reallocateOutput(
  input: FrozenBatchInput,
  currentAllocation: AllocationResult | unknown,
  targetOutputPlanId: string,
  reason?: string,
): AllocationResult {
  // The reason is audit context owned by the persistence layer; allocation
  // remains a pure function of the frozen input and seed.
  void reason;
  const currentOutputs = normalizeExistingOutputs(currentAllocation);
  const targetCurrentOutput = currentOutputs.find((output) => output.planId === targetOutputPlanId);
  const retainedLocks = (targetCurrentOutput?.arrangement?.clips ?? targetCurrentOutput?.clips ?? [])
    .filter((clip) => clip.locked)
    .map((clip) => ({
      planId: targetOutputPlanId,
      segmentId: clip.segmentId,
      assetId: clip.assetId,
      contentFingerprint: clip.contentFingerprint,
      sourceStartUs: clip.sourceStartUs,
      sourceEndUs: clip.sourceEndUs,
    }));
  const normalized = normalizeInput({
    ...input,
    lockedSegments: [...(input.lockedSegments ?? input.locks ?? []), ...retainedLocks],
  });
  const fixedOutputs = currentOutputs.filter((output) => output.planId !== targetOutputPlanId);
  const targetPlans = normalized.plans.filter((plan) => plan.planId === targetOutputPlanId);
  if (!targetPlans.length) {
    const result = buildResult(normalized, []);
    return {
      ...result,
      status: 'blocked',
      blockers: [`plan-not-found:${targetOutputPlanId}`],
    };
  }
  const usedIntervals: UsedInterval[] = [];
  const usedOpeningAssets = new Set<string>();
  // 其他计划固定,不让目标计划的旧版本再额外占用一次区间。
  for (const output of fixedOutputs) {
    for (const clip of output.arrangement?.clips ?? output.clips ?? []) {
      usedIntervals.push({ assetId: clip.assetId, startUs: clip.sourceStartUs, endUs: clip.sourceEndUs, planId: output.planId ?? '', segmentId: clip.segmentId });
      if (clip.timelineStartUs === 0) usedOpeningAssets.add(clip.assetId);
    }
  }
  const target = assignOne(normalized, targetPlans[0], normalized.plans.findIndex((plan) => plan.planId === targetOutputPlanId), usedIntervals, usedOpeningAssets, []);
  const outputs = normalized.plans
    .map((plan) => plan.planId === targetOutputPlanId
      ? target
      : fixedOutputs.find((output) => output.planId === plan.planId) as AllocationOutput | undefined)
    .filter((output): output is AllocationOutput => Boolean(output));
  return buildResult(normalized, outputs);
}

export function allocationInputFingerprint(input: FrozenBatchInput): string {
  return allocateBatch(input).inputFingerprint;
}
