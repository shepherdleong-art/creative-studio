/**
 * OpenAI Responses adapter for proxy models exposed only through /v1/responses.
 * Packy returns usable output only through SSE, so streaming is mandatory.
 */

import type { ScriptProviderRuntimeConfig } from './config.ts';
import type { ChatOptions } from './openai-compatible.ts';
import { parseJsonResponse, resolveImageUrl } from './openai-compatible.ts';
import { createScriptProviderRequestControl } from './request-control.ts';
import { readSseStream } from './sse.ts';
import type { ApiStyle, ProviderConfig } from './types.ts';
import { beginLlmUsageCall, finishLlmUsageCall, llmTransportActualCost } from '../usage-llm.ts';
import { safeProviderErrorHint } from './error-diagnostics.ts';
import { runLlmTransport } from './transport-execution.ts';

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

function consumeResponsesEvent(
  payload: string,
  onTextDelta: (accumulated: string) => void,
  onReasoningDelta: (accumulated: string) => void,
  onUsage: (usage: unknown) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error(`OpenAI Responses 返回了无效 SSE JSON: ${payload.slice(0, 300)}`);
  }

  const type = String(event.type || '');
  if (type === 'response.output_text.delta') {
    onTextDelta(String(event.delta || ''));
    return;
  }
  if (type === 'response.reasoning_summary_text.delta') {
    onReasoningDelta(String(event.delta || ''));
    return;
  }
  if (type === 'response.completed' && event.response && typeof event.response === 'object') {
    onUsage((event.response as { usage?: unknown }).usage);
    return;
  }
  if (type === 'response.failed' || type === 'error') {
    throw new Error(`OpenAI Responses 流失败: ${eventErrorMessage(event)}`);
  }
}

interface ResponsesReadOptions {
  onTextDelta?: (accumulated: string) => void;
  onReasoningDelta?: (accumulated: string) => void;
}

async function readResponsesText(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  callbacks: ResponsesReadOptions,
): Promise<{ text: string; usage: unknown }> {
  let text = '';
  let reasoning = '';
  let usage: unknown;
  await readSseStream(body, signal, {
    onLine: (payload) => consumeResponsesEvent(
      payload,
      (delta) => {
        text += delta;
        callbacks.onTextDelta?.(text);
      },
      (delta) => {
        reasoning += delta;
        callbacks.onReasoningDelta?.(reasoning);
      },
      (value) => { usage = value; },
    ),
  });
  return { text, usage };
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
      image_url: resolveImageUrl(image),
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
    reasoning: { summary: 'auto' },
  };

  const requestControl = createScriptProviderRequestControl({
    externalSignal: options.signal,
    timeoutMs: options.timeoutMs,
    defaultTimeoutMs: DEFAULT_RESPONSES_TIMEOUT_MS,
    timeoutMessage: (timeoutMs) => `${config.name} (openai-responses) 请求超时（${timeoutMs}ms）`,
  });
  try {
    const perform = async () => {
      const usageAttempt = runtime ? beginLlmUsageCall(runtime, model, options.usageContext) : null;
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
      if (!response.ok) return { response, errText: await response.text(), rawText: '' };
      if (!response.body) throw new Error('OpenAI Responses 返回了空响应流');
      const streamed = await readResponsesText(response.body, requestControl.signal, {
        onTextDelta: options.onTextDelta,
        onReasoningDelta: options.onReasoningDelta,
      });
      finishLlmUsageCall(usageAttempt, {
        usage: streamed.usage,
        serializedPrompt: JSON.stringify(body.input),
        rawOutput: streamed.text,
        hasImages: Boolean(options.images?.length),
      });
      if (!streamed.text.trim()) throw new Error(`${config.name} (openai-responses) 返回了空响应`);
      return { response, errText: '', rawText: streamed.text };
    };
    const performed = options.executionTransport
      ? await runLlmTransport(options.executionTransport, {
          requestSnapshot: body,
          send: async () => {
            const value = await perform();
            return {
              value,
              terminalState: value.response.ok ? 'succeeded' : 'failed',
              result: value.response.ok ? value.rawText : undefined,
              actualCost: value.response.ok && runtime ? llmTransportActualCost(runtime, model) : null,
              remoteTerminal: true,
              errorCode: value.response.ok ? undefined : `http_${value.response.status}`,
            };
          },
        })
      : await perform();
    if (!performed.response.ok) {
      throw new Error(`${config.name} (openai-responses) 请求失败（HTTP ${performed.response.status}）：${safeProviderErrorHint(performed.errText)}`);
    }
    return performed.rawText;
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
