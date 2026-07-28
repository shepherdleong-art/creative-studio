/**
 * Generic OpenAI-compatible chat completions adapter.
 *
 * Used by Qwen, Kimi, GPT, and optionally Gemini (when GEMINI_API_STYLE=openai-compatible).
 * All providers that speak /v1/chat/completions share this code path.
 */

import type { ProviderConfig, AnalysisInput } from './types';
import type { ScriptProviderRuntimeConfig } from './config';

// ── Low-level chat completion ──

export interface ChatImagePart {
  mimeType: string;
  imageBase64: string;
}

export interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
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
          image_url: { url: `data:${image.mimeType};base64,${image.imageBase64}` },
        })),
      ]
    : options.userPrompt;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? runtime?.maxTokens ?? config.maxTokens,
  };

  if (options.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${config.name} (openai-compatible) error ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const rawText = data.choices?.[0]?.message?.content || '';

  if (!rawText.trim()) {
    throw new Error(`${config.name} 返回了空响应`);
  }

  return rawText;
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
