/** 成片包装 v2 共享契约与数据库 JSON 字段的运行时解析。 */

export interface BgmConfig { path: string; volume: number; ducking: boolean }
export type CoverTemplateId = 'luxury-01' | 'minimal-01' | 'luxury-02';
export interface CoverConfig {
  titleText: string; titleSize: number; titleColor: string; introDurationSec: number;
  templateId?: CoverTemplateId; sellingPoints?: string[];
}
export interface SubtitleStyle {
  enabled: boolean; fontSize: number; color: string; strokeColor: string;
  strokeWidth: number; marginBottomPct: number;
}
export interface PackageCommonConfig {
  outputName: string; width: number; height: number; fps: number;
  targetDurationSec: number; durationTolerancePct: number; maxClipSeconds: number;
  bgm: BgmConfig | null; cover: CoverConfig; subtitle: SubtitleStyle;
}
export type PackageConfig =
  | (PackageCommonConfig & { mode: 'narration'; narration: { mode: 'tts'; providerId: string; voice: string; speed: number } })
  | (PackageCommonConfig & { mode: 'bgm-only'; narration: { mode: 'none' } });

export interface FinalVideoWorkflowConfig {
  packageConfig: PackageConfig;
  narrationScriptProviderId: string;
  visionProviderId: string;
  orchestrationProviderId: string;
  selectedClipIds: string[];
}
export interface NarrationDraftBeat { beatId: string; groupId: string; index: number; text: string }
export interface NarrationBeat extends NarrationDraftBeat { audioPath: string; durationSec: number; startSec: number }
export interface ClipPoolItem {
  clipId: string; shotId: string; shotIndex: number; videoPath: string; clipDurationSec: number;
  sourceImageId: string; sourceImagePath: string; visualDescription: string;
  descriptionProviderId: string | null; descriptionModel: string | null;
}
export interface ArrangementAssignment { assignmentId: string; clipId: string; beatIds: string[] }
export interface ArrangementGap { beatId: string; reason: string }
export interface ArrangementPlan { assignments: ArrangementAssignment[]; gaps: ArrangementGap[] }
export type TimelineIssueCode =
  | 'target_duration_out_of_tolerance' | 'arrangement_invalid' | 'arrangement_fallback_used'
  | 'visual_gap' | 'clip_missing' | 'clip_short_borrowed_forward' | 'last_clip_frozen'
  | 'last_clip_exceeds_max_after_fallback';
export interface TimelineIssue {
  code: TimelineIssueCode; severity: 'warning' | 'error'; message: string;
  beatIds: string[]; clipId: string | null;
}
export interface TimelineSegment {
  order: number; clipId: string; clipPath: string; intendedBeatIds: string[]; coveredBeatIds: string[];
  gapBeatIds: string[]; clipDurationSec: number; mediaDurationSec: number; trimEndToSec: number | null;
  padStopSec: number; segmentDurationSec: number; startSec: number;
}
export interface TimelineResult { segments: TimelineSegment[]; issues: TimelineIssue[]; contentDurationSec: number; totalDurationSec: number }
export type FinalVideoDraftStage = 'draft' | 'preparing' | 'narration-ready' | 'describing' | 'arranging' | 'review' | 'failed';
export interface FinalVideoDraftRow {
  id: string; projectId: string; shotSetId: string; scriptDraftId: string | null; stage: FinalVideoDraftStage;
  revision: number; workflowConfigJson: string; narrationBeatsJson: string; clipPoolJson: string;
  arrangementJson: string; issuesJson: string; previewJobId: string | null; previewRevision: number | null;
  errorMessage: string | null; createdAt: string; updatedAt: string;
}
export interface FinalVideoJobSnapshot {
  kind: 'preview' | 'final'; draftId: string; draftRevision: number; packageConfig: PackageConfig;
  narrationBeats: NarrationBeat[]; clipPool: ClipPoolItem[]; arrangement: ArrangementPlan;
  issues: TimelineIssue[]; selectedClipIds: string[]; solverVersion: 2;
}
export interface FinalVideoJobRow {
  id: string; projectId: string; shotSetId: string; scriptDraftId: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'; currentStep: string; progress: number;
  packageJson: string; timelineJson: string; kind: 'preview' | 'final'; draftId: string | null;
  draftRevision: number | null; narrationBeatsJson: string; clipPoolJson: string; arrangementJson: string;
  issuesJson: string; selectedClipIdsJson: string; solverVersion: number; outputPath: string | null; coverPath: string | null;
  manifestPath: string | null; durationSec: number | null; errorMessage: string | null;
  startedAt: string | null; finishedAt: string | null; createdAt: string;
}

export function defaultPackageConfig(): PackageConfig {
  return {
    mode: 'bgm-only', outputName: `final-${Date.now()}`, width: 1080, height: 1920, fps: 30,
    targetDurationSec: 15, durationTolerancePct: 0.2, maxClipSeconds: 4,
    narration: { mode: 'none' }, bgm: null,
    cover: { titleText: '', titleSize: 72, titleColor: '#ffffff', introDurationSec: 0, templateId: 'minimal-01' },
    subtitle: { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 },
  };
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown, field: string): string => { if (typeof value !== 'string') throw new Error(`${field} must be a string`); return value; };
const number = (value: unknown, field: string): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`); return value; };
const nullableString = (value: unknown, field: string): string | null => value === null ? null : string(value, field);
const boolean = (value: unknown, field: string): boolean => { if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`); return value; };
const stringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => string(item, `${field}[${index}]`));
};
function parseJson(value: string, field: string): unknown {
  try { return JSON.parse(value); } catch (error) {
    throw new Error(`${field}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}
function object(value: unknown, field: string): JsonObject {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  return value;
}

function optionalString(value: JsonObject, key: string, field: string): void {
  if (key in value) string(value[key], `${field}.${key}`);
}
function optionalNumber(value: JsonObject, key: string, field: string): void {
  if (key in value) number(value[key], `${field}.${key}`);
}
function validatePackageConfigInput(partial: JsonObject, field: string): void {
  if ('mode' in partial && partial.mode !== 'narration' && partial.mode !== 'bgm-only') {
    throw new Error(`${field}.mode must be narration or bgm-only`);
  }
  for (const key of ['outputName'] as const) optionalString(partial, key, field);
  for (const key of ['width', 'height', 'fps', 'targetDurationSec', 'durationTolerancePct', 'maxClipSeconds'] as const) {
    optionalNumber(partial, key, field);
  }

  let narration: JsonObject | undefined;
  if ('narration' in partial) {
    narration = object(partial.narration, `${field}.narration`);
    if (narration.mode !== 'tts' && narration.mode !== 'none') throw new Error(`${field}.narration.mode is invalid`);
    optionalString(narration, 'providerId', `${field}.narration`);
    optionalString(narration, 'voice', `${field}.narration`);
    optionalNumber(narration, 'speed', `${field}.narration`);
  }
  if (partial.mode === 'narration' && narration?.mode !== 'tts') throw new Error(`${field}.narration.mode must be tts`);
  if (partial.mode === 'bgm-only' && narration?.mode !== 'none') throw new Error(`${field}.narration.mode must be none`);
  if (narration?.mode === 'tts') {
    string(narration.providerId, `${field}.narration.providerId`);
    string(narration.voice, `${field}.narration.voice`);
    number(narration.speed, `${field}.narration.speed`);
  }

  if ('bgm' in partial && partial.bgm !== null) {
    const bgm = object(partial.bgm, `${field}.bgm`);
    string(bgm.path, `${field}.bgm.path`);
    number(bgm.volume, `${field}.bgm.volume`);
    boolean(bgm.ducking, `${field}.bgm.ducking`);
  }
  if ('cover' in partial) {
    const cover = object(partial.cover, `${field}.cover`);
    optionalString(cover, 'titleText', `${field}.cover`); optionalNumber(cover, 'titleSize', `${field}.cover`);
    optionalString(cover, 'titleColor', `${field}.cover`); optionalNumber(cover, 'introDurationSec', `${field}.cover`);
    if ('templateId' in cover && !['luxury-01', 'minimal-01', 'luxury-02'].includes(string(cover.templateId, `${field}.cover.templateId`))) {
      throw new Error(`${field}.cover.templateId is invalid`);
    }
    if ('sellingPoints' in cover) stringArray(cover.sellingPoints, `${field}.cover.sellingPoints`);
  }
  if ('subtitle' in partial) {
    const subtitle = object(partial.subtitle, `${field}.subtitle`);
    if ('enabled' in subtitle) boolean(subtitle.enabled, `${field}.subtitle.enabled`);
    for (const key of ['fontSize', 'strokeWidth', 'marginBottomPct'] as const) optionalNumber(subtitle, key, `${field}.subtitle`);
    optionalString(subtitle, 'color', `${field}.subtitle`); optionalString(subtitle, 'strokeColor', `${field}.subtitle`);
  }
}

/** 兼容旧 package JSON：缺失字段使用默认值；任何显式字段必须通过结构校验。 */
function mergePackageConfigAt(partial: unknown, field: string): PackageConfig {
  const base = defaultPackageConfig();
  if (!isObject(partial)) return base;
  validatePackageConfigInput(partial, field);
  const narrationInput = isObject(partial.narration) ? partial.narration : {};
  const mode = partial.mode === 'narration' || (!('mode' in partial) && narrationInput.mode === 'tts')
    ? 'narration' : 'bgm-only';
  const cover = isObject(partial.cover) ? partial.cover : {};
  const subtitle = isObject(partial.subtitle) ? partial.subtitle : {};
  const bgm = partial.bgm === null ? null : isObject(partial.bgm) ? partial.bgm as unknown as BgmConfig : base.bgm;
  const common: PackageCommonConfig = {
    outputName: typeof partial.outputName === 'string' ? partial.outputName : base.outputName,
    width: typeof partial.width === 'number' ? partial.width : base.width,
    height: typeof partial.height === 'number' ? partial.height : base.height,
    fps: typeof partial.fps === 'number' ? partial.fps : base.fps,
    targetDurationSec: typeof partial.targetDurationSec === 'number' ? partial.targetDurationSec : base.targetDurationSec,
    durationTolerancePct: typeof partial.durationTolerancePct === 'number' ? partial.durationTolerancePct : base.durationTolerancePct,
    maxClipSeconds: typeof partial.maxClipSeconds === 'number' ? partial.maxClipSeconds : base.maxClipSeconds,
    bgm,
    cover: { ...base.cover, ...cover },
    subtitle: { ...base.subtitle, ...subtitle },
  } as PackageCommonConfig;
  if (mode === 'narration') {
    return { ...common, mode, narration: {
      mode: 'tts', providerId: typeof narrationInput.providerId === 'string' ? narrationInput.providerId : '',
      voice: typeof narrationInput.voice === 'string' ? narrationInput.voice : 'Cherry',
      speed: typeof narrationInput.speed === 'number' ? narrationInput.speed : 1,
    } };
  }
  return { ...common, mode, narration: { mode: 'none' } };
}
export function mergePackageConfig(partial: unknown): PackageConfig {
  return mergePackageConfigAt(partial, 'packageConfig');
}
export type PackageConfigRequestValidation =
  | { ok: true; value: PackageConfig }
  | { ok: false; error: string };

/** Route-boundary adapter: keeps strict parsing while making client validation failures explicit. */
export function validatePackageConfigRequest(partial: unknown): PackageConfigRequestValidation {
  try {
    return { ok: true, value: mergePackageConfig(partial) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parsePackageConfigJson(json: string): PackageConfig {
  const value = parseJson(json, 'packageJson');
  object(value, 'packageJson');
  return mergePackageConfigAt(value, 'packageJson');
}
export function parseFinalVideoWorkflowConfigJson(json: string): FinalVideoWorkflowConfig {
  const value = object(parseJson(json, 'workflowConfigJson'), 'workflowConfigJson');
  const packageConfig = mergePackageConfigAt(object(value.packageConfig, 'workflowConfigJson.packageConfig'), 'workflowConfigJson.packageConfig');
  const selectedClipIds = stringArray(value.selectedClipIds, 'workflowConfigJson.selectedClipIds');
  if (packageConfig.mode === 'narration' && selectedClipIds.length) throw new Error('workflowConfigJson.selectedClipIds must be empty in narration mode');
  return { packageConfig, narrationScriptProviderId: string(value.narrationScriptProviderId, 'workflowConfigJson.narrationScriptProviderId'),
    visionProviderId: string(value.visionProviderId, 'workflowConfigJson.visionProviderId'),
    orchestrationProviderId: string(value.orchestrationProviderId, 'workflowConfigJson.orchestrationProviderId'), selectedClipIds };
}
export function parseNarrationBeatsJson(json: string): NarrationBeat[] {
  const value = parseJson(json, 'narrationBeatsJson');
  if (!Array.isArray(value)) throw new Error('narrationBeatsJson must be an array');
  return value.map((raw, index) => { const beat = object(raw, `narrationBeatsJson[${index}]`); return {
    beatId: string(beat.beatId, `narrationBeatsJson[${index}].beatId`), groupId: string(beat.groupId, `narrationBeatsJson[${index}].groupId`),
    index: number(beat.index, `narrationBeatsJson[${index}].index`), text: string(beat.text, `narrationBeatsJson[${index}].text`),
    audioPath: string(beat.audioPath, `narrationBeatsJson[${index}].audioPath`), durationSec: number(beat.durationSec, `narrationBeatsJson[${index}].durationSec`),
    startSec: number(beat.startSec, `narrationBeatsJson[${index}].startSec`),
  }; });
}
export function parseClipPoolJson(json: string): ClipPoolItem[] {
  const value = parseJson(json, 'clipPoolJson'); if (!Array.isArray(value)) throw new Error('clipPoolJson must be an array');
  return value.map((raw, index) => { const clip = object(raw, `clipPoolJson[${index}]`); const p = `clipPoolJson[${index}]`; return {
    clipId: string(clip.clipId, `${p}.clipId`), shotId: string(clip.shotId, `${p}.shotId`), shotIndex: number(clip.shotIndex, `${p}.shotIndex`),
    videoPath: string(clip.videoPath, `${p}.videoPath`), clipDurationSec: number(clip.clipDurationSec, `${p}.clipDurationSec`),
    sourceImageId: string(clip.sourceImageId, `${p}.sourceImageId`), sourceImagePath: string(clip.sourceImagePath, `${p}.sourceImagePath`),
    visualDescription: string(clip.visualDescription, `${p}.visualDescription`), descriptionProviderId: nullableString(clip.descriptionProviderId, `${p}.descriptionProviderId`),
    descriptionModel: nullableString(clip.descriptionModel, `${p}.descriptionModel`),
  }; });
}
export function parseArrangementPlanJson(json: string): ArrangementPlan {
  const value = object(parseJson(json, 'arrangementJson'), 'arrangementJson');
  if (!Array.isArray(value.assignments) || !Array.isArray(value.gaps)) throw new Error('arrangementJson assignments and gaps must be arrays');
  return {
    assignments: value.assignments.map((raw, index) => { const a = object(raw, `arrangementJson.assignments[${index}]`); return {
      assignmentId: string(a.assignmentId, `arrangementJson.assignments[${index}].assignmentId`), clipId: string(a.clipId, `arrangementJson.assignments[${index}].clipId`),
      beatIds: stringArray(a.beatIds, `arrangementJson.assignments[${index}].beatIds`),
    }; }),
    gaps: value.gaps.map((raw, index) => { const gap = object(raw, `arrangementJson.gaps[${index}]`); return {
      beatId: string(gap.beatId, `arrangementJson.gaps[${index}].beatId`), reason: string(gap.reason, `arrangementJson.gaps[${index}].reason`),
    }; }),
  };
}
const ISSUE_CODES: TimelineIssueCode[] = ['target_duration_out_of_tolerance','arrangement_invalid','arrangement_fallback_used','visual_gap','clip_missing','clip_short_borrowed_forward','last_clip_frozen','last_clip_exceeds_max_after_fallback'];
export function parseTimelineIssuesJson(json: string): TimelineIssue[] {
  const value = parseJson(json, 'issuesJson'); if (!Array.isArray(value)) throw new Error('issuesJson must be an array');
  return value.map((raw, index) => { const issue = object(raw, `issuesJson[${index}]`); const code = string(issue.code, `issuesJson[${index}].code`);
    if (!ISSUE_CODES.includes(code as TimelineIssueCode)) throw new Error(`issuesJson[${index}].code is invalid`);
    if (issue.severity !== 'warning' && issue.severity !== 'error') throw new Error(`issuesJson[${index}].severity is invalid`);
    return { code: code as TimelineIssueCode, severity: issue.severity, message: string(issue.message, `issuesJson[${index}].message`),
      beatIds: stringArray(issue.beatIds, `issuesJson[${index}].beatIds`), clipId: nullableString(issue.clipId, `issuesJson[${index}].clipId`) };
  });
}
export function parseFinalVideoJobSnapshotJson(json: string): FinalVideoJobSnapshot {
  const value = object(parseJson(json, 'jobSnapshotJson'), 'jobSnapshotJson');
  if (value.kind !== 'preview' && value.kind !== 'final') throw new Error('jobSnapshotJson.kind is invalid');
  if (value.solverVersion !== 2) throw new Error('jobSnapshotJson.solverVersion must be 2');
  return { kind: value.kind, draftId: string(value.draftId, 'jobSnapshotJson.draftId'), draftRevision: number(value.draftRevision, 'jobSnapshotJson.draftRevision'),
    packageConfig: mergePackageConfigAt(object(value.packageConfig, 'jobSnapshotJson.packageConfig'), 'jobSnapshotJson.packageConfig'),
    narrationBeats: parseNarrationBeatsJson(JSON.stringify(value.narrationBeats)), clipPool: parseClipPoolJson(JSON.stringify(value.clipPool)),
    arrangement: parseArrangementPlanJson(JSON.stringify(value.arrangement)), issues: parseTimelineIssuesJson(JSON.stringify(value.issues)),
    selectedClipIds: stringArray(value.selectedClipIds, 'jobSnapshotJson.selectedClipIds'), solverVersion: 2 };
}
