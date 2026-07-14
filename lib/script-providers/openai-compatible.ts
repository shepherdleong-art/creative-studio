/**
 * Generic OpenAI-compatible chat completions adapter.
 *
 * Used by Qwen, Kimi, GPT, and optionally Gemini (when GEMINI_API_STYLE=openai-compatible).
 * All providers that speak /v1/chat/completions share this code path.
 */

import type { ProviderConfig, AnalysisInput, ScriptInput } from './types';
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

export function buildScriptPrompt(input: ScriptInput): string {
  const sellingPointsText = input.selectedSellingPoints
    .map((sp, i) => `${i + 1}. ${sp.title}（优先级：${sp.priority}，理由：${sp.reason}）`)
    .join('\n');

  // 图片按此顺序作为 image part 附在本 prompt 之后，与这里的编号一一对应。
  const shotsText = input.shots
    .map((s, i) => `图 ${i + 1}（shotId=${s.shotId}）`)
    .join('\n');

  return `你是一个专业电商短视频脚本策划。本条消息附带了 ${input.shots.length} 张候选分镜图，请**看图**写一条约 ${input.targetDurationSec} 秒的短视频口播脚本。

## 产品信息
- 项目名称：${input.projectName}
- 产品名称：${input.productName || '未填写'}
- 产品编号：${input.productCode || '未填写'}
- 品类：${input.productCategory || '未填写'}
- 目标人群：${input.targetAudience || '未填写'}
- 语气：${input.tone || '种草'}
- 平台：${input.platform || '通用'}
- 目标时长：${input.targetDurationSec} 秒

## 脚本模版：${input.templateName}
${getTemplateInstruction(input.templateId)}

## 选中的重点卖点
${sellingPointsText}

## 候选分镜图（顺序与附带的图片一一对应）
${shotsText}

## 场景参考
${input.sceneReference || '未指定'}

## 运镜模板
${input.videoTemplates?.join('、') || '未指定'}

## 你的任务
1. **看清楚每张图里到底有什么**（主体、材质、工艺细节、使用场景、画面强调了什么）。
2. **挑选**你真正需要的图，**决定它们的先后顺序**，组成一条有叙事的片子。
3. 为**每一张选中的图**写**一句**口播，这句话必须描述**这张图里真实存在的东西**。

## 硬性规则
- **一句口播 = 一张图。** segments 数组的顺序就是成片的画面顺序。
- **文案优先，不要为了用满图而硬凑。** 目标时长决定你写多少句：约 ${input.targetDurationSec} 秒，每句约 5 秒（约 25 个中文字），所以大约需要 ${Math.max(1, Math.round(input.targetDurationSec / 5))} 句、也就是 ${Math.max(1, Math.round(input.targetDurationSec / 5))} 张图。
- **没被你选中的图不会浪费**——它们会成为备用素材，用于替补生成失败的画面。所以**该舍就舍**。
- **绝对不要写图里没有的东西。** 你看不到的卖点，就不要写进口播。
- 每张选中的图必须给 rationale；每张丢弃的图必须给 reason。
- 每个 shotId 只能出现一次（要么在 segments，要么在 droppedShots）。

## 输出要求
请返回严格 JSON 格式（不要 markdown 代码块），结构如下：

{
  "version": 2,
  "title": "脚本标题",
  "platform": "${input.platform || '通用'}",
  "tone": "${input.tone || '种草'}",
  "targetDurationSec": ${input.targetDurationSec},
  "template": "${input.templateName}",
  "shotSetId": "${input.shotSetId}",
  "sellingPointMap": [
    { "shotId": "对应分镜的shotId", "sellingPoint": "本段对应的卖点标题" }
  ],
  "segments": [
    {
      "shotId": "这一段展示哪张图的shotId",
      "narration": "一句口播，约25字，描述这张图里真实存在的东西",
      "subtitle": "字幕文案，通常与 narration 相同",
      "rationale": "这张图里有什么，以及我为什么在这个位置用它"
    }
  ],
  "droppedShots": [
    { "shotId": "没选用的shotId", "reason": "为什么不用它" }
  ],
  "fullScript": "各句 narration 的拼接，纯文本，中文标点，不要换行符或 markdown"
}

## 注意事项
- 卖点要自然融入口播，不要像读说明书。使用模版 "${input.templateName}" 的叙事结构。
- 只返回 JSON，不要有其他内容。`;
}

// ── Template instructions ──

function getTemplateInstruction(templateId: string): string {
  const instructions: Record<string, string> = {
    pain_point: `【直击痛点】
叙事结构："你是不是也…" → 放大痛点 → 产品拯救。
开头直接戳中目标人群的痛点场景，用共鸣感抓住注意力，然后展示产品如何解决这个问题。
口播要有"对，我就是这样"的代入感。`,

    scene_seeding: `【场景种草】
叙事结构：打造生活场景 → 产品自然出现 → 向往感拉满。
用温柔的画面感和细节描写营造一个让人向往的使用场景，产品不刻意推销而是自然融入。
口播要有"我也想要这样的生活"的向往感。`,

    feature_showcase: `【功能展示】
叙事结构：参数/细节逐一亮相 → 每个镜头讲一个核心功能。
一镜一卖点，节奏清晰，用具体参数和细节说服用户。
口播要有"这个设计真的用心了"的认可感。`,

    emotional: `【情感共鸣】
叙事结构：情绪故事先行 → 产品作为陪伴/解决方案出场。
先讲一个目标人群熟悉的情感场景或小故事，再自然引出产品如何陪伴或改善这个场景。
口播要有"被理解到了"的温暖感。`,

    comparison: `【对比测评】
叙事结构：使用前 vs 使用后 / A产品 vs B产品 → 差异可视化。
通过对比突出产品的核心优势，可以是同一场景使用前后的对比，也可以是和传统方案的对比。
口播要有"差别居然这么大"的惊喜感。`,

    unboxing: `【开箱体验】
叙事结构：拆包 → 安装 → 第一印象 → 使用感受。
从收到产品的第一刻开始，一步步展示安装/使用的便捷性，强调细节做工和第一印象。
口播要有"开箱就被惊艳到了"的新鲜感。`,

    problem_solving: `【问题解决】
叙事结构：抛出具体问题 → 产品如何解决 → 效果验证。
先提出一个目标人群常遇到的具体问题，然后展示产品如何优雅解决，最后验证效果。
口播要有"原来可以这样解决"的恍然大悟感。`,
  };

  return instructions[templateId] || instructions.scene_seeding;
}
