import { companyImageCapsForModel, companyImageDeliverySize } from '../../company-gateway-size.ts';
import { resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';
import { normalizeGeneratedImageToNativeRatio } from '../../image-output-normalize.ts';

/** 七牛排除格可能借用不同画幅生成，发布前按名义格裁齐，保留原生像素。 */
export async function companyCanvasImageOutput(bytes: Buffer, model: string, parameters: Record<string, string | number | boolean>) {
  const caps = companyImageCapsForModel(model);
  const size = resolveGptImage2Size(String(parameters.aspectRatio ?? '1:1'), String(parameters.resolution ?? '2K').toLowerCase());
  const output = await normalizeGeneratedImageToNativeRatio(bytes, caps ? companyImageDeliverySize(size, caps) : size);
  return { bytes: output.imageBuffer, mimeType: output.format === 'jpeg' ? 'image/jpeg' : output.format === 'webp' ? 'image/webp' : 'image/png' };
}
