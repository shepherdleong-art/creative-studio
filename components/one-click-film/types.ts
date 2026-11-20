import type { SoundMode, StoryStructure } from '@/lib/one-click-film/contract';

/** 一键成片工作台的客户端数据形状：只描述界面真正读到的字段。 */

export interface FilmImage {
  id: string;
  filename: string;
  usage: string;
  url: string;
}

export interface FilmPoint {
  text: string;
  originalText?: string;
  sourceImageId: string | null;
  sourceLabel: string;
  evidenceRefs: Array<{ imageId: string; label: string; locator?: string }>;
  kind: 'appearance' | 'usage' | 'claim';
  selected: boolean;
  edited?: boolean;
}

export interface FilmAnalysis {
  id: string;
  versionNumber: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  productName: string;
  appearance: string;
  sceneClues: string;
  confirmedAt: string | null;
  confirmedProductName: string;
  errorMessage: string | null;
  createdAt: string;
  points: FilmPoint[];
}

export interface FilmEntry {
  id: string;
  code: string;
  ordinal: number;
  structure: StoryStructure;
  structureSource: 'auto' | 'batch' | 'individual';
  soundMode: SoundMode;
  status: 'pending' | 'draft' | 'confirmed';
  title: string;
  outline: string;
  narration: string;
  promptText: string;
  promptDurationSec: number;
  promptAspectRatio: string;
  scriptRevision: number;
  scriptConfirmedAt: string | null;
  productNameSnapshot: string;
  sellingPointsSnapshot: string[];
  ttsProviderId: string;
  ttsVoice: string;
  ttsSpeed: number;
}

export interface FilmProject {
  id: string;
  name: string;
  storeCode: string;
  productCode: string;
  productSubmodel: string;
  productionType: string;
  editorName: string;
  createdAt: string;
}

export interface FilmState {
  project: FilmProject;
  /** 首次进入时还没有任何分析/脚本记录，后端返回 null。 */
  run: { id: string; currentAnalysisId: string | null } | null;
  images: FilmImage[];
  analyses: Array<{
    id: string;
    versionNumber: number;
    status: string;
    productName: string;
    confirmedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
  analysis: FilmAnalysis | null;
  entries: FilmEntry[];
}

export const STAGE_TABS = [
  { id: 'upload', label: '上传素材' },
  { id: 'analysis', label: '分析内容' },
  { id: 'scripts', label: '生成脚本' },
  { id: 'generation', label: '生成视频' },
  { id: 'review', label: '审片与返工' },
  { id: 'packaging', label: '包装与导出' },
] as const;

export type StageTabId = (typeof STAGE_TABS)[number]['id'];

export function parseStageTab(value: string | null | undefined): StageTabId {
  return STAGE_TABS.some((tab) => tab.id === value) ? value as StageTabId : 'upload';
}

export const SCENE_USAGE = 'scene_seed';
export const DETAIL_USAGE = 'detail_page';

export function imagesOf(state: Pick<FilmState, 'images'>, usage: string): FilmImage[] {
  return state.images.filter((image) => image.usage === usage);
}

/** 分析入口可用的图片：场景图与详情页都属于本次分析的来源。 */
export function analysisSourceIds(state: Pick<FilmState, 'images'>): string[] {
  return state.images.filter((image) => image.usage === SCENE_USAGE || image.usage === DETAIL_USAGE).map((image) => image.id);
}
