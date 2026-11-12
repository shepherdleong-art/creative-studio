import { companyImageCapsForModel, companyImageCellExecutable } from './company-gateway-size.ts';
import { GPT_IMAGE_2_ASPECT_RATIOS, GPT_IMAGE_2_SIZE_MAP } from './gpt-image-2-size-presets.ts';

/** 清晰度同样受模型能力限制，不能在 UI 提供随后被静默降档的 4K。 */
export function getSupportedImageResolutions(model: string, aspectRatio: string): string[] {
  const caps = companyImageCapsForModel(model);
  return Object.keys(GPT_IMAGE_2_SIZE_MAP[aspectRatio] || {}).filter(r => !caps || companyImageCellExecutable(model, r, aspectRatio));
}

export function validateImageResolution(model: string, aspectRatio: string, resolution: string): string | null {
  if (aspectRatio === 'auto') return null;
  return getSupportedImageResolutions(model, aspectRatio).includes(resolution)
    ? null : `模型 ${model} 不支持 ${aspectRatio} 的 ${resolution.toUpperCase()} 清晰度`;
}

/** 复用项目或旧 API 保存的预设尺寸校验完整组合；auto 与历史自定义尺寸不反推档位。 */
export function validateImagePresetSize(model: string, size: string): string | null {
  if (!companyImageCapsForModel(model)) return null;
  for (const [ratio, resolutions] of Object.entries(GPT_IMAGE_2_SIZE_MAP)) {
    for (const [resolution, preset] of Object.entries(resolutions)) {
      if (preset === size) {
        return validateImageAspectRatio(model, ratio) || validateImageResolution(model, ratio, resolution);
      }
    }
  }
  return null;
}

/**
 * 返回当前模型真正可提交的图片画幅。
 * 公司网关模型只展示其能力白名单；auto 保留为“不指定画幅”，网关会按自身默认处理。
 */
export function getSupportedImageAspectRatios(model: string): string[] {
  const caps = companyImageCapsForModel(model);
  return GPT_IMAGE_2_ASPECT_RATIOS.filter((ratio) => ratio === 'auto' || !caps || caps.ratios.includes(ratio));
}

/** 返回请求画幅不被当前模型支持时的可读错误，否则返回 null。 */
export function validateImageAspectRatio(model: string, aspectRatio: string): string | null {
  if (!GPT_IMAGE_2_ASPECT_RATIOS.includes(aspectRatio as (typeof GPT_IMAGE_2_ASPECT_RATIOS)[number])) {
    return `不支持的图片比例: ${aspectRatio}`;
  }
  if (!getSupportedImageAspectRatios(model).includes(aspectRatio)) {
    return `模型 ${model} 不支持图片比例 ${aspectRatio}`;
  }
  return null;
}
