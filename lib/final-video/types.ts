/** 成片包装的共享类型。字段契约见 docs/superpowers/plans/2026-07-04-final-video-packaging.md §1.2-1.3 */

export interface NarrationConfig {
  mode: 'none' | 'tts';
  voice: string;
  speed: number;
  /** 口播供应商 id（narration_providers.id）；留空则由服务端自动挑第一个已配置的供应商。 */
  providerId?: string;
}

export interface BgmConfig {
  path: string;
  volume: number;
  ducking: boolean;
}

export type CoverTemplateId = 'luxury-01' | 'minimal-01' | 'luxury-02';

export interface CoverConfig {
  titleText: string;
  titleSize: number;
  titleColor: string;
  introDurationSec: number;
  templateId?: CoverTemplateId;
  sellingPoints?: string[];
}

export interface SubtitleStyle {
  enabled: boolean;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** 字幕基线距底部的画面高度百分比 */
  marginBottomPct: number;
}

export interface PackageConfig {
  outputName: string;
  width: number;
  height: number;
  fps: number;
  narration: NarrationConfig;
  bgm: BgmConfig | null;
  cover: CoverConfig;
  subtitle: SubtitleStyle;
}

export interface TimelineSegment {
  shotId: string;
  shotIndex: number;
  videoJobId: string;
  clipPath: string;
  clipDurationSec: number;
  voiceover: string;
  subtitle: string;
  narrationDurationSec: number;
  segmentDurationSec: number;
  startSec: number;
}

export interface FinalVideoJobRow {
  id: string;
  projectId: string;
  shotSetId: string;
  scriptDraftId: string | null;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';
  currentStep: string;
  progress: number;
  packageJson: string;
  timelineJson: string;
  outputPath: string | null;
  coverPath: string | null;
  manifestPath: string | null;
  durationSec: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export function defaultPackageConfig(): PackageConfig {
  return {
    outputName: `final-${Date.now()}`,
    width: 1080,
    height: 1920,
    fps: 30,
    narration: { mode: 'none', voice: 'Cherry', speed: 1.0, providerId: '' },
    bgm: null,
    cover: { titleText: '', titleSize: 72, titleColor: '#ffffff', introDurationSec: 0, templateId: 'minimal-01' as const },
    subtitle: { enabled: true, fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 2, marginBottomPct: 18 },
  };
}

/** 浅合并用户提交的部分配置（narration/bgm/cover/subtitle 为对象级覆盖） */
export function mergePackageConfig(partial: Partial<PackageConfig> | undefined): PackageConfig {
  const base = defaultPackageConfig();
  if (!partial || typeof partial !== 'object') return base;
  return {
    ...base,
    ...partial,
    narration: { ...base.narration, ...(partial.narration ?? {}) },
    bgm: partial.bgm === null ? null : partial.bgm ? { ...partial.bgm } : base.bgm,
    cover: { ...base.cover, ...(partial.cover ?? {}) },
    subtitle: { ...base.subtitle, ...(partial.subtitle ?? {}) },
  };
}
