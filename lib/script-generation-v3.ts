import { splitCoverTitle } from './final-edit/domain.ts';
import {
  buildScriptDurationBudget,
  countScriptContentCharacters,
  estimateNarrationDurationSec,
} from './script-duration-policy.ts';
import {
  chooseFallbackScriptTemplate,
  getScriptTemplate,
  SCRIPT_TEMPLATES,
} from './script-templates.ts';
import { normalizeAutomaticSubtitleText } from './subtitle-display.ts';
import type {
  AnalysisInput,
  ScriptOutputV3,
  ScriptSegmentV3,
  ScriptStrategyAnalysisV3,
  SelectedSellingPoint,
} from './script-providers/types.ts';
import type { MixcutTaskScriptSnapshot } from './final-edit/mixcut-script.ts';

type JsonObject = Record<string, unknown>;

export interface CompleteJsonRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  images?: Array<{ mimeType: string; imageBase64: string }>;
}

export interface ScriptGenerationV3Dependencies {
  completeJson(input: CompleteJsonRequest): Promise<unknown>;
}

export interface ScriptGenerationInputV3 {
  projectName: string;
  productName: string;
  productCode: string;
  productCategory: string;
  targetAudience: string;
  tone: string;
  platform: string;
  selectedSellingPoints: SelectedSellingPoint[];
  templateId: string;
  templateName: string;
  targetDurationSec: number;
  shotSetId: string;
}

export interface ScriptGenerationV3ErrorDetails {
  targetNarrationSec: number;
  estimatedNarrationSec: number;
  contentCharacterCount: number;
  targetCharacterRange: [number, number];
  attempts: number;
}

export class ScriptGenerationV3Error extends Error {
  readonly code: 'script_duration_unresolved' | 'script_contract_invalid';
  readonly details: ScriptGenerationV3ErrorDetails;

  constructor(
    code: 'script_duration_unresolved' | 'script_contract_invalid',
    message: string,
    details: ScriptGenerationV3ErrorDetails,
  ) {
    super(message);
    this.name = 'ScriptGenerationV3Error';
    this.code = code;
    this.details = details;
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r?\n/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
}

function stringArray(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map(string).filter(Boolean).filter((item, index, values) => values.indexOf(item) === index).slice(0, limit)
    : [];
}

function titleContentLength(value: string): number {
  return Array.from(value.replace(/[^\p{L}\p{N}]/gu, '')).length;
}

function titleFits(value: string, range: [number, number]): boolean {
  const length = titleContentLength(value);
  return length >= range[0] && length <= range[1];
}

function titleKey(value: string): string {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase();
}

function titlesAreComplementary(primary: string, secondary: string): boolean {
  const primaryKey = titleKey(primary);
  const secondaryKey = titleKey(secondary);
  return Boolean(primaryKey && secondaryKey)
    && primaryKey !== secondaryKey
    && !primaryKey.includes(secondaryKey)
    && !secondaryKey.includes(primaryKey);
}

function normalizeTitleParts(
  raw: JsonObject,
  fallbackTitle: string,
  selectedSellingPoints: SelectedSellingPoint[],
): ScriptOutputV3['coverTitleParts'] {
  const rawParts = object(raw.coverTitleParts);
  const primary = string(rawParts.primary);
  const secondary = string(rawParts.secondary);
  if (titleFits(primary, [4, 10]) && titleFits(secondary, [6, 14]) && titlesAreComplementary(primary, secondary)) {
    return { primary, secondary, source: 'model' };
  }

  const split = splitCoverTitle(fallbackTitle);
  const primaryCandidates = [split.primary, fallbackTitle, ...selectedSellingPoints.map((point) => point.title), '产品推荐'];
  const fallbackPrimary = primaryCandidates.map(string).find((candidate) => titleFits(candidate, [4, 10])) || '产品推荐';
  const secondaryCandidates = [split.secondary, ...selectedSellingPoints.map((point) => point.title), '值得认真看看'];
  const fallbackSecondary = secondaryCandidates
    .map(string)
    .find((candidate) => titleFits(candidate, [6, 14]) && titlesAreComplementary(fallbackPrimary, candidate))
    || '值得认真看看';
  return {
    primary: fallbackPrimary,
    secondary: fallbackSecondary,
    source: 'system_split',
  };
}

function normalizeSegments(raw: JsonObject, input: ScriptGenerationInputV3): ScriptSegmentV3[] {
  const allowedSellingPoints = new Set(input.selectedSellingPoints.map((point) => point.title));
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  const usedIds = new Set<string>();
  const segments: ScriptSegmentV3[] = [];
  rawSegments.forEach((value, index) => {
    const source = object(value);
    const narration = string(source.narration);
    if (!narration) return;
    let id = string(source.id) || `segment-${index + 1}`;
    if (usedIds.has(id)) id = `segment-${index + 1}`;
    usedIds.add(id);
    const sellingPointRefs = stringArray(source.sellingPointRefs)
      .filter((reference) => allowedSellingPoints.has(reference));
    const visualKeywords = stringArray(source.visualKeywords)
      .map((keyword) => Array.from(keyword).slice(0, 20).join(''));
    segments.push({
      id,
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      sellingPointRefs,
      visualIntent: string(source.visualIntent) || '产品使用场景',
      visualKeywords,
    });
  });
  return segments;
}

function normalizeCandidate(rawValue: unknown, input: ScriptGenerationInputV3): {
  script: ScriptOutputV3;
  qualification: 'qualified' | 'too_short' | 'too_long';
} {
  const raw = object(rawValue);
  const segments = normalizeSegments(raw, input);
  if (segments.length === 0) throw new Error('segments_required');
  const title = string(raw.title) || `${input.productName || input.projectName || '产品'}口播脚本`;
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  const fullSubtitle = segments.map((segment) => segment.subtitle).join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  const estimatedNarrationDurationSec = estimateNarrationDurationSec(contentCharacterCount);
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const qualification = contentCharacterCount < budget.minContentCharacters
    ? 'too_short'
    : contentCharacterCount > budget.maxContentCharacters ? 'too_long' : 'qualified';
  return {
    qualification,
    script: {
      version: 3,
      title,
      coverTitleParts: normalizeTitleParts(raw, title, input.selectedSellingPoints),
      platform: input.platform,
      tone: input.tone,
      templateId: input.templateId,
      template: input.templateName,
      shotSetId: input.shotSetId,
      targetDurationSec: input.targetDurationSec,
      targetNarrationDurationSec: budget.targetNarrationSec,
      contentCharacterCount,
      estimatedNarrationDurationSec,
      durationStatus: 'qualified',
      durationPolicyVersion: budget.policyVersion,
      segments,
      fullScript,
      fullSubtitle,
    },
  };
}

function generationPrompt(input: ScriptGenerationInputV3): string {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  return JSON.stringify({
    task: 'generate_script_v3',
    product: {
      name: input.productName,
      code: input.productCode,
      category: input.productCategory,
    },
    audience: input.targetAudience,
    platform: input.platform,
    tone: input.tone,
    template: { id: input.templateId, name: input.templateName },
    selectedSellingPoints: input.selectedSellingPoints,
    duration: {
      targetTotalSec: budget.targetTotalSec,
      targetNarrationSec: budget.targetNarrationSec,
      targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
    },
    requirements: [
      '只生成带自然标点的口播，不选择或绑定具体图片、shotId 或素材顺序',
      '返回独立主标题和副标题，正文只能使用已选卖点中的事实',
      '每段返回 narration、sellingPointRefs、visualIntent、visualKeywords',
      '返回完整 JSON；字幕、全文、时长和 ID 由服务端派生',
    ],
  });
}

export async function analyzeScriptStrategyV3(
  input: AnalysisInput,
  dependencies: ScriptGenerationV3Dependencies,
): Promise<ScriptStrategyAnalysisV3> {
  const raw = object(await dependencies.completeJson({
    systemPrompt: '你是电商短视频内容策略师。只返回 JSON，不分析或索取图片。',
    userPrompt: JSON.stringify({
      task: 'analyze_script_strategy_v3',
      ...input,
      allowedTemplates: SCRIPT_TEMPLATES.map(({ id, name }) => ({ id, name })),
      requirements: ['给出卖点统一排序', '只推荐一个综合模板', '不分析分镜图片'],
    }),
    temperature: 0.5,
  }));
  const inputSellingPoints = new Set(input.sellingPoints);
  const rankings = (Array.isArray(raw.rankings) ? raw.rankings : [])
    .map((value, index) => {
      const ranking = object(value);
      const title = string(ranking.title);
      const priority = ['highest', 'high', 'medium', 'low'].includes(String(ranking.priority))
        ? ranking.priority as 'highest' | 'high' | 'medium' | 'low'
        : index === 0 ? 'highest' : 'medium';
      return { rank: index + 1, title, priority, reason: string(ranking.reason) };
    })
    .filter((ranking) => ranking.title && inputSellingPoints.has(ranking.title));
  const missing = input.sellingPoints.filter((title) => !rankings.some((ranking) => ranking.title === title));
  missing.forEach((title) => rankings.push({
    rank: rankings.length + 1,
    title,
    priority: rankings.length === 0 ? 'highest' : 'medium',
    reason: '根据用户输入保留',
  }));
  rankings.sort((a, b) => a.rank - b.rank).forEach((ranking, index) => { ranking.rank = index + 1; });

  const rawRecommendation = object(raw.recommendedTemplate);
  const modelTemplate = getScriptTemplate(string(rawRecommendation.id));
  const recommendation = modelTemplate || chooseFallbackScriptTemplate(input.platform);
  return {
    version: 3,
    rankings,
    audienceInsight: string(raw.audienceInsight),
    platformAdvice: string(raw.platformAdvice),
    recommendedTemplate: {
      id: recommendation.id,
      name: recommendation.name,
      reason: string(rawRecommendation.reason) || '根据平台与优先卖点确定',
    },
    recommendationSource: modelTemplate ? 'model' : 'system_fallback',
  };
}

export async function generateScriptV3(
  input: ScriptGenerationInputV3,
  dependencies: ScriptGenerationV3Dependencies,
): Promise<{ script: ScriptOutputV3; attempts: number }> {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  let prompt = generationPrompt(input);
  let lastScript: ScriptOutputV3 | null = null;
  let lastQualification: 'too_short' | 'too_long' | 'contract_invalid' = 'contract_invalid';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await dependencies.completeJson({
      systemPrompt: '你是电商短视频口播编剧。只返回完整 JSON，不看图、不绑定素材。',
      userPrompt: prompt,
      temperature: attempt === 1 ? 0.7 : 0.4,
    });
    try {
      const normalized = normalizeCandidate(raw, input);
      lastScript = normalized.script;
      if (normalized.qualification === 'qualified') return { script: normalized.script, attempts: attempt };
      lastQualification = normalized.qualification;
      prompt = JSON.stringify({
        task: 'rewrite_complete_script_v3',
        issue: normalized.qualification,
        targetNarrationSec: budget.targetNarrationSec,
        targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
        currentContentCharacterCount: normalized.script.contentCharacterCount,
        currentEstimatedNarrationSec: normalized.script.estimatedNarrationDurationSec,
        selectedSellingPoints: input.selectedSellingPoints,
        previousResult: raw,
        requirements: ['完整重写自然句', '保留已选卖点且禁止新增事实', '返回完整 JSON，不返回 diff，不截断字符串末尾'],
      });
    } catch {
      lastQualification = 'contract_invalid';
      prompt = JSON.stringify({
        task: 'rewrite_complete_script_v3',
        issue: 'contract_invalid',
        targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
        selectedSellingPoints: input.selectedSellingPoints,
        requirements: ['至少返回一个非空 narration 段落', '返回完整 JSON，不绑定具体素材'],
      });
    }
  }

  const details: ScriptGenerationV3ErrorDetails = {
    targetNarrationSec: budget.targetNarrationSec,
    estimatedNarrationSec: lastScript?.estimatedNarrationDurationSec || 0,
    contentCharacterCount: lastScript?.contentCharacterCount || 0,
    targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
    attempts: 3,
  };
  if (lastQualification === 'contract_invalid') {
    throw new ScriptGenerationV3Error('script_contract_invalid', '模型两次修正后仍未返回有效脚本结构', details);
  }
  throw new ScriptGenerationV3Error('script_duration_unresolved', '模型两次修正后仍未达到时长要求', details);
}

export async function fitNarrationTextToDuration(
  input: {
    script: MixcutTaskScriptSnapshot;
    actualNarrationUs: number;
    targetNarrationUs: number;
  },
  dependencies: ScriptGenerationV3Dependencies,
): Promise<{ editedNarrationText: string }> {
  const budget = buildScriptDurationBudget(input.script.targetDurationSec);
  const raw = object(await dependencies.completeJson({
    systemPrompt: '你是电商短视频口播编辑。只返回完整 JSON，不新增事实，不改变音色或语速。',
    userPrompt: JSON.stringify({
      task: 'fit_narration_to_real_tts_duration',
      actualNarrationSec: input.actualNarrationUs / 1_000_000,
      targetNarrationSec: input.targetNarrationUs / 1_000_000,
      targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
      segments: input.script.segments.map((segment) => ({
        id: segment.id,
        narration: segment.narration,
        sellingPointRefs: segment.sellingPointRefs || [],
        visualIntent: segment.visualIntent || '',
        visualKeywords: segment.visualKeywords || [],
      })),
      requirements: [
        '返回相同数量、相同顺序的 segments 和完整 narration',
        '完整重写自然句，禁止末尾硬截断',
        '保留已有卖点与事实，禁止新增参数或承诺',
      ],
    }),
    temperature: 0.3,
  }));
  const rawSegments = Array.isArray(raw.segments) ? raw.segments : [];
  const narrations = rawSegments.map((segment) => string(object(segment).narration)).filter(Boolean);
  const fullScript = narrations.join('\n');
  const contentCharacterCount = countScriptContentCharacters(fullScript);
  if (narrations.length !== input.script.segments.length
    || contentCharacterCount < budget.minContentCharacters
    || contentCharacterCount > budget.maxContentCharacters) {
    throw new ScriptGenerationV3Error('script_duration_unresolved', '智能贴合后仍未达到目标时长预算', {
      targetNarrationSec: budget.targetNarrationSec,
      estimatedNarrationSec: estimateNarrationDurationSec(contentCharacterCount),
      contentCharacterCount,
      targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
      attempts: 1,
    });
  }
  return { editedNarrationText: fullScript };
}
