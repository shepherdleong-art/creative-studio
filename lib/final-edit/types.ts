export type OutputPresetId = '3x4' | '9x16' | '16x9';

export const OUTPUT_PRESETS = {
  '3x4': { width: 1080, height: 1440, fps: 24 },
  '9x16': { width: 1080, height: 1920, fps: 24 },
  '16x9': { width: 1920, height: 1080, fps: 24 },
} as const;

export const FINAL_EDIT_FPS = 24 as const;
export const FINAL_EDIT_INTRO_FRAMES = 20 as const;
export const FINAL_EDIT_INTRO_DURATION_US = 833_333;

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
  timingSource: 'aligned' | 'manual';
}

export interface TextStyle {
  fontFamily: string;
  fontPostscriptName?: string;
  fontSizePx: number;
  x: number;
  y: number;
  scale: number;
  color: string;
  align: 'left' | 'center' | 'right';
  boxWidthPx: number;
  lineHeight: number;
  stroke: { enabled: boolean; color: string; widthPx: number };
  shadow: { enabled: boolean; color: string; opacity: number; blurPx: number; distancePx: number; angleDeg: number };
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
  filename: string;
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
  bgm: { trackId: string | null; gainDb: number; loop: boolean; fadeOutSec: number };
  cover: {
    coverKey: string | null;
    kind: 'storyboard_image' | 'video_keyframe' | null;
    sourceUrl: string | null;
    framing: { scale: number; offsetX: number; offsetY: number };
  };
  issues: FinalEditIssue[];
  maxOverlap: number;
  revision: number;
  lastRenderedRevision: number | null;
  renderStatus: string | null;
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
    narrationConfig: { providerId: string; voice: string; speed: number };
    selectedMaterialKeys: string[];
  };
  narrationDurationUs: number;
  totalDurationUs: number;
  coverTitle: {
    primary: { id: 'primary'; text: string; textSource: 'script' | 'manual' };
    secondary: { id: 'secondary'; text: string; textSource: 'script' | 'manual' };
  };
  subtitleCues: SubtitleCue[];
  textStyles: Record<OutputPresetId, { coverPrimary: TextStyle; coverSecondary: TextStyle; subtitle: TextStyle }>;
  variants: FinalEditVariantView[];
  assets: FinalEditAssetView[];
  bgmTracks: Array<{ id: string; relativePath: string; durationUs: number }>;
  coverCandidates: Array<{ coverKey: string; sourceUrl: string; kind: 'storyboard_image' | 'video_keyframe' }>;
  jobs: Array<{ id: string; variantId: string | null; kind: string; status: string; phase: string; progress: number; estimatedCost: number | null; costCurrency: string; errorCode: string | null; errorMessage: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string }>;
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

export interface MixcutContextResponse {
  project: {
    id: string;
    name: string;
    productName: string;
    productCode: string;
    createdAt: string;
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
    shotSetId: string;
    title: string;
    narrationText: string;
    targetDurationSec: number;
    provider: string;
    model: string;
    createdAt: string;
  }>;
  videoAssets: Array<{
    videoJobId: string;
    shotSetId: string;
    filename: string;
    durationUs: number;
    width: number;
    height: number;
    thumbnailUrl: string;
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
}

export type MixcutErrorCode = 'product_code_required';
