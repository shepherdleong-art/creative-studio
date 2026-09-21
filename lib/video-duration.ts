export interface VideoDurationRange { min: number; max: number }

/** 工作台按实际模型限定整数秒；未知模型保留历史 2–15 秒范围。 */
export function videoDurationRange(model: string): VideoDurationRange {
  const m = model.trim().toLowerCase();
  if (/^doubao-seedance-2-5(?:-\d{6})?$/.test(m)) return { min: 4, max: 30 };
  if (/^doubao-seedance-2-0(?:-fast)?(?:-\d{6})?$/.test(m)) return { min: 4, max: 15 };
  if (['kling-3.0', 'kling-v3', 'kling-v3-0', 'kling-v3.0', 'qiniuyun/kling-3.0'].includes(m)) return { min: 3, max: 15 };
  return { min: 2, max: 15 };
}

export function videoDurationError(model: string, value: number): string | null {
  const { min, max } = videoDurationRange(model);
  return Number.isInteger(value) && value >= min && value <= max
    ? null : `视频时长须为 ${min}–${max} 秒的整数`;
}

export function clampVideoDuration(value: number, range: VideoDurationRange): number {
  return Math.max(range.min, Math.min(range.max, Math.round(Number.isFinite(value) ? value : 5)));
}

/** 仅字段缺省时用默认值，显式提交的空值、非法数字不能偷偷替换成 5 秒。 */
export function parseVideoDuration(value: unknown): number {
  if (value === undefined) return 5;
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  return Number(value);
}

export function sharedVideoDurationRange(models: string[]): VideoDurationRange {
  const ranges = (models.length ? models : ['']).map(videoDurationRange);
  return { min: Math.max(...ranges.map(r => r.min)), max: Math.min(...ranges.map(r => r.max)) };
}
