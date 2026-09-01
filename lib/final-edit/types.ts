import type { MatchDiagnostics } from './audio-first-matcher.ts';
import type { FinalEditDurationGateStateV1 } from './duration-gate.ts';

export { OUTPUT_PRESETS } from '../media-core/cover-types.ts';
export type { OutputPresetId, TextStyle, CoverFraming, CoverPresetV2 } from '../media-core/cover-types.ts';
import type { OutputPresetId, TextStyle, CoverFraming } from '../media-core/cover-types.ts';

export { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES, FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
export const FINAL_EDIT_MIN_CLIP_FRAMES = 12 as const;

export interface TimelineClip {
  id: string;
  videoJobId: string;
  sourceFingerprint: string;
  sourceInFrame: number;
  sourceOutFrame: number;
  timelineInFrame: number;
  timelineOutFrame: number;
  boundSegmentId: string | null;
  framing: { scale: number; offsetX: number; offsetY: number; subjectX?: number; subjectY?: number };
  manualUseOverride: boolean;
}

export interface VideoTimeline {
  fps: 24;
  introFrames: 20;
  bodyFrames: number;
  clips: TimelineClip[];
}

export interface SubtitleCue {
  id: string;
  segmentId: string;
  text: string;
  startUs: number;
  endUs: number;
  textSource: 'script' | 'manual';
  timingSource: 'aligned' | 'proportional' | 'manual';
}

export interface CoverEditorDraft {
  sourceKey: string;
  frameTimeUs: number;
  framing: CoverFraming;
  primary: { text: string; style: TextStyle };
  secondary: { text: string; style: TextStyle };
}

export interface FinalEditIssue {
  code: string;
  severity: 'blocking' | 'warning';
  message: string;
  targetId?: string;
}

export interface FinalEditAssetView {
  assetKey?: string;
  source?: 'module4' | 'external';
  videoJobId: string;
  shotSetId: string;
  shotId: string | null;
  /** 物理文件名，仅供播放 URL/物理路径；用户可见名称用 displayName。 */
  filename: string;
  /** 用户可见的友好名称（D5）；module4 视频来自持久化/派生 displayName，外部素材为原文件名。 */
  displayName: string;
  previewUrl: string;
  thumbnailUrl: string;
  durationUs: number;
  fingerprint: string;
  analysisStatus: 'pending' | 'succeeded' | 'failed';
  summary: string;
  autoUseDisabled: boolean;
  usageCount: number;
}

export interface FinalEditExternalAssetView {
  id: string;
  assetKey: `external:${string}`;
  projectId: string;
  shotSetId: string;
  originalFilename: string;
  mimeType: string;
  mediaKind: 'video';
  durationUs: number;
  width: number;
  height: number;
  status: 'ready' | 'missing' | 'failed';
  errorMessage: string | null;
  previewUrl: string;
  thumbnailUrl: string | null;
  source: 'external';
  createdAt: string;
}

export interface FinalEditVariantView {
  id: string;
  indexNum: number;
  outputPreset: OutputPresetId;
  timeline: VideoTimeline;
  bgm: { trackId: string | null; gainDb: number; loop: boolean; fadeInSec: number; fadeOutSec: number };
  cover: {
    coverKey: string | null;
    kind: 'storyboard_image' | 'video_keyframe' | null;
    sourceUrl: string | null;
    framing: CoverFraming;
    sourceKey: string | null;
    frameTimeUs: number;
  };
  issues: FinalEditIssue[];
  matchDiagnostics?: MatchDiagnostics;
  maxOverlap: number;
  revision: number;
  lastRenderedRevision: number | null;
  renderStatus: string | null;
  previewUrl?: string | null;
}

export interface FinalEditGroupView {
  id: string;
  projectId: string;
  scriptDraftId: string;
  shotSetId: string;
  status: string;
  phase: string;
  revision: number;
  script: {
    sourceDraftId: string | null;
    title: string;
    importedNarrationText: string;
    editedNarrationText: string;
    syncState: 'synced' | 'modified';
    sourceScriptUpdatedAt: string | null;
    sourceScriptRevisionId: string | null;
    sourceScriptRevisionNumber: number | null;
    narrationConfig: { providerId: string; voice: string; speed: number; playbackRate: number; gainDb: number };
    selectedMaterialKeys: string[];
  };
  narrationDurationUs: number;
  totalDurationUs: number;
  durationGate: FinalEditDurationGateStateV1 | null;
  coverTitle: {
    primary: { id: 'primary'; text: string; textSource: 'script' | 'manual' };
    secondary: { id: 'secondary'; text: string; textSource: 'script' | 'manual' };
  };
  subtitleCues: SubtitleCue[];
  textStyles: Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle; subtitle: TextStyle }>;
  variants: FinalEditVariantView[];
  assets: FinalEditAssetView[];
  bgmTracks: FinalEditBgmTrackView[];
  coverCandidates: Array<{ coverKey: string; sourceUrl: string; kind: 'storyboard_image' | 'video_keyframe' }>;
  jobs: Array<{ id: string; variantId: string | null; kind: string; status: string; phase: string; progress: number; estimatedCost: number | null; costCurrency: string; errorCode: string | null; errorMessage: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; renderRevision: { groupRevision: number; variantRevision: number } | null }>;
}

export interface CapacityEstimate {
  assetCount: number;
  videoJobIds: string[];
  coverCandidateCount: number;
  requestedCount: number;
  estimatedCompleteCount: number;
  estimatedCost: number | null;
  costCurrency: string;
  warnings: string[];
}

export interface JobRef {
  id: string;
  groupId: string;
  variantId?: string;
  kind: 'prepare' | 'proposal' | 'render';
  status: string;
}

export interface ExportTargetView {
  taskName: string;
  productCode: string;
  taskDate: string;
  videoFilename: string;
  coverFilename: string;
  displayDirectory: string;
}

export interface RenderJobRef extends JobRef {
  variantId: string;
  kind: 'render';
  target: ExportTargetView;
}

export interface MixcutContextResponse {
  project: {
    id: string;
    name: string;
    productName: string;
    productCode: string;
    productCategory: string;
    createdAt: string;
    taskDate: string;
  };
  shotSets: Array<{
    id: string;
    name: string;
    shotCount: number;
    succeededVideoCount: number;
    totalDurationUs: number;
  }>;
  currentShotSetId: string | null;
  drafts: Array<{
    id: string;
    version: 2 | 3;
    shotSetId: string;
    title: string;
    narrationText: string;
    targetDurationSec: number;
    provider: string;
    model: string;
    createdAt: string;
    /** 'project' = 新核心层项目脚本（空 shotSetId 项目级可见）；'legacy' = script_drafts 历史行。 */
    sourceKind: 'project' | 'legacy';
    /** 项目脚本当前 revision 身份；历史行固定为 null。用于“源脚本有新版本”提示，不暴露任务快照。 */
    sourceRevisionId: string | null;
    sourceRevisionNumber: number | null;
  }>;
  videoAssets: Array<{
    videoJobId: string;
    shotSetId: string;
    filename: string;
    /** 用户可见的友好名称（D5）；filename 仅供播放 URL/物理路径。 */
    displayName: string;
    durationUs: number;
    width: number;
    height: number;
    thumbnailUrl: string;
    previewUrl: string;
    summary: string;
    source: 'module4';
  }>;
}

export interface ExportIdentity {
  projectId: string;
  taskName: string;
  /**
   * The product/SKU code (`projects.productCode`) — distinct from
   * `projects.model`, which is the image-generation provider's model.
   * Never use `projects.model` as the product code here.
   */
  productCode: string;
  taskDate: string;
  /**
   * 成片导出目录名(`<产品编码>-<YYYYMMDD>`),由 `resolveProjectExportDirName`
   * 解析后传入,调用方负责落库。空字符串会被当作 `projectId` 处理。
   */
  exportDirName: string;
}

export interface FinalEditBgmTrackView {
  id: string;
  filename: string;
  relativePath: string;
  durationUs: number;
}

export interface BgmImportResponse {
  firstSuccessfulTrackId: string | null;
  imported: FinalEditBgmTrackView[];
  reused: FinalEditBgmTrackView[];
  errors: Array<{
    filename: string;
    code: string;
    message: string;
  }>;
  tracks: FinalEditBgmTrackView[];
}

export type MixcutErrorCode = 'product_code_required';
