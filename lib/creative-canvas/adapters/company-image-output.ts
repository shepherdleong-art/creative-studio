import { companyImageCapsForModel, companyImageDeliverySize } from '../../company-gateway-size.ts';
import { resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';
import { normalizeGeneratedImageToNativeRatio } from '../../image-output-normalize.ts';

/** 公司图片按名义比例原生裁齐；历史不同画幅产物继续兼容，绝不放大。 */
export async function companyCanvasImageOutput(bytes: Buffer, model: string, parameters: Record<string, string | number | boolean>) {
  const caps = companyImageCapsForModel(model);
  const size = resolveGptImage2Size(String(parameters.aspectRatio ?? '1:1'), String(parameters.resolution ?? '2K').toLowerCase());
  const output = await normalizeGeneratedImageToNativeRatio(bytes, caps ? companyImageDeliverySize(size, caps) : size);
  return { bytes: output.imageBuffer, mimeType: output.format === 'jpeg' ? 'image/jpeg' : output.format === 'webp' ? 'image/webp' : 'image/png' };
}
