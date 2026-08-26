/**
 * Anthropic Messages adapter for providers exposed through POST /v1/messages.
 * Packy Anthropic-compatible groups authenticate with a bearer token; x-api-key
 * is sent as well for compatibility with standard Anthropic Messages servers.
 */

import type { ScriptProviderRuntimeConfig } from './config.ts';
import type { ChatOptions } from './openai-compatible.ts';
import { parseJsonResponse } from './openai-compatible.ts';
import { createScriptProviderRequestControl } from './request-control.ts';
import { readSseStream } from './sse.ts';
import type { ApiStyle, ProviderConfig } from './types.ts';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 120_000;

export function usesAnthropicMessages(apiStyle: ApiStyle): boolean {
  return apiStyle === 'anthropic-messages';
}

function buildMessagesUrl(baseUrl: string): string {
  if (baseUrl.endsWith('/messages')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/messages`;
  return `${baseUrl}/v1/messages`;
}

export async function chatCompletion(
  config: ProviderConfig,
  options: ChatOptions,
  runtime?: ScriptProviderRuntimeConfig,
): Promise<string> {
  const baseUrl = (runtime?.baseUrl || config.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = runtime?.apiKey;
  const model = runtime?.model || config.defaultModel;
  if (!apiKey) throw new Error(`${config.name} API Key 未配置。请在供应商配置页填写。`);

  const userContent = options.images?.length
    ? [
        ...options.images.map((image) => (image.imageUrl
          ? {
              type: 'image',
              source: { type: 'url', url: image.imageUrl },
            }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mimeType,
                data: image.imageBase64,
              },
            })),
        { type: 'text', text: options.userPrompt },
      ]
    : options.userPrompt;

  const body: Record<string, unknown> = {
    model,
    system: options.systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: options.maxTokens ?? runtime?.maxTokens ?? config.maxTokens,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  const streaming = Boolean(options.stream || options.onTextDelta || options.onReasoningDelta);
  if (streaming) {
    body.stream = true;
    body.thinking = { type: 'enabled', budget_tokens: 2048 };
  }

  const requestControl = createScriptProviderRequestControl({
    externalSignal: options.signal,
    timeoutMs: options.timeoutMs,
    defaultTimeoutMs: DEFAULT_ANTHROPIC_TIMEOUT_MS,
    timeoutMessage: (timeoutMs) => `${config.name} (anthropic-messages) 请求超时（${timeoutMs}ms）`,
  });
  try {
    const response = await fetch(buildMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: streaming ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: requestControl.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.name} (anthropic-messages) error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (streaming) {
      if (!response.body) throw new Error(`${config.name} (anthropic-messages) 返回了空响应流`);
      const rawText = await readAnthropicStream(response.body, requestControl.signal, {
        onTextDelta: options.onTextDelta,
        onReasoningDelta: options.onReasoningDelta,
      });
      if (!rawText.trim()) throw new Error(`${config.name} (anthropic-messages) 返回了空响应`);
      return rawText;
    }

    const data = await response.json() as {
      content?: string | Array<{ type?: string; text?: string }>;
    };
    const rawText = typeof data.content === 'string'
      ? data.content
      : (data.content || [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');

    if (!rawText.trim()) throw new Error(`${config.name} (anthropic-messages) 返回了空响应`);
    return rawText;
  } catch (error) {
    return requestControl.rethrow(error);
  } finally {
    requestControl.dispose();
  }
}

async function readAnthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  callbacks: {
    onTextDelta?: (accumulated: string) => void;
    onReasoningDelta?: (accumulated: string) => void;
  },
): Promise<string> {
  let text = '';
  let reasoning = '';
  await readSseStream(body, signal, {
    onLine(payload) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new Error(`Anthropic Messages 返回了无效 SSE JSON: ${payload.slice(0, 300)}`);
      }
      if (event.error) {
        const message = event.error && typeof event.error === 'object' && 'message' in event.error
          ? String((event.error as { message?: unknown }).message || 'unknown error')
          : String(event.error);
        throw new Error(`Anthropic Messages 流失败: ${message}`);
      }
      if (event.type === 'content_block_delta' && event.delta && typeof event.delta === 'object') {
        const delta = event.delta as { type?: unknown; text?: unknown; thinking?: unknown };
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          text += delta.text;
          callbacks.onTextDelta?.(text);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          reasoning += delta.thinking;
          callbacks.onReasoningDelta?.(reasoning);
        }
      }
    },
  });
  return text;
}

export async function completeAnthropicMessagesJson<T>(
  config: ProviderConfig,
  options: Omit<ChatOptions, 'responseFormat'>,
  runtime?: ScriptProviderRuntimeConfig,
): Promise<T> {
  const rawText = await chatCompletion(
    config,
    {
      ...options,
      responseFormat: 'json_object',
      stream: Boolean(options.stream || options.onTextDelta || options.onReasoningDelta),
    },
    runtime,
  );
  return parseJsonResponse<T>(rawText, config.name);
}
