/**
 * Generic OpenAI-compatible chat completions adapter.
 *
 * Used by Qwen, Kimi, GPT, and optionally Gemini (when GEMINI_API_STYLE=openai-compatible).
 * All providers that speak /v1/chat/completions share this code path.
 */

import type { ProviderConfig, AnalysisInput, ScriptInput } from './types';
import type { ScriptProviderRuntimeConfig } from './config';

// ── Low-level chat completion ──

export interface ChatOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
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

  const chatUrl = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
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

  const shotsText = input.shots
    .map((s) => `分镜 ${s.shotIndex}（shotId=${s.shotId}）：${s.sourceFilename}${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');

  return `你是一个专业电商短视频脚本策划。请根据以下信息撰写一条 ${input.duration} 短视频口播脚本。

## 产品信息
- 项目名称：${input.projectName}
- 产品名称：${input.productName || '未填写'}
- 产品编号：${input.productCode || '未填写'}
- 品类：${input.productCategory || '未填写'}
- 目标人群：${input.targetAudience || '未填写'}
- 语气：${input.tone || '种草'}
- 平台：${input.platform || '通用'}
- 时长：${input.duration}

## 脚本模版：${input.templateName}
${getTemplateInstruction(input.templateId)}

## 选中的重点卖点
${sellingPointsText}

## 分镜顺序
${shotsText}

## 场景参考
${input.sceneReference || '未指定'}

## 运镜模板
${input.videoTemplates?.join('、') || '未指定'}

## 输出要求
请返回严格 JSON 格式（不要 markdown 代码块），结构如下：

{
  "title": "脚本标题",
  "platform": "${input.platform || '通用'}",
  "tone": "${input.tone || '种草'}",
  "duration": "${input.duration}",
  "template": "${input.templateName}",
  "shotSetId": "${input.shotSetId}",
  "sellingPointMap": [
    { "shotId": "对应分镜的shotId", "shotIndex": 1, "sellingPoint": "本段对应的卖点标题" }
  ],
  "shots": [
    {
      "shotId": "对应分镜的shotId",
      "shotIndex": 1,
      "duration": "0-5s",
      "voiceover": "口播文案",
      "subtitle": "字幕文案",
      "visualIntent": "这个分镜承担的叙事作用"
    }
  ],
  "fullScript": "连续完整口播稿，纯文本，按句使用中文标点（。，！？），不要换行符或 markdown"
}

## 注意事项
- 分镜数量与实际分镜列表严格一致，shotId 必须与上面列出的一致。
- 每个分镜的 voiceover 控制在适合 ${input.duration} 时长内可以自然说完的长度。
- 卖点要自然融入口播，不要像读说明书。使用模版 "${input.templateName}" 的叙事结构。
- fullScript 是连续口播全文，适合直接粘贴到剪映做智能配音。使用中文标点断句。
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
