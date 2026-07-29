/**
 * OpenAI Responses adapter for proxy models exposed only through /v1/responses.
 * Packy returns usable output only through SSE, so streaming is mandatory.
 */

import type { ScriptProviderRuntimeConfig } from './config.ts';
import type { ChatOptions } from './openai-compatible.ts';
import { parseJsonResponse } from './openai-compatible.ts';
import { createScriptProviderRequestControl } from './request-control.ts';
import type { ApiStyle, ProviderConfig } from './types.ts';

const DEFAULT_RESPONSES_TIMEOUT_MS = 120_000;

export function usesOpenAiResponses(apiStyle: ApiStyle): boolean {
  return apiStyle === 'openai-responses';
}

type ResponsesChatOptions = ChatOptions & { timeoutMs?: number };

function buildResponsesUrl(baseUrl: string): string {
  if (baseUrl.endsWith('/responses')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

function eventErrorMessage(event: Record<string, unknown>): string {
  const directError = event.error;
  if (typeof directError === 'string') return directError;
  if (directError && typeof directError === 'object' && 'message' in directError) {
    return String((directError as { message?: unknown }).message || 'unknown error');
  }
  const response = event.response;
  if (response && typeof response === 'object' && 'error' in response) {
    const responseError = (response as { error?: unknown }).error;
    if (responseError && typeof responseError === 'object' && 'message' in responseError) {
      return String((responseError as { message?: unknown }).message || 'unknown error');
    }
  }
  return 'unknown error';
}

function consumeSseLine(line: string, deltas: string[]): void {
  const normalized = line.replace(/\r$/, '').trim();
  if (!normalized || normalized.startsWith(':') || !normalized.startsWith('data:')) return;
  const payload = normalized.slice(5).trim();
  if (!payload || payload === '[DONE]') return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error(`OpenAI Responses 返回了无效 SSE JSON: ${payload.slice(0, 300)}`);
  }

  const type = String(event.type || '');
  if (type === 'response.output_text.delta') {
    deltas.push(String(event.delta || ''));
    return;
  }
  if (type === 'response.failed' || type === 'error') {
    throw new Error(`OpenAI Responses 流失败: ${eventErrorMessage(event)}`);
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function readSseText(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<string> {
  if (!body) throw new Error('OpenAI Responses 返回了空响应流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deltas: string[] = [];
  let buffer = '';

  let completed = false;
  try {
    while (true) {
      const { value, done } = await readWithAbort(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeSseLine(line, deltas);
    }

    buffer += decoder.decode();
    if (buffer.trim()) consumeSseLine(buffer, deltas);
    return deltas.join('');
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function chatCompletion(
  config: ProviderConfig,
  options: ResponsesChatOptions,
  runtime?: ScriptProviderRuntimeConfig
): Promise<string> {
  const baseUrl = (runtime?.baseUrl || config.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = runtime?.apiKey;
  const model = runtime?.model || config.defaultModel;
  if (!apiKey) throw new Error(`${config.name} API Key 未配置。请在供应商配置页填写。`);

  const userContent = [
    { type: 'input_text', text: options.userPrompt },
    ...(options.images || []).map((image) => ({
      type: 'input_image',
      image_url: `data:${image.mimeType};base64,${image.imageBase64}`,
    })),
  ];
  const body: Record<string, unknown> = {
    model,
    stream: true,
    input: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_output_tokens: options.maxTokens ?? runtime?.maxTokens ?? config.maxTokens,
  };

  const requestControl = createScriptProviderRequestControl({
    externalSignal: options.signal,
    timeoutMs: options.timeoutMs,
    defaultTimeoutMs: DEFAULT_RESPONSES_TIMEOUT_MS,
    timeoutMessage: (timeoutMs) => `${config.name} (openai-responses) 请求超时（${timeoutMs}ms）`,
  });
  try {
    const response = await fetch(buildResponsesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: requestControl.signal,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.name} (openai-responses) error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const rawText = await readSseText(response.body, requestControl.signal);
    if (!rawText.trim()) throw new Error(`${config.name} (openai-responses) 返回了空响应`);
    return rawText;
  } catch (error) {
    return requestControl.rethrow(error);
  } finally {
    requestControl.dispose();
  }
}

export async function completeOpenAiResponsesJson<T>(
  config: ProviderConfig,
  options: Omit<ChatOptions, 'responseFormat'>,
  runtime?: ScriptProviderRuntimeConfig
): Promise<T> {
  const rawText = await chatCompletion(config, { ...options, responseFormat: 'json_object' }, runtime);
  return parseJsonResponse<T>(rawText, config.name);
}
