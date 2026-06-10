import fs from 'fs';
import path from 'path';

export interface PackyEditImageRequest {
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
  quality: string;
  referenceGuidanceMode?: 'preserve_subject' | 'none';
}

export interface PackyEditImageResult {
  imageBuffer: Buffer;
  latencyMs: number;
  rawResponse?: unknown;
  remoteImageUrl?: string;
}

type PackyImageResponse = {
  created?: number;
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
  error?: string | { message?: string; code?: string };
};

function extractPackyError(data: PackyImageResponse): string | undefined {
  if (!data.error) return undefined;
  if (typeof data.error === 'string') return data.error;
  return data.error.message || data.error.code;
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Packy image download failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Call Packy GPT-Image-2 Images API.
 *
 * Packy uses multipart/form-data (not JSON), returns data[0].url or data[0].b64_json
 * directly without task_id or polling.
 *
 * Docs: https://docs.packyapi.com/docs/paint/GPTImage.html
 */
export async function editImagePacky(
  request: PackyEditImageRequest,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<PackyEditImageResult> {
  const startTime = Date.now();
  const cleanBase = baseUrl.replace(/\/$/, '');
  const url = `${cleanBase}/v1/images/edits`;

  const hasRefs = request.referenceImagePaths.length > 0;

  let prompt = request.prompt;
  if (hasRefs) {
    prompt = [
      '输入图片顺序如下：',
      '图1 是待编辑底图，是本次修改的主要对象。',
      `图2 到图${request.referenceImagePaths.length + 1} 是参考图，只用于参考场景、风格、光线、材质、构图、产品或人物一致性。`,
      '不要把参考图当成最终画面的主体，不要把参考图整体复制进结果。',
      '',
      '用户修改要求：',
      request.prompt,
    ].join('\n');
  }

  const form = new FormData();
  form.append('model', request.model);
  form.append('prompt', prompt);
  form.append('size', request.size);
  form.append('quality', request.quality || 'auto');
  form.append('n', '1');
  form.append('output_format', 'png');

  // 图1 = 底图 (input), 图2-N = 参考图
  // Base image first
  const inputBuf = fs.readFileSync(request.inputImagePath);
  form.append(
    'image',
    new Blob([inputBuf], { type: request.inputMimeType }),
    `图1-底图-${path.basename(request.inputImagePath)}`
  );

  // Reference images after
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    const refPath = request.referenceImagePaths[i];
    const refMime = request.referenceMimeTypes[i] || 'image/png';
    const refBuf = fs.readFileSync(refPath);
    form.append(
      'image',
      new Blob([refBuf], { type: refMime }),
      `图${i + 2}-参考-${path.basename(refPath)}`
    );
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: '*/*',
    },
    body: form,
    signal,
  });

  const latencyMs = Date.now() - startTime;
  const text = await res.text();

  let data: PackyImageResponse;
  try {
    data = JSON.parse(text) as PackyImageResponse;
  } catch {
    throw new Error(`Packy returned non-JSON response ${res.status}: ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`Packy API error ${res.status}: ${extractPackyError(data) || text.slice(0, 500)}`);
  }

  const first = data.data?.[0];
  if (!first) {
    throw new Error(`Packy returned no image data: ${JSON.stringify(data).slice(0, 500)}`);
  }

  if (first.b64_json) {
    return { imageBuffer: Buffer.from(first.b64_json, 'base64'), latencyMs, rawResponse: data };
  }

  if (first.url) {
    const imageBuffer = await downloadImage(first.url, signal);
    return { imageBuffer, latencyMs, rawResponse: data, remoteImageUrl: first.url };
  }

  throw new Error(`Packy response contains neither url nor b64_json: ${JSON.stringify(data).slice(0, 500)}`);
}
