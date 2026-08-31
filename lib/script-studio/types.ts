export type ScriptStudioPointType = 'appearance' | 'structure' | 'scenario' | 'spec' | 'material' | 'certification' | 'efficacy' | 'other';
export type ScriptStudioEvidenceGate = 'passed' | 'failed' | 'skipped';
export type ScriptStudioRiskLevel = 'low' | 'high';
export type ScriptStudioHierarchyRole = 'primary' | 'supporting' | 'detail';

/** 证据定位的最小单元：每条引用自带页码与切片编号，跨页合并后不丢配对关系。 */
export interface SellingPointEvidenceRef {
  pageIndex: number | null;
  tileRef: string;
}

export interface SourceSetRecord {
  id: string;
  projectId: string;
  contentFingerprint: string;
  imageAssetIdsJson: string;
  createdAt: string;
}

export interface LibraryRecord {
  id: string;
  projectId: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRevisionRecord {
  id: string;
  libraryId: string;
  revisionNumber: number;
  sourceSetId: string;
  sourceFingerprint: string;
  productName: string;
  category: string;
  brand: string;
  extractProviderId: string;
  extractModel: string;
  promptContractVersion: number;
  origin: 'extraction' | 'manual_edit';
  createdAt: string;
}

export interface SellingPointRecord {
  id: string;
  revisionId: string;
  seq: number;
  title: string;
  factText: string;
  pointType: ScriptStudioPointType;
  evidenceQuote: string;
  sourcePageIndex: number | null;
  tileRefsJson: string;
  evidenceRefsJson: string;
  modelConfidence: string;
  riskLevel: ScriptStudioRiskLevel;
  evidenceGate: ScriptStudioEvidenceGate;
  usable: number;
  disabledByUser: number;
  themeKey: string;
  themeTitle: string;
  hierarchyRole: ScriptStudioHierarchyRole;
  importance: number;
}

export type ProjectScriptOrigin = 'ai_generate' | 'ai_regenerate' | 'manual_edit';

export interface ProjectScriptRecord {
  id: string;
  projectId: string;
  shotSetId: string | null;
  currentRevisionId: string | null;
  generationTaskId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectScriptRevisionRecord {
  id: string;
  scriptId: string;
  revisionNumber: number;
  generationTaskId: string | null;
  libraryRevisionId: string | null;
  templateId: string;
  templateVersion: number;
  templateRationale: string;
  origin: ProjectScriptOrigin;
  contentJson: string;
  targetDurationSec: number;
  estimatedDurationSec: number | null;
  validationJson: string;
  createdAt: string;
}

export type ScriptStudioTaskStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type ScriptStudioTaskMode = 'first_extraction' | 'reuse';
export type ScriptStudioTaskStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface ScriptStudioTaskRecord {
  id: string;
  projectId: string;
  requestKey: string;
  mode: ScriptStudioTaskMode;
  sourceSetId: string | null;
  libraryRevisionId: string | null;
  inputSnapshotJson: string;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  status: ScriptStudioTaskStatus;
  currentStage: string;
  errorCode: string | null;
  errorMessage: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  parentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptStudioTaskStageRecord {
  id: string;
  taskId: string;
  seq: number;
  stage: string;
  status: ScriptStudioTaskStageStatus;
  payloadJson: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}

export interface ScriptStudioSegmentContent {
  id: string;
  narration: string;
  subtitle: string;
  sellingPointIdRefs: string[];
  sellingPointRefs: string[];
  visualIntent: string;
  visualKeywords: string[];
}

export interface ScriptStudioScriptContent {
  version: 3;
  title: string;
  coverTitleParts: {
    primary: string;
    secondary: string;
    source: 'model' | 'system_split' | 'system_composed';
  };
  platform: string;
  tone: string;
  templateId: string;
  template: string;
  templateVersion: number;
  templateRationale: string;
  shotSetId: string;
  targetDurationSec: number;
  targetNarrationDurationSec: number;
  contentCharacterCount: number;
  estimatedNarrationDurationSec: number;
  durationStatus: 'qualified' | 'too_short' | 'too_long';
  direction: string;
  creativeBrief: string;
  libraryRevisionId: string;
  sellingPointUsage: Array<{
    sellingPointId: string;
    title: string;
    status: 'used' | 'omitted' | 'omitted_no_visual_support';
    reason: string;
  }>;
  segments: ScriptStudioSegmentContent[];
  fullScript: string;
  fullSubtitle: string;
  warnings?: Array<{ code: string; message: string }>;
}

export interface ScriptStudioTaskSnapshot {
  id: string;
  projectId: string;
  requestKey: string;
  mode: 'first_extraction' | 'reuse';
  status: ScriptStudioTaskStatus;
  currentStage: string;
  errorCode: string | null;
  errorMessage: string | null;
  requestedCount: number;
  succeededCount: number;
  failedCount: number;
  startedAt: string;
  updatedAt: string;
  inputSnapshot: Record<string, unknown>;
  parentTaskId?: string | null;
  stages: Array<{
    seq: number;
    stage: string;
    status: ScriptStudioTaskStageStatus;
    payload: Record<string, unknown>;
    startedAt: string | null;
    finishedAt: string | null;
    errorCode: string | null;
  }>;
  libraryRevisionId: string | null;
}

export interface ScriptStudioScriptView {
  id: string;
  projectId: string;
  shotSetId: string | null;
  currentRevisionId: string | null;
  currentRevision: ProjectScriptRevisionRecord | null;
  createdAt: string;
  updatedAt: string;
}
