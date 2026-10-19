import fs from 'node:fs';

export interface AlignmentWordTiming {
  text: string;
  startUs: number;
  endUs: number;
}
export interface AlignmentAdapter {
  configured: boolean;
  align(input: { audioPath: string; text: string }): Promise<AlignmentWordTiming[]>;
}

export interface AlignmentAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
}

type AlignmentEnvironment = Readonly<Record<string, string | undefined>>;

const ALIGNMENT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000] as const;

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 30_000);
  return ALIGNMENT_RETRY_DELAYS_MS[Math.min(attempt, ALIGNMENT_RETRY_DELAYS_MS.length - 1)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transcriptionUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/audio/transcriptions')) return base;
  return base.endsWith('/v1') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

export function createOpenAiAlignmentAdapter(
  env: AlignmentEnvironment = process.env,
  fallback?: AlignmentAdapterConfig,
): AlignmentAdapter {
  const envBaseUrl = (env.FINAL_EDIT_ALIGNMENT_BASE_URL || '').trim();
  const envApiKey = (env.FINAL_EDIT_ALIGNMENT_API_KEY || '').trim();
  const envModel = (env.FINAL_EDIT_ALIGNMENT_MODEL || '').trim();
  const hasDedicatedTransport = Boolean(envBaseUrl || envApiKey);
  const baseUrl = hasDedicatedTransport ? envBaseUrl : (fallback?.baseUrl || '').trim();
  const apiKey = hasDedicatedTransport ? envApiKey : (fallback?.apiKey || '').trim();
  const model = (envModel || fallback?.model || 'whisper-1').trim();
  const configured = Boolean(baseUrl && apiKey && model);
  return {
    configured,
    async align({ audioPath, text }) {
      if (!configured) throw new Error('生产强制对齐尚未配置：需要 FINAL_EDIT_ALIGNMENT_BASE_URL / API_KEY / MODEL');
      const bytes = fs.readFileSync(audioPath);
      let response: Response | null = null;
      for (let attempt = 0; attempt <= ALIGNMENT_RETRY_DELAYS_MS.length; attempt += 1) {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav');
        form.append('model', model);
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'word');
        form.append('prompt', text);
        try {
          response = await fetch(transcriptionUrl(baseUrl), {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
          });
        } catch (error) {
          if (attempt >= ALIGNMENT_RETRY_DELAYS_MS.length) {
            throw new Error(`强制对齐服务网络错误: ${error instanceof Error ? error.message : String(error)}`);
          }
          await sleep(ALIGNMENT_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        if (response.ok) break;
        const body = await response.text();
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= ALIGNMENT_RETRY_DELAYS_MS.length) {
          throw new Error(`强制对齐服务返回 ${response.status}: ${body.slice(0, 300)}`);
        }
        await sleep(retryDelayMs(response, attempt));
      }
      if (!response?.ok) throw new Error('强制对齐服务请求失败');
      const payload = await response.json() as { words?: Array<{ word?: string; start?: number; end?: number }> };
      const words = (payload.words || []).map((word) => ({
        text: String(word.word || '').trim(),
        startUs: Math.round(Number(word.start || 0) * 1_000_000),
        endUs: Math.round(Number(word.end || 0) * 1_000_000),
      })).filter((word) => word.text && word.endUs > word.startUs);
      if (words.length === 0) throw new Error('强制对齐服务没有返回逐词时间戳');
      return words;
    },
  };
}
