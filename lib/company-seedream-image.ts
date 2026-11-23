export const COMPANY_SEEDREAM_55 = {
  id: 'company-gateway-seedream-5-5',
  model: 'doubao-seedream-5-5-261028',
  name: '公司 Seedream 5.5',
  maxImages: 10,
} as const;

export const COMPANY_SEEDREAM_50_PRO_MODEL = 'doubao-seedream-5-0-pro-image';

// 火山方舟「图片生成 API」的 Seedream 5.5 图片生成常用尺寸。
export const COMPANY_SEEDREAM_55_SIZES: Record<string, Record<string, string>> = {
  '1K': { '1:1': '1024x1024', '3:4': '864x1152', '4:3': '1152x864', '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1568x672' },
  '1.5K': { '1:1': '1536x1536', '3:4': '1344x1792', '4:3': '1792x1344', '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248', '2:3': '1248x1872', '21:9': '2352x1008' },
  '2K': { '1:1': '2048x2048', '3:4': '1776x2368', '4:3': '2368x1776', '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
};

export function isCompanySeedreamImageModel(model: string): boolean {
  return model === COMPANY_SEEDREAM_50_PRO_MODEL || model === COMPANY_SEEDREAM_55.model;
}

export function companySeedreamImageBody(
  model: string, prompt: string, images: string[], aspectRatio: string, resolution: string,
) {
  return {
    model,
    prompt: aspectRatio === 'auto' ? prompt : `${prompt}\n输出画幅为${aspectRatio}，清晰度为${resolution}。`,
    size: resolution,
    ...(images.length ? { image: model === COMPANY_SEEDREAM_55.model && images.length === 1 ? images[0] : images } : {}),
    response_format: 'url',
    ...(model === COMPANY_SEEDREAM_50_PRO_MODEL ? { n: 1 } : {}),
  };
}
