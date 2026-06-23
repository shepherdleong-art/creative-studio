import fs from 'fs';
import path from 'path';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  type: 'openai-compatible';
  enabled: boolean;
  defaultCostPerImage?: number;
}

export interface EditImageRequest {
  provider: Provider;
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
  quality: string;
}

export interface EditImageResult {
  imageBuffer: Buffer;
  latencyMs: number;
  rawResponse?: unknown;
}

// These providers expect the singular `image` field, not the OpenAI-standard `image[]`
const SINGULAR_IMAGE_FIELD_HOSTS = new Set(['api.gpt.ge', 'api.v3.cm']);

function shouldUseSingularImageField(baseUrl: string): boolean {
  try {
    return SINGULAR_IMAGE_FIELD_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return Array.from(SINGULAR_IMAGE_FIELD_HOSTS).some(h => baseUrl.includes(h));
  }
}

/**
 * Call an OpenAI-compatible /v1/images/edits endpoint.
 *
 * Uses `image[]` multi-image format (OpenAI standard) rather than `reference_images`
 * which many compatible providers (including Packy) do not recognize.
 *
 * When reference images are present, a structural prefix is prepended to the prompt
 * so the model knows which image is the base and which are references.
 */
export async function editImage(
  request: EditImageRequest,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<EditImageResult> {
  const startTime = Date.now();
  const hasRefs = request.referenceImagePaths.length > 0;
  const useGptGeForm = shouldUseSingularImageField(baseUrl);
  const imageFieldName = useGptGeForm ? 'image' : 'image[]';

  const form = new FormData();
  form.append('model', request.model);
  form.append('size', request.size);
  form.append('quality', request.quality);
  form.append('n', '1');
  if (!useGptGeForm) {
    form.append('response_format', 'b64_json');
  }

  // ── Build prompt with structural prefix when refs present ──
  let finalPrompt = request.prompt;
  if (hasRefs) {
    finalPrompt = [
      '输入图片顺序如下：',
      '图1 是待编辑底图，是本次修改的主要对象。',
      `图2 到图${request.referenceImagePaths.length + 1} 是参考图，只用于参考场景、风格、光线、材质、构图、产品或人物一致性。`,
      '不要把参考图当成最终画面的主体，不要把参考图整体复制进结果。',
      '',
      '用户修改要求：',
      request.prompt,
    ].join('\n');
  }
  form.append('prompt', finalPrompt);

  // ── Append images in the provider's expected multipart field ──
  // 图1 = 底图, 图2-N = 参考图
  const inputBuffer = fs.readFileSync(request.inputImagePath);
  const inputFilename = path.basename(request.inputImagePath);
  form.append(imageFieldName, new Blob([inputBuffer], { type: request.inputMimeType }), inputFilename);

  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    const refPath = request.referenceImagePaths[i];
    const refMime = request.referenceMimeTypes[i] || 'image/png';
    const refBuffer = fs.readFileSync(refPath);
    const refFilename = path.basename(refPath);
    form.append(imageFieldName, new Blob([refBuffer], { type: refMime }), refFilename);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/v1/images/edits`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal,
  });

  const latencyMs = Date.now() - startTime;

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error ${response.status}: ${errorBody}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  const firstResult = data.data?.[0];
  if (!firstResult) {
    throw new Error('No result from API');
  }

  let imageBuffer: Buffer;

  if (firstResult.b64_json) {
    imageBuffer = Buffer.from(firstResult.b64_json, 'base64');
  } else if (firstResult.url) {
    const urlResponse = await fetch(firstResult.url, { signal });
    const arrayBuffer = await urlResponse.arrayBuffer();
    imageBuffer = Buffer.from(arrayBuffer);
  } else {
    throw new Error('Response contains neither b64_json nor url');
  }

  return {
    imageBuffer,
    latencyMs,
    rawResponse: data,
  };
}
