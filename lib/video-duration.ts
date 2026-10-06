// 界面、单条/批量提交接口与各视频适配器共用的整数秒约束；非法值一律拒绝，不静默截断。
const durationsBetween = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index);

// 公司网关精确别名 kling-2.5（腾讯可灵 2.5）仅支持 5/10 秒，单首帧与首尾帧一致；直连可灵不受此限。
const KLING_25_GATEWAY_DURATIONS = [5, 10] as const;
const KLING_3_MODELS = ['kling-3.0', 'kling-v3', 'kling-v3-0', 'kling-v3.0', 'qiniuyun/kling-3.0'];
const KLING_3_DURATIONS = durationsBetween(3, 15);
// Seedance 2.x 生成下限 4 秒；2.5 的 30 秒在方舟直连与公司网关都已实测。
const SEEDANCE_25_DURATIONS = durationsBetween(4, 30);
const SEEDANCE_20_DURATIONS = durationsBetween(4, 15);
const DEFAULT_DURATIONS = durationsBetween(2, 15);

function isGatewayKling25(providerType: string, model: string): boolean {
  return providerType === 'openai-video' && model === 'kling-2.5';
}

/** 按供应商类型与实际模型给出允许的整数秒（升序）；未知模型保留历史 2–15 秒。 */
export function videoDurationOptions(providerType: string, model: string): readonly number[] {
  if (isGatewayKling25(providerType, model)) return KLING_25_GATEWAY_DURATIONS;
  const m = model.trim().toLowerCase();
  if (/^doubao-seedance-2-5(?:-\d{6})?$/.test(m)) return SEEDANCE_25_DURATIONS;
  if (/^doubao-seedance-2-0(?:-fast)?(?:-\d{6})?$/.test(m)) return SEEDANCE_20_DURATIONS;
  if (KLING_3_MODELS.includes(m)) return KLING_3_DURATIONS;
  return DEFAULT_DURATIONS;
}

/** 界面提示用：连续区间写成「4–30 秒」，离散值写成「5 / 10 秒」。 */
export function describeVideoDurationOptions(options: readonly number[]): string {
  const contiguous = options.every((value, index) => index === 0 || value === options[index - 1] + 1);
  return contiguous ? `${options[0]}–${options[options.length - 1]} 秒` : `${options.join(' / ')} 秒`;
}

export function videoDurationError(providerType: string, model: string, durationSec: number): string | null {
  const options = videoDurationOptions(providerType, model);
  if (options.includes(durationSec)) return null;
  return isGatewayKling25(providerType, model)
    ? 'Kling 2.5 仅支持 5 秒或 10 秒视频，最长 10 秒'
    : `视频时长须为 ${describeVideoDurationOptions(options)}的整数`;
}

/** 切换模型或离焦时把草稿时长调到最近的合法值；不能用来放行非法 API 请求。 */
export function normalizeVideoDraftDuration(value: number, options: readonly number[]): number {
  const target = Number.isFinite(value) ? value : 5;
  return options.reduce((closest, option) => Math.abs(option - target) < Math.abs(closest - target) ? option : closest);
}

/** 仅字段缺省时用默认值，显式提交的空值、非法数字不能偷偷替换成 5 秒。 */
export function parseVideoDuration(value: unknown): number {
  if (value === undefined) return 5;
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && !value.trim()) return NaN;
  return Number(value);
}
