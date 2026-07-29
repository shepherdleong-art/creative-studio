/**
 * Anthropic Messages adapter for providers exposed through POST /v1/messages.
 * Packy Anthropic-compatible groups authenticate with a bearer token; x-api-key
 * is sent as well for compatibility with standard Anthropic Messages servers.
 */

import type { ScriptProviderRuntimeConfig } from './config';
import type { ChatOptions } from './openai-compatible';
import { parseJsonResponse } from './openai-compatible';
import type { ApiStyle, ProviderConfig } from './types';

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
        ...options.images.map((image) => ({
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

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_ANTHROPIC_TIMEOUT_MS));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  try {
    const response = await fetch(buildMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${config.name} (anthropic-messages) error ${response.status}: ${errorText.slice(0, 500)}`);
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
    if (options.signal?.aborted) throw new Error('脚本生成已取消');
    if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error(`${config.name} (anthropic-messages) 请求超时（${timeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeAnthropicMessagesJson<T>(
  config: ProviderConfig,
  options: Omit<ChatOptions, 'responseFormat'>,
  runtime?: ScriptProviderRuntimeConfig,
): Promise<T> {
  const rawText = await chatCompletion(config, { ...options, responseFormat: 'json_object' }, runtime);
  return parseJsonResponse<T>(rawText, config.name);
}
