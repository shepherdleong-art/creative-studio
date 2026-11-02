import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import {
  executeSyncOperation,
  MediaExecutionFailedError,
  registerSyncOperationContinuation,
  transmitSyncOperation,
  type SyncOperationContext,
  type SyncOperationOutcome,
  type SyncOperationTransport,
} from '../execution/sync-operation.ts';
import { getExecutionModuleRuntime } from '../execution/module-runtime.ts';
import { getDb } from '../../db.ts';

export interface AlignmentWordTiming {
  text: string;
  startUs: number;
  endUs: number;
}
export interface AlignmentAdapter {
  configured: boolean;
  align(input: { audioPath: string; text: string; signal?: AbortSignal; execution?: SyncOperationContext }): Promise<AlignmentWordTiming[]>;
}

export interface AlignmentAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  providerId?: string;
  /** 整次调用（含上传、响应体与重试）的上限；默认两分钟。 */
  timeoutMs?: number;
}

export interface SpeechTranscription {
  text: string;
  words: AlignmentWordTiming[];
  /** 仅映射服务明确的无人声状态；空文本或调用失败不能产生此结论。 */
  noSpeech?: { provider: 'volc'; statusCode: '20000003' };
}
export interface SpeechTranscriptionAdapter {
  configured: boolean;
  readonly identity: Readonly<{ adapterVersion: 'openai-word-transcription/1' | 'volc-flash-asr/1'; model: string; endpointHash: string }>;
  transcribe(input: { audioPath: string; durationUs: number; signal?: AbortSignal; execution?: SyncOperationContext }): Promise<SpeechTranscription>;
}

type AlignmentEnvironment = Readonly<Record<string, string | undefined>>;

const ALIGNMENT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000] as const;

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 30_000);
  return ALIGNMENT_RETRY_DELAYS_MS[Math.min(attempt, ALIGNMENT_RETRY_DELAYS_MS.length - 1)];
}

function transcriptionUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/audio/transcriptions')) return base;
  return base.endsWith('/v1') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

function speechConfig(env: AlignmentEnvironment, fallback?: AlignmentAdapterConfig) {
  const envBaseUrl = (env.FINAL_EDIT_ALIGNMENT_BASE_URL || '').trim();
  const envApiKey = (env.FINAL_EDIT_ALIGNMENT_API_KEY || '').trim();
  const envModel = (env.FINAL_EDIT_ALIGNMENT_MODEL || '').trim();
  const hasDedicatedTransport = Boolean(envBaseUrl || envApiKey);
  const baseUrl = hasDedicatedTransport ? envBaseUrl : (fallback?.baseUrl || '').trim();
  const apiKey = hasDedicatedTransport ? envApiKey : (fallback?.apiKey || '').trim();
  const model = (envModel || fallback?.model || 'whisper-1').trim();
  const timeoutMs = fallback?.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error('声音识别超时配置无效');
  return { baseUrl, apiKey, model, providerId: fallback?.providerId, timeoutMs, configured: Boolean(baseUrl && apiKey && model) };
}

type TranscriptionPayload = {
  text?: unknown;
  words?: Array<{ word?: unknown; start?: unknown; end?: unknown }>;
  status?: number;
  retryAfterMs?: number;
  invalidJson?: boolean;
};

async function requestTranscriptionDirect(config: ReturnType<typeof speechConfig>, input: {
  audioPath: string; prompt?: string; signal?: AbortSignal;
}): Promise<TranscriptionPayload> {
  const { baseUrl, apiKey, model, configured } = config;
  const { audioPath } = input;
  input.signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('声音识别请求超时，请重试或人工核对')), config.timeoutMs);
  timer.unref();
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  try {
    signal.throwIfAborted();
    if (!configured) throw new Error('生产强制对齐尚未配置：需要 FINAL_EDIT_ALIGNMENT_BASE_URL / API_KEY / MODEL');
    const bytes = fs.readFileSync(audioPath);
    let response: Response | null = null;
    for (let attempt = 0; attempt <= ALIGNMENT_RETRY_DELAYS_MS.length; attempt += 1) {
      signal.throwIfAborted();
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (input.prompt !== undefined) form.append('prompt', input.prompt);
      try {
        response = await fetch(transcriptionUrl(baseUrl), {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal,
        });
      } catch {
        signal.throwIfAborted();
        if (attempt >= ALIGNMENT_RETRY_DELAYS_MS.length) {
          throw new Error('强制对齐服务网络错误，请检查连接后重试');
        }
        await delay(ALIGNMENT_RETRY_DELAYS_MS[attempt], undefined, { signal });
        continue;
      }
      if (response.ok) break;
      await response.body?.cancel();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= ALIGNMENT_RETRY_DELAYS_MS.length) {
        throw new Error(`强制对齐服务返回 ${response.status}，请检查服务配置后重试`);
      }
      await delay(retryDelayMs(response, attempt), undefined, { signal });
    }
    if (!response?.ok) throw new Error('强制对齐服务请求失败');
    let payload;
    try { payload = await response.json(); }
    catch { signal.throwIfAborted(); throw new Error('声音识别服务未返回有效的 JSON 结果'); }
    signal.throwIfAborted();
    return payload;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally { clearTimeout(timer); }
}

type AlignmentOperationSnapshot = {
  provider: { baseUrl: string; model: string; providerId?: string };
  audioPath: string;
  audioHash: string;
  prompt?: string;
  httpAttempt: number;
};

const ALIGNMENT_CONTINUATION_KEY = 'media-core.alignment.transcription.v1';

function resolveAlignmentProvider(snapshot: AlignmentOperationSnapshot) {
  const providerId = snapshot.provider.providerId;
  if (providerId) {
    const row = getDb().prepare('SELECT apiKey, keyEnv FROM final_edit_tts_providers WHERE id = ?').get(providerId) as {
      apiKey: string; keyEnv: string;
    } | undefined;
    const apiKey = row?.apiKey.trim() || (row?.keyEnv ? (process.env[row.keyEnv] || '').trim() : '');
    if (apiKey) return { ...snapshot.provider, apiKey };
  }
  const apiKey = (process.env.FINAL_EDIT_ALIGNMENT_API_KEY || '').trim();
  if (!apiKey) throw new Error('转录持久操作的供应商凭据不可用');
  return { ...snapshot.provider, apiKey };
}

async function executeAlignmentOperation(
  transport: SyncOperationTransport,
  snapshot: AlignmentOperationSnapshot,
  liveConfig?: ReturnType<typeof speechConfig>,
  signal?: AbortSignal,
): Promise<TranscriptionPayload> {
  const config = liveConfig ?? resolveAlignmentProvider(snapshot);
  return transmitSyncOperation<TranscriptionPayload>(transport, {
    requestSnapshot: snapshot,
    send: async (): Promise<SyncOperationOutcome<TranscriptionPayload>> => {
      const bytes = fs.readFileSync(snapshot.audioPath);
      if (createHash('sha256').update(bytes).digest('hex') !== snapshot.audioHash) {
        throw new Error('转录音频内容已变化，拒绝使用旧操作身份提交');
      }
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', snapshot.provider.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      if (snapshot.prompt !== undefined) form.append('prompt', snapshot.prompt);
      const response = await fetch(transcriptionUrl(config.baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal,
      });
      if (!response.ok) {
        const status = response.status;
        const retryAfterMs = retryDelayMs(response, snapshot.httpAttempt - 1);
        await response.body?.cancel();
        return {
          value: { status, retryAfterMs },
          terminalState: 'failed' as const,
          errorCode: `http_${status}`,
          actualCost: null,
        };
      }
      try {
        const payload = await response.json() as TranscriptionPayload;
        return { value: payload, terminalState: 'succeeded' as const, result: payload, actualCost: null };
      } catch {
        return { value: { invalidJson: true }, terminalState: 'failed' as const, errorCode: 'invalid_json', actualCost: null };
      }
    },
  });
}

registerSyncOperationContinuation(ALIGNMENT_CONTINUATION_KEY, async (transport, rawSnapshot) => {
  await executeAlignmentOperation(transport, rawSnapshot as AlignmentOperationSnapshot);
});

async function requestTranscriptionServer(
  config: ReturnType<typeof speechConfig>,
  input: { audioPath: string; prompt?: string; signal?: AbortSignal; execution?: SyncOperationContext },
): Promise<TranscriptionPayload> {
  if (!config.configured) throw new Error('生产强制对齐尚未配置：需要 FINAL_EDIT_ALIGNMENT_BASE_URL / API_KEY / MODEL');
  const bytes = fs.readFileSync(input.audioPath);
  const audioHash = createHash('sha256').update(bytes).digest('hex');
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('声音识别请求超时，请重试或人工核对')), config.timeoutMs);
  timer.unref();
  const signal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  try {
    for (let attempt = 0; attempt <= ALIGNMENT_RETRY_DELAYS_MS.length; attempt += 1) {
      signal.throwIfAborted();
      const snapshot: AlignmentOperationSnapshot = {
        provider: { baseUrl: config.baseUrl, model: config.model, providerId: config.providerId },
        audioPath: input.audioPath,
        audioHash,
        prompt: input.prompt,
        httpAttempt: attempt + 1,
      };
      const baseStep = input.execution?.step ?? 'transcription';
      try {
        return await executeSyncOperation({
          context: {
            ...input.execution,
            module: 'alignment',
            taskId: input.execution?.taskId ?? `alignment:${audioHash}`,
            step: `${baseStep}:http:${attempt + 1}`,
            inputRevision: input.execution?.inputRevision ?? createHash('sha256').update(JSON.stringify({ audioHash, prompt: input.prompt, model: config.model })).digest('hex'),
            scope: input.execution?.scope ?? { resourceType: 'narration', resourceId: input.audioPath },
            requiredPools: input.execution?.requiredPools ?? ['tts:remote'],
          },
          inputSnapshot: snapshot,
          continuationKey: ALIGNMENT_CONTINUATION_KEY,
          providerSnapshot: snapshot.provider,
          configVersion: `${config.baseUrl}:${config.model}`,
          credentialVersionRef: config.providerId,
          quote: { kind: 'unpriced', pricingSnapshot: null },
          replay: (result) => result as TranscriptionPayload,
          execute: (transport) => executeAlignmentOperation(transport, snapshot, config, signal),
        });
      } catch (error) {
        if (!(error instanceof MediaExecutionFailedError)) throw error;
        const detail = error.details as { status?: number; retryAfterMs?: number; invalidJson?: boolean } | undefined;
        if (detail?.invalidJson) throw new Error('声音识别服务未返回有效的 JSON 结果');
        const status = detail?.status ?? 0;
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt >= ALIGNMENT_RETRY_DELAYS_MS.length) {
          throw new Error(`强制对齐服务返回 ${status || '未知状态'}，请检查服务配置后重试`);
        }
        await delay(detail?.retryAfterMs ?? ALIGNMENT_RETRY_DELAYS_MS[attempt], undefined, { signal });
      }
    }
    throw new Error('强制对齐服务请求失败');
  } finally {
    clearTimeout(timer);
  }
}

async function requestTranscription(
  config: ReturnType<typeof speechConfig>,
  input: { audioPath: string; prompt?: string; signal?: AbortSignal; execution?: SyncOperationContext },
): Promise<TranscriptionPayload> {
  return getExecutionModuleRuntime()
    ? requestTranscriptionServer(config, input)
    : requestTranscriptionDirect(config, input);
}

export function createOpenAiAlignmentAdapter(
  env: AlignmentEnvironment = process.env,
  fallback?: AlignmentAdapterConfig,
): AlignmentAdapter {
  const config = speechConfig(env, fallback);
  return {
    configured: config.configured,
    async align({ audioPath, text, signal, execution }) {
      const payload = await requestTranscription(config, { audioPath, prompt: text, signal, execution });
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

/** 同一 Whisper 兼容服务的自由转写入口；不传原文提示，也不把空结果解释为“没有人声”。 */
export function createOpenAiTranscriptionAdapter(
  env: AlignmentEnvironment = process.env,
  fallback?: AlignmentAdapterConfig,
): SpeechTranscriptionAdapter {
  const config = speechConfig(env, fallback);
  return { configured: config.configured,
    identity: Object.freeze({ adapterVersion: 'openai-word-transcription/1', model: config.model,
      endpointHash: createHash('sha256').update(transcriptionUrl(config.baseUrl)).digest('hex') }),
    async transcribe({ audioPath, durationUs, signal, execution }) {
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0) throw new Error('转写需要已核验的真实音频长度');
    const payload = await requestTranscription(config, { audioPath, signal, execution });
    if (!payload || typeof payload.text !== 'string' || !payload.text.trim() || !Array.isArray(payload.words) || !payload.words.length) {
      throw new Error('未取得完整台词及逐词时间，请重试或人工核对原声');
    }
    let previousEnd = 0;
    const words = payload.words.map(word => {
      if (!word || typeof word.word !== 'string' || !word.word.trim()
        || typeof word.start !== 'number' || typeof word.end !== 'number') throw new Error('转写的逐词时间格式无效');
      const startUs = Math.round(word.start * 1_000_000), endUs = Math.round(word.end * 1_000_000);
      if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs) || startUs < previousEnd
        || endUs <= startUs || endUs > durationUs) throw new Error('转写的逐词时间越界或倒退');
      previousEnd = endUs;
      return { text: word.word.trim(), startUs, endUs };
    });
    const text = payload.text.trim();
    if (!/[\p{L}\p{N}]/u.test(text) || speechContent(text) !== speechContent(words.map(word => word.text).join(''))) throw new Error('台词与逐词时间不一致，请核对原声');
    return { text, words };
  } };
}

/** 表情符号不朗读：配音前去掉，核对台词时也不算。 */
export const SPEECH_EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** 忽略句读、空白、表情符号与字母大小写；保留数字的小数点、正负号、百分号等含义。 */
export function speechContent(text: string): string {
  return text.normalize('NFKC').replace(SPEECH_EMOJI, '').replace(/[\s，。！？；：、!?;:…“”‘’"'（）()【】\[\]]/gu, '')
    .replace(/(?<!\p{N})[.,]|[.,](?!\p{N})/gu, '').toLowerCase();
}
