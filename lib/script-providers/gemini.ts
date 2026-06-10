/**
 * Gemini-compatible script generation adapter.
 *
 * Supports two API styles:
 * - "native": Gemini generateContent REST API
 * - "openai-compatible": /v1/chat/completions proxy
 *
 * Configure via env:
 *   GEMINI_BASE_URL  — API base (default: https://generativelanguage.googleapis.com)
 *   GEMINI_API_KEY   — API key
 *   GEMINI_MODEL     — Model name (default: gemini-3.5-flash)
 *   GEMINI_API_STYLE — "native" (default) or "openai-compatible"
 */
export interface ScriptInput {
  projectName: string;
  productName: string;
  productCode: string;
  productCategory: string;
  targetAudience: string;
  tone: string;
  platform: string;
  sellingPoints: string[];
  shots: Array<{
    index: number;
    description?: string;
  }>;
  sceneReference?: string;
  videoTemplates?: string[];
}

export interface ScriptOutput {
  title: string;
  platform: string;
  tone: string;
  shots: Array<{
    shotIndex: number;
    duration: string;
    voiceover: string;
    subtitle: string;
    visualIntent: string;
  }>;
  fullScript: string;
}

function buildPrompt(input: ScriptInput): string {
  const sellingPoints = input.sellingPoints?.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n') || '无';

  const shotsDesc = input.shots
    ?.map((s) => `分镜${s.index}${s.description ? `：${s.description}` : ''}`)
    .join('\n') || '无';

  return `你是一个专业电商短视频脚本策划。请根据以下产品信息和分镜顺序，撰写一条 15 秒短视频口播脚本。

## 产品信息
- 项目名称：${input.projectName}
- 产品名称：${input.productName || '未填写'}
- 产品编号：${input.productCode || '未填写'}
- 品类：${input.productCategory || '未填写'}
- 目标人群：${input.targetAudience || '未填写'}
- 语气：${input.tone || '种草'}
- 平台：${input.platform || '通用'}

## 卖点
${sellingPoints}

## 分镜顺序
${shotsDesc}

## 场景参考
${input.sceneReference || '未指定'}

## 运镜模板
${input.videoTemplates?.join('、') || '未指定'}

## 输出要求
请返回严格 JSON 格式（不要 markdown 代码块），结构如下：

{
  "title": "15秒种草口播",
  "platform": "${input.platform || '通用'}",
  "tone": "${input.tone || '种草'}",
  "shots": [
    {
      "shotIndex": 1,
      "duration": "0-5s",
      "voiceover": "口播文案",
      "subtitle": "字幕文案",
      "visualIntent": "这个分镜承担的叙事作用"
    }
  ],
  "fullScript": "完整连贯的口播稿"
}

## 注意事项
- 分镜数量与实际分镜列表严格一致。
- 每段 voiceover 控制在 5 秒内可以自然说完的长度。
- 语气贴近目标平台和目标人群。
- 卖点要自然融入口播，不要像读说明书。
- 只返回 JSON，不要有其他内容。`;
}

export async function generateScript(
  input: ScriptInput
): Promise<{ script: ScriptOutput; provider: string; model: string }> {
  const baseUrl = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const apiStyle = process.env.GEMINI_API_STYLE || 'native';

  if (!apiKey) {
    throw new Error('Gemini API Key 未配置。请在 .env.local 中设置 GEMINI_API_KEY。');
  }

  const prompt = buildPrompt(input);

  let rawText: string;

  if (apiStyle === 'openai-compatible') {
    // OpenAI-compatible /v1/chat/completions
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a professional e-commerce short-video scriptwriter. Always respond with valid JSON only, no markdown fences.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini (openai-compatible) error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    rawText = data.choices?.[0]?.message?.content || '';
  } else {
    // Native Gemini generateContent
    const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini error ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (!rawText.trim()) {
    throw new Error('Gemini 返回了空响应');
  }

  // Strip markdown fences if present
  let jsonText = rawText.trim();
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  let parsed: ScriptOutput;
  try {
    parsed = JSON.parse(jsonText) as ScriptOutput;
  } catch {
    throw new Error(`Gemini 返回了无效 JSON。原始回复: ${rawText.slice(0, 500)}`);
  }

  // Ensure fullScript exists
  if (!parsed.fullScript && parsed.shots?.length) {
    parsed.fullScript = parsed.shots.map((s) => s.voiceover).join('\n');
  }

  return { script: parsed, provider: 'gemini', model };
}
