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

/**
 * Call an OpenAI-compatible /v1/images/edits endpoint.
 *
 * @param request  - Edit parameters, image paths, and real MIME types.
 * @param apiKey   - The API key (from DB or env).
 * @param baseUrl  - The provider's base URL.
 * @param signal   - AbortSignal to cancel the fetch mid-flight.
 */
export async function editImage(
  request: EditImageRequest,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<EditImageResult> {
  const startTime = Date.now();

  const form = new FormData();
  form.append('prompt', request.prompt);
  form.append('model', request.model);
  form.append('size', request.size);
  form.append('quality', request.quality);
  form.append('n', '1');
  form.append('response_format', 'b64_json');

  // Append input image with its real MIME type
  const inputBuffer = fs.readFileSync(request.inputImagePath);
  const inputFilename = path.basename(request.inputImagePath);
  const inputBlob = new Blob([inputBuffer], { type: request.inputMimeType });
  form.append('image', inputBlob, inputFilename);

  // Append reference images with their real MIME types
  for (let i = 0; i < request.referenceImagePaths.length; i++) {
    const refPath = request.referenceImagePaths[i];
    const refMime = request.referenceMimeTypes[i] || 'image/png';
    const refBuffer = fs.readFileSync(refPath);
    const refFilename = path.basename(refPath);
    const refBlob = new Blob([refBuffer], { type: refMime });
    form.append('reference_images', refBlob, refFilename);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/v1/images/edits`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    signal, // Pass AbortSignal so cancel/timeout truly interrupts the request
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
