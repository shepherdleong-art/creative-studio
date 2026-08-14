/**
 * Generic OpenAI-compatible chat completions adapter.
 *
 * Used by Qwen, Kimi, GPT, and optionally Gemini (when GEMINI_API_STYLE=openai-compatible).
 * All providers that speak /v1/chat/completions share this code path.
 */

import type { ProviderConfig, AnalysisInput } from './types';
import type { ScriptProviderRuntimeConfig } from './config';
import { createScriptProviderRequestControl } from './request-control.ts';

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

/**
 * 进程内记忆：某些公司网关模型（如 GPT-5-6-Luna-Standard）只接受默认 temperature，
 * 显式传值会被 400 拒绝。首次命中拒绝后记下 `${baseUrl}|${model}`，
 * 之后调用直接不带 temperature，避免每次都先挨一次 400。
 */
const temperatureUnsupportedModels = new Set<string>();

// ── Low-level chat completion ──

export interface ChatImagePart {
  mimeType: string;
  /** 直连供应商：base64 内联。与 imageUrl 至少提供一个。 */
  imageBase64?: string;
  /** 公司供应商：受控媒体传输产出的预签名 URL（见 lib/cos-media.ts）。 */
  imageUrl?: string;
}

/** 公司供应商走 URL 传输；直连供应商内联 base64 data URL。 */
export function resolveImageUrl(image: ChatImagePart): string {
  if (image.imageUrl) return image.imageUrl;
  if (image.imageBase64) return `data:${image.mimeType};base64,${image.imageBase64}`;
  throw new Error('图片输入缺少可用内容（imageBase64 / imageUrl 均为空）');
}

export interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 非空时，user message 变成多模态 content 数组（文本在前、图片在后）。 */
  images?: ChatImagePart[];
}

/** Normalizes a (trailing-slash-stripped) base URL to the /chat/completions endpoint. */
function buildChatCompletionsUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;
}

export async function chatCompletion(
  config: ProviderConfig,
  options: ChatOptions,
  runtime?: ScriptProviderRuntimeConfig
): Promise<string> {
  const baseUrl = (runtime?.baseUrl || config.defaultBaseUrl).replace(/\/$/, '');
  const apiKey = runtime?.apiKey;
  const model = runtime?.model || config.defaultModel;

  if (!apiKey) {
    throw new Error(`${config.name} API Key 未配置。请在供应商配置页填写。`);
  }

  const chatUrl = buildChatCompletionsUrl(baseUrl);

  const userContent = options.images?.length
    ? [
        { type: 'text', text: options.userPrompt },
        ...options.images.map((image) => ({
          type: 'image_url',
          image_url: { url: resolveImageUrl(image) },
        })),
      ]
    : options.userPrompt;

  const modelKey = `${baseUrl}|${model}`;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: options.maxTokens ?? runtime?.maxTokens ?? config.maxTokens,
  };
  if (!temperatureUnsupportedModels.has(modelKey)) {
    body.temperature = options.temperature ?? 0.7;
  }

  if (options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const requestControl = createScriptProviderRequestControl({
    externalSignal: options.signal,
    timeoutMs: options.timeoutMs,
    defaultTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    timeoutMessage: (timeoutMs) => `${config.name} (openai-compatible) 请求超时（${timeoutMs}ms）`,
  });
  try {
    // 部分公司网关模型（如推理型 GPT-5-6-Luna-Standard）只接受默认 temperature，
    // 显式传值会被上游 400 拒绝。命中该特征错误时摘掉 temperature 重试一次，
    // 并记入进程内名单，后续调用直接跳过该参数。
    const send = async (requestBody: Record<string, unknown>) => fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: requestControl.signal,
    });

    let res = await send(body);
    if (!res.ok) {
      const errText = await res.text();
      const temperatureRejected = res.status === 400
        && 'temperature' in body
        && /temperature/i.test(errText)
        && /does not support|unsupported value|not supported/i.test(errText);
      if (temperatureRejected) {
        temperatureUnsupportedModels.add(modelKey);
        const fallbackBody = { ...body };
        delete fallbackBody.temperature;
        res = await send(fallbackBody);
      }
      if (!res.ok) {
        const fallbackErrText = temperatureRejected ? await res.text() : errText;
        throw new Error(`${config.name} (openai-compatible) error ${res.status}: ${fallbackErrText.slice(0, 500)}`);
      }
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content || '';
    if (!rawText.trim()) throw new Error(`${config.name} 返回了空响应`);
    return rawText;
  } catch (error) {
    return requestControl.rethrow(error);
  } finally {
    requestControl.dispose();
  }
}

// ── JSON extraction ──

export function extractJson(rawText: string): string {
  let text = rawText.trim();
  // Strip markdown code fences
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return text;
}

export function parseJsonResponse<T>(rawText: string, providerName: string): T {
  const jsonText = extractJson(rawText);
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    throw new Error(`${providerName} 返回了无效 JSON。原始回复: ${rawText.slice(0, 500)}`);
  }
}

export async function completeOpenAiCompatibleJson<T>(
  config: ProviderConfig,
  options: Omit<ChatOptions, 'responseFormat'>,
  runtime?: ScriptProviderRuntimeConfig
): Promise<T> {
  const rawText = await chatCompletion(config, { ...options, responseFormat: 'json_object' }, runtime);
  return parseJsonResponse<T>(rawText, config.name);
}

// ── Prompt builders (shared across all providers) ──

export function buildAnalysisPrompt(input: AnalysisInput): string {
  const sellingPointsText = input.sellingPoints
    .filter(Boolean)
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n');

  return `你是一个专业的电商内容策略师。请分析以下产品卖点，根据目标人群和平台特性，为每个卖点排出优先级，并推荐最适合的脚本模版。

## 目标人群
${input.targetAudience || '未指定'}

## 平台
${input.platform || '通用'}

## 卖点列表
${sellingPointsText || '无'}

## 可用脚本模版
- pain_point：直击痛点 —— "你是不是也…" → 放大痛点 → 产品拯救
- scene_seeding：场景种草 —— 打造生活场景 → 产品自然出现 → 向往感拉满
- feature_showcase：功能展示 —— 参数/细节逐一亮相 → 每个镜头讲一个功能
- emotional：情感共鸣 —— 情绪故事先行 → 产品作为陪伴/解决方案出场
- comparison：对比测评 —— 使用前 vs 使用后 / A vs B → 差异可视化
- unboxing：开箱体验 —— 拆包 → 安装 → 第一印象 → 使用感受
- problem_solving：问题解决 —— 抛出具体问题 → 产品如何解决 → 效果验证

## 输出要求
请返回严格 JSON 格式（不要 markdown 代码块），结构如下：

{
  "rankings": [
    {
      "rank": 1,
      "title": "卖点原文",
      "priority": "highest",
      "reason": "为什么这个卖点对这个人群最重要，50字以内",
      "recommendedTemplateId": "pain_point",
      "recommendedTemplateName": "直击痛点",
      "targetHook": "一句话描述这个卖点如何打动目标人群"
    }
  ],
  "audienceInsight": "目标人群的核心决策链分析，50字以内",
  "platformAdvice": "针对该平台的脚本策略建议，50字以内"
}

## 注意事项
- priority 必须是 "highest"、"high"、"medium"、"low" 之一。
- recommendedTemplateId 必须是上面列出的 7 个模版 ID 之一。
- 排名必须覆盖所有输入的卖点。
- 分析要具体，不要泛泛而谈。
- 只返回 JSON，不要有其他内容。`;
}
