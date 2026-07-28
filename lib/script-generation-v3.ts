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

export interface ScriptVisualContext {
  shotId: string;
  shotIndex: number;
  imageAssetId: string;
  sourceFilename: string;
  mimeType: string;
  imageBase64: string;
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
  visuals: ScriptVisualContext[];
}

interface ScriptDurationErrorDetails {
  kind: 'duration';
  targetNarrationSec: number;
  estimatedNarrationSec: number;
  contentCharacterCount: number;
  targetCharacterRange: [number, number];
  attempts: number;
}

interface ScriptContractErrorDetails extends Omit<ScriptDurationErrorDetails, 'kind'> {
  kind: 'contract';
}

interface ScriptMaterialMismatchErrorDetails {
  kind: 'material_mismatch';
  attempts: number;
  unsupportedNarrativeBeats: string[];
  materialReason: string;
}

interface ScriptGenerationV3ErrorDetailsByCode {
  script_duration_unresolved: ScriptDurationErrorDetails;
  script_contract_invalid: ScriptContractErrorDetails;
  script_material_mismatch: ScriptMaterialMismatchErrorDetails;
}

export type ScriptGenerationV3ErrorCode = keyof ScriptGenerationV3ErrorDetailsByCode;
export type ScriptGenerationV3ErrorDetails = ScriptGenerationV3ErrorDetailsByCode[ScriptGenerationV3ErrorCode];

export class ScriptGenerationV3Error<Code extends ScriptGenerationV3ErrorCode = ScriptGenerationV3ErrorCode> extends Error {
  readonly code: Code;
  readonly details: ScriptGenerationV3ErrorDetailsByCode[Code];

  constructor(
    code: Code,
    message: string,
    details: ScriptGenerationV3ErrorDetailsByCode[Code],
  ) {
    super(message);
    this.name = 'ScriptGenerationV3Error';
    this.code = code;
    this.details = details;
  }
}

type VisualRef = `visual-${number}`;

function visualRefForIndex(index: number): VisualRef {
  return `visual-${index + 1}`;
}

class ScriptMaterialMismatchError extends Error {
  readonly unsupportedNarrativeBeats: string[];
  readonly materialReason: string;

  constructor(unsupportedNarrativeBeats: string[], materialReason: string) {
    super('script_material_mismatch');
    this.name = 'ScriptMaterialMismatchError';
    this.unsupportedNarrativeBeats = unsupportedNarrativeBeats;
    this.materialReason = materialReason;
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
  const allowedVisualRefs = new Set<string>(input.visuals.map((_, index) => visualRefForIndex(index)));
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
    const visualIntent = string(source.visualIntent);
    const visualRefs = Array.isArray(source.visualRefs)
      ? source.visualRefs.map(string).filter(Boolean).filter((item, itemIndex, values) => values.indexOf(item) === itemIndex)
      : [];
    if (!visualIntent || visualKeywords.length === 0) throw new Error('segment_visual_grounding_required');
    if (visualRefs.length === 0 || visualRefs.some((visualRef) => !allowedVisualRefs.has(visualRef))) {
      throw new Error('segment_visual_refs_invalid');
    }
    segments.push({
      id,
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      sellingPointRefs,
      visualIntent,
      visualKeywords,
    });
  });
  return segments;
}

function assertMaterialFeasible(raw: JsonObject, input: ScriptGenerationInputV3): void {
  const assessment = object(raw.materialAssessment);
  if (assessment.templateFeasible === false) {
    const allowedNarrativeBeats = new Set(promptTemplate(input).narrativeStructure);
    const unsupportedNarrativeBeats = stringArray(assessment.unsupportedNarrativeBeats);
    if (unsupportedNarrativeBeats.length === 0
      || unsupportedNarrativeBeats.some((beat) => !allowedNarrativeBeats.has(beat))) {
      throw new Error('material_assessment_unsupported_beats_required');
    }
    throw new ScriptMaterialMismatchError(
      unsupportedNarrativeBeats,
      string(assessment.reason) || '当前图片无法承接所选模板的核心叙事阶段',
    );
  }
  if (assessment.templateFeasible !== true || stringArray(assessment.unsupportedNarrativeBeats).length > 0) {
    throw new Error('material_assessment_invalid');
  }
}

function normalizeCandidate(rawValue: unknown, input: ScriptGenerationInputV3): {
  script: ScriptOutputV3;
  qualification: 'qualified' | 'too_short' | 'too_long';
} {
  const raw = object(rawValue);
  assertMaterialFeasible(raw, input);
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

function promptTemplate(input: ScriptGenerationInputV3) {
  const template = getScriptTemplate(input.templateId);
  if (!template) throw new Error('invalid_script_template');
  return {
    id: template.id,
    name: template.name,
    objective: template.objective,
    narrativeStructure: template.narrativeStructure,
    writingRules: template.writingRules,
    desiredAudienceResponse: template.desiredAudienceResponse,
  };
}

function promptVisualMaterials(input: ScriptGenerationInputV3) {
  return input.visuals.map((visual, index) => ({
    visualRef: visualRefForIndex(index),
    imageOrder: index + 1,
    shotIndex: visual.shotIndex,
  }));
}

const SCRIPT_VISUAL_REQUIREMENTS = [
  '按 visualMaterials 的 imageOrder 对应附图顺序，先看清每张图的主体、环境、构图、可见细节和可承接动作',
  '每段口播、visualIntent 和 visualKeywords 都必须能由至少一张附图承接；看不到的产品细节、动作、人物或场景不得写入',
  '每段必须返回至少一个 visualRefs，并且只能引用 visualMaterials 中真实存在的 visualRef',
  '已选卖点只有在附图能承接时才写入；缺少画面证据时宁可不写，禁止为了覆盖卖点而虚构素材',
] as const;

const SCRIPT_TEMPLATE_REQUIREMENTS = [
  '先判断全部 template.narrativeStructure 是否都有附图承接；若任一核心阶段缺少画面，返回 templateFeasible=false 和空 segments，禁止硬写',
  '只有 templateFeasible=true 时才严格按 template.narrativeStructure 的顺序推进；阶段可以合并到同一段，但不得颠倒或省略核心转折',
  '逐条遵循 template.writingRules，让所选模板在开头、展开方式和结尾上形成明确差异',
] as const;

const SCRIPT_OUTPUT_CONTRACT = {
  materialAssessment: {
    templateFeasible: 'boolean；全部核心叙事阶段均有图片承接时才为 true',
    unsupportedNarrativeBeats: 'string[]；必须从 template.narrativeStructure 中原样复制所有无法由图片承接的阶段；可行时返回空数组',
    reason: 'string；说明图片为什么足够或不足',
  },
  segments: [{
    narration: 'string',
    sellingPointRefs: 'string[]',
    visualIntent: 'string',
    visualKeywords: 'string[]',
    visualRefs: 'string[]；只允许 visualMaterials 中的 visualRef',
  }],
} as const;

function scriptRequirements(rewrite = false): string[] {
  return [
    ...SCRIPT_TEMPLATE_REQUIREMENTS,
    ...SCRIPT_VISUAL_REQUIREMENTS,
    '只生成带自然标点的口播，不选择或绑定具体图片、shotId 或素材顺序；visualRefs 仅用于证明内容有输入图片承接',
    '返回独立主标题和副标题，正文只能使用已选卖点中的事实',
    '每段返回 narration、sellingPointRefs、visualIntent、visualKeywords、visualRefs',
    rewrite ? '返回完整重写后的 JSON，不返回 diff，不截断字符串末尾' : '返回完整 JSON；字幕、全文、时长和 ID 由服务端派生',
  ];
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
    template: promptTemplate(input),
    selectedSellingPoints: input.selectedSellingPoints,
    visualMaterials: promptVisualMaterials(input),
    duration: {
      targetTotalSec: budget.targetTotalSec,
      targetNarrationSec: budget.targetNarrationSec,
      targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
    },
    outputContract: SCRIPT_OUTPUT_CONTRACT,
    requirements: scriptRequirements(),
  });
}

function rewritePrompt(
  input: ScriptGenerationInputV3,
  issue: 'too_short' | 'too_long' | 'contract_invalid',
  previousResult: unknown,
  currentScript?: ScriptOutputV3,
): string {
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  return JSON.stringify({
    task: 'rewrite_complete_script_v3',
    issue,
    targetNarrationSec: budget.targetNarrationSec,
    targetContentCharacters: [budget.minContentCharacters, budget.maxContentCharacters],
    currentContentCharacterCount: currentScript?.contentCharacterCount,
    currentEstimatedNarrationSec: currentScript?.estimatedNarrationDurationSec,
    template: promptTemplate(input),
    selectedSellingPoints: input.selectedSellingPoints,
    visualMaterials: promptVisualMaterials(input),
    previousResult,
    outputContract: SCRIPT_OUTPUT_CONTRACT,
    requirements: [
      ...(issue === 'contract_invalid' ? ['修复所有缺失或非法字段，至少返回一个非空 narration 段落'] : ['完整重写自然句并达到目标字数']),
      ...scriptRequirements(true),
    ],
  });
}

export async function analyzeScriptStrategyV3(
  input: AnalysisInput,
  dependencies: ScriptGenerationV3Dependencies,
): Promise<ScriptStrategyAnalysisV3> {
  const raw = object(await dependencies.completeJson({
    systemPrompt: '你是电商短视频内容策略师。只返回 JSON，不分析或索取图片。必须依据每个模板的目标、叙事结构和适用卖点推荐，不能只根据模板名称猜测。',
    userPrompt: JSON.stringify({
      task: 'analyze_script_strategy_v3',
      ...input,
      allowedTemplates: SCRIPT_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        suitable: template.suitable,
        objective: template.objective,
        narrativeStructure: template.narrativeStructure,
        writingRules: template.writingRules,
        desiredAudienceResponse: template.desiredAudienceResponse,
      })),
      requirements: [
        '给出卖点统一排序',
        '只推荐一个综合模板',
        '推荐理由必须说明最高优先级卖点、目标人群和平台如何匹配该模板的叙事结构',
        '不分析分镜图片',
      ],
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
  if (input.visuals.length === 0) throw new Error('script_visuals_required');
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const images = input.visuals.map((visual) => ({
    mimeType: visual.mimeType,
    imageBase64: visual.imageBase64,
  }));
  let prompt = generationPrompt(input);
  let lastScript: ScriptOutputV3 | null = null;
  let lastQualification: 'too_short' | 'too_long' | 'contract_invalid' = 'contract_invalid';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await dependencies.completeJson({
      systemPrompt: '你是电商短视频口播编剧。只返回完整 JSON，不绑定固定素材顺序。必须查看随用户消息附带的全部候选分镜图。先判断图片能否承接模板；能承接时必须严格遵循用户消息中的 template 叙事结构和写作规则，不能承接时明确返回素材不匹配，禁止把不同模板写成同一种通用卖点罗列。',
      userPrompt: prompt,
      temperature: attempt === 1 ? 0.7 : 0.4,
      images,
    });
    try {
      const normalized = normalizeCandidate(raw, input);
      lastScript = normalized.script;
      if (normalized.qualification === 'qualified') return { script: normalized.script, attempts: attempt };
      lastQualification = normalized.qualification;
      prompt = rewritePrompt(input, normalized.qualification, raw, normalized.script);
    } catch (error) {
      if (error instanceof ScriptMaterialMismatchError) {
        throw new ScriptGenerationV3Error(
          'script_material_mismatch',
          '当前分镜图片无法承接所选模板，请补充对应素材或更换模板',
          {
            kind: 'material_mismatch',
            attempts: attempt,
            unsupportedNarrativeBeats: error.unsupportedNarrativeBeats,
            materialReason: error.materialReason,
          },
        );
      }
      lastQualification = 'contract_invalid';
      prompt = rewritePrompt(input, 'contract_invalid', raw);
    }
  }

  const durationDetails: Omit<ScriptDurationErrorDetails, 'kind'> = {
    targetNarrationSec: budget.targetNarrationSec,
    estimatedNarrationSec: lastScript?.estimatedNarrationDurationSec || 0,
    contentCharacterCount: lastScript?.contentCharacterCount || 0,
    targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
    attempts: 3,
  };
  if (lastQualification === 'contract_invalid') {
    throw new ScriptGenerationV3Error('script_contract_invalid', '模型两次修正后仍未返回有效脚本结构', {
      kind: 'contract',
      ...durationDetails,
    });
  }
  throw new ScriptGenerationV3Error('script_duration_unresolved', '模型两次修正后仍未达到时长要求', {
    kind: 'duration',
    ...durationDetails,
  });
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
      kind: 'duration',
      targetNarrationSec: budget.targetNarrationSec,
      estimatedNarrationSec: estimateNarrationDurationSec(contentCharacterCount),
      contentCharacterCount,
      targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
      attempts: 1,
    });
  }
  return { editedNarrationText: fullScript };
}
