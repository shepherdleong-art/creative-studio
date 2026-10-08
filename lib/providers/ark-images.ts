import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { EditImageRequest, EditImageResult } from './openai-compatible.ts';
import { SEEDREAM_5_PRO, seedreamImageEndpoint, seedreamImageSize } from '../seedream-image.ts';

export interface ArkImageInput { absolutePath: string; mimeType: string }

/** 预先构造完整请求；校验失败不得发送生成 POST。参考图顺序由调用者确定。 */
export async function buildArkImageBody(request: {
  model: string; prompt: string; size: string; images: ArkImageInput[];
}) {
  if (request.model !== SEEDREAM_5_PRO) throw new Error('方舟图片适配器尚未支持该模型');
  if (request.images.length > 10) throw new Error('Seedream 5.0 Pro 最多支持 10 张参考图');
  const size = seedreamImageSize(request.size);
  const images: string[] = [];
  for (const input of request.images) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType)) throw new Error('参考图格式须为 PNG、JPEG 或 WebP');
    const bytes = await fs.readFile(input.absolutePath);
    if (bytes.length > 30 * 1024 * 1024) throw new Error('Seedream 单张参考图不能超过 30MB');
    const { width = 0, height = 0 } = await sharp(bytes).metadata();
    if (width <= 14 || height <= 14 || width * height > 36_000_000 || width / height < 1 / 16 || width / height > 16) {
      throw new Error('Seedream 参考图尺寸超出允许范围');
    }
    images.push(`data:${input.mimeType};base64,${bytes.toString('base64')}`);
  }
  return {
    model: request.model, prompt: request.prompt, size,
    response_format: 'url', output_format: 'png', watermark: false,
    ...(images.length ? { image: images } : {}),
  };
}

export async function editImageArk(
  request: EditImageRequest, apiKey: string, baseUrl: string, signal?: AbortSignal,
): Promise<EditImageResult> {
  const started = Date.now();
  const body = await buildArkImageBody({
    model: request.model, prompt: request.prompt, size: request.size,
    images: [
      { absolutePath: request.inputImagePath, mimeType: request.inputMimeType },
      ...request.referenceImagePaths.map((absolutePath, i) => ({ absolutePath, mimeType: request.referenceMimeTypes[i] || 'image/png' })),
    ],
  });
  const requestSignal = AbortSignal.any([AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]);
  const response = await fetch(seedreamImageEndpoint(baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal: requestSignal,
  });
  if (!response.ok) throw new Error(`方舟图片生成失败（HTTP ${response.status}）`);
  const data = await response.json() as { data?: Array<{ url?: string; b64_json?: string }> };
  const result = data.data?.[0];
  let imageBuffer: Buffer;
  if (result?.b64_json) imageBuffer = Buffer.from(result.b64_json, 'base64');
  else if (result?.url) {
    // 结果地址不附带方舟 API Key。
    const downloaded = await fetch(result.url, { signal: requestSignal });
    if (!downloaded.ok) throw new Error(`方舟图片下载失败（HTTP ${downloaded.status}）`);
    imageBuffer = Buffer.from(await downloaded.arrayBuffer());
  } else throw new Error('方舟响应未包含生成图片');
  return { imageBuffer, latencyMs: Date.now() - started };
}
