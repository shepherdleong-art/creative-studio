import { companyImageCapsForModel } from './company-gateway-size.ts';
import { GPT_IMAGE_2_ASPECT_RATIOS } from './gpt-image-2-size-presets.ts';

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
