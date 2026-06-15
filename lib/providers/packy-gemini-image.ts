import fs from 'fs';

export interface PackyGeminiImageRequest {
  model: string;
  prompt: string;
  inputImagePath: string;
  inputMimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  referenceImagePaths: string[];
  referenceMimeTypes: ('image/png' | 'image/jpeg' | 'image/webp')[];
  size: string;
}

export interface PackyGeminiImageResult {
  imageBuffer: Buffer;
  latencyMs: number;
  rawResponse?: unknown;
  remoteImageUrl?: string;
}

type ChatContentPart = {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
};

type PackyGeminiChatPayload = {
  model: string;
  stream: false;
  messages: Array<{
    role: 'user';
    content: ChatContentPart[];
  }>;
};

type PackyGeminiResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<unknown>;
    };
  }>;
  error?: string | { message?: string; code?: string };
};

function fileToDataUrl(filePath: string, mimeType: string): string {
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function extractPackyError(data: PackyGeminiResponse): string | undefined {
  if (!data.error) return undefined;
  if (typeof data.error === 'string') return data.error;
  return data.error.message || data.error.code;
}

function extractTextFromContent(content: string | Array<unknown> | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as { text?: unknown; image_url?: { url?: unknown }; url?: unknown; b64_json?: unknown };
      if (typeof p.text === 'string') return p.text;
      if (typeof p.image_url?.url === 'string') return p.image_url.url;
      if (typeof p.url === 'string') return p.url;
      if (typeof p.b64_json === 'string') return `data:image/png;base64,${p.b64_json}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function buildPackyGeminiChatPayload({
  model,
  prompt,
  inputImageDataUrl,
  referenceImageDataUrls,
  size,
}: {
  model: string;
  prompt: string;
  inputImageDataUrl: string;
  referenceImageDataUrls: string[];
  size: string;
}): PackyGeminiChatPayload {
  const hasRefs = referenceImageDataUrls.length > 0;
  const text = [
    '输入图片顺序如下：',
    '图1 是待编辑底图，是本次修改的主要对象。',
    hasRefs
      ? `图2 到图${referenceImageDataUrls.length + 1} 是参考图，只用于参考场景、风格、光线、材质、构图、产品或人物一致性。`
      : '本次没有额外参考图，请基于图1生成新的结果。',
    '不要添加文字。',
    `输出尺寸/比例要求：${size}。`,
    '',
    '用户修改要求：',
    prompt,
  ].join('\n');

  return {
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: inputImageDataUrl } },
          ...referenceImageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  };
}

export function extractPackyGeminiImageSource(data: PackyGeminiResponse): string | undefined {
  const content = data.choices?.[0]?.message?.content;
  const text = extractTextFromContent(content);
  if (!text) return undefined;

  const dataUrl = text.match(/data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/i)?.[0];
  if (dataUrl) return dataUrl;

  const imageUrl = text.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp)(?:\?[^\s)"']*)?/i)?.[0];
  if (imageUrl) return imageUrl;

  return text.match(/https?:\/\/[^\s)"']+(?:format|output_format|mime|content-type)=image?(?:%2F|\/)?(?:png|jpe?g|webp)[^\s)"']*/i)?.[0]
    || text.match(/https?:\/\/[^\s)"']+(?:format|output_format)=(?:png|jpe?g|webp)[^\s)"']*/i)?.[0];
}

async function downloadImage(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Packy Gemini image download failed ${res.status}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function decodeDataUrl(dataUrl: string): Buffer {
  const base64 = dataUrl.split(',', 2)[1];
  if (!base64) throw new Error('Packy Gemini returned malformed data URL');
  return Buffer.from(base64, 'base64');
}

export async function editImagePackyGemini(
  request: PackyGeminiImageRequest,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<PackyGeminiImageResult> {
  const startTime = Date.now();
  const cleanBase = baseUrl.replace(/\/$/, '');
  const url = `${cleanBase}/v1/chat/completions`;
  const payload = buildPackyGeminiChatPayload({
    model: request.model,
    prompt: request.prompt,
    inputImageDataUrl: fileToDataUrl(request.inputImagePath, request.inputMimeType),
    referenceImageDataUrls: request.referenceImagePaths.map((filePath, index) =>
      fileToDataUrl(filePath, request.referenceMimeTypes[index] || 'image/png')
    ),
    size: request.size,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  const latencyMs = Date.now() - startTime;
  const text = await res.text();
  let data: PackyGeminiResponse;
  try {
    data = JSON.parse(text) as PackyGeminiResponse;
  } catch {
    const prefix = !res.ok ? `Packy API error ${res.status}` : `Packy Gemini returned non-JSON response ${res.status}`;
    throw new Error(`${prefix}: ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`Packy API error ${res.status}: ${extractPackyError(data) || text.slice(0, 500)}`);
  }

  const imageSource = extractPackyGeminiImageSource(data);
  if (!imageSource) {
    throw new Error(`Packy Gemini returned no image data: ${JSON.stringify(data).slice(0, 500)}`);
  }

  if (imageSource.startsWith('data:')) {
    return { imageBuffer: decodeDataUrl(imageSource), latencyMs, rawResponse: data };
  }

  return {
    imageBuffer: await downloadImage(imageSource, signal),
    latencyMs,
    rawResponse: data,
    remoteImageUrl: imageSource,
  };
}
