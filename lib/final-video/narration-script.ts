import type { NarrationDraftBeat } from './types';
import { completeJson } from '../script-providers/index';

type NarrationResponse = { sentences: Array<{ text: string }> };

function parseSentences(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('口播生成响应必须是包含 sentences 数组的对象');
  }
  const sentences = (value as Record<string, unknown>).sentences;
  if (!Array.isArray(sentences)) throw new Error('口播生成响应的 sentences 必须是数组');

  const result = sentences.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as Record<string, unknown>).text !== 'string') {
      throw new Error(`口播生成响应 sentences[${index}].text 必须是字符串`);
    }
    return ((item as Record<string, unknown>).text as string).trim();
  }).filter(Boolean);

  if (result.length === 0) throw new Error('口播生成响应没有可用的自然句');
  return result;
}

export async function generateNarrationDraftBeats(input: {
  sourceText: string;
  targetContentSec: number;
  providerId: string;
}): Promise<NarrationDraftBeat[]> {
  const sourceText = input.sourceText.trim();
  if (!sourceText) throw new Error('sourceText 不能为空');
  if (!Number.isFinite(input.targetContentSec) || input.targetContentSec <= 0) {
    throw new Error('targetContentSec 必须是大于 0 的有限数字');
  }

  const response = await completeJson<NarrationResponse>({
    providerId: input.providerId,
    systemPrompt: 'You write coherent e-commerce narration. Respond with valid JSON only, without markdown fences or commentary.',
    userPrompt: `请将下面的源文案改写为连贯的电商口播，目标内容时长必须围绕 ${input.targetContentSec} 秒。\n\n把口播改写成简短、自然、前后连贯的句子，方便后续独立安排画面。不要把句子绑定到镜头、分镜或画面，也不要输出镜头信息。\n\n只返回以下准确 JSON 结构，不要增加说明：\n{ "sentences": [{ "text": "..." }] }\n\n源文案：\n${sourceText}`,
    temperature: 0.4,
  });

  return parseSentences(response).map((text, index) => {
    const id = `narration-${index}`;
    return { beatId: id, groupId: id, index, text };
  });
}
