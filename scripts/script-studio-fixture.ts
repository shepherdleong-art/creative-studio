/**
 * Script Studio 测试辅助：确定性兜底脚本构造器。
 * 历史上位于 lib/script-studio/generator.ts（buildDeterministicFallbackScript），
 * 生产路径已不再调用（正式兜底走模型重新生成），仅测试使用，故迁至测试辅助模块。
 * 结尾带 CTA 行动引导段，符合当前结尾质量检查（方案 §2.3）。
 */
import { normalizeAutomaticSubtitleText } from '../lib/subtitle-display.ts';
import { buildScriptDurationBudget, countScriptContentCharacters, estimateNarrationDurationSec } from '../lib/script-duration-policy.ts';
import { briefCandidatePoints, type ScriptGeneratorInput } from '../lib/script-studio/generator.ts';
import { buildScriptTitleContext } from '../lib/script-studio/title-policy.ts';
import type {
  ScriptStudioScriptContent,
  ScriptStudioSegmentContent,
} from '../lib/script-studio/types.ts';

export function buildDeterministicFallbackScript(
  input: ScriptGeneratorInput,
): ScriptStudioScriptContent {
  const usable = briefCandidatePoints(input);
  if (usable.length === 0) throw new Error('script_generation_no_candidate_points');
  const budget = buildScriptDurationBudget(input.targetDurationSec);
  const poolStart = input.plan.index > 1 && usable.length > 1 ? 1 : 0;
  const selectedPool = usable.slice(poolStart, Math.max(poolStart + 1, Math.min(poolStart + 5, usable.length)));
  const sentences: string[] = [];
  let contentCharacterCount = 0;
  let pointer = 0;
  while (contentCharacterCount < budget.minContentCharacters && pointer < 30) {
    const point = selectedPool[pointer % selectedPool.length]!;
    const variationPrefix = input.plan.index > 1 ? `${input.plan.angle}：` : '';
    const sentence = `${variationPrefix}${point.factText}。${point.title ? `${point.title}，` : ''}`;
    sentences.push(sentence);
    contentCharacterCount = countScriptContentCharacters(sentences.join('\n'));
    pointer += 1;
  }
  const selected = selectedPool;
  const segments: ScriptStudioSegmentContent[] = sentences.map((sentence, index) => ({
    id: `segment-${index + 1}`,
    narration: sentence,
    subtitle: normalizeAutomaticSubtitleText(sentence),
    sellingPointIdRefs: [selectedPool[index % selectedPool.length]!.id],
    sellingPointRefs: [selectedPool[index % selectedPool.length]!.title],
    visualIntent: selectedPool[index % selectedPool.length]!.factText,
    visualKeywords: selectedPool[index % selectedPool.length]!.title ? [selectedPool[index % selectedPool.length]!.title] : [],
  }));
  // 测试兜底也以 CTA 收尾（方案 §2.3）：承接正文并邀请行动，其后不追加卖点。
  // 按方案轮换不同 CTA 表达，避免兄弟方案的字符集相似度误判。
  const ctaLines = [
    '想了解这款产品的真实细节，就点开看看这些设计。',
    '想给家里添个合适的选择，就从了解这款产品开始。',
    '想比较这些细节是否适合你家，就去看看完整介绍再说。',
  ];
  const ctaNarration = ctaLines[(input.plan.index - 1) % ctaLines.length]!;
  segments.push({
    id: `segment-${segments.length + 1}`,
    narration: ctaNarration,
    subtitle: normalizeAutomaticSubtitleText(ctaNarration),
    sellingPointIdRefs: [],
    sellingPointRefs: [],
    visualIntent: '产品整体展示',
    visualKeywords: ['产品细节'],
  });
  const fullScript = segments.map((segment) => segment.narration).join('\n');
  contentCharacterCount = countScriptContentCharacters(fullScript);
  const knowledgeContext = input.knowledgeContext;
  const strategy = knowledgeContext?.strategy;
  // 本地兜底也从当前方向与已核验卖点取标题，不拼接型号和搜索词。
  const title = `${input.plan.angle.slice(0, 8)}${selectedPool[0]!.title.slice(0, 8)}`;
  const coverPrimary = `${selectedPool[0]!.title}${input.plan.angle.slice(0, 4)}`.slice(0, 12);
  const coverSecondary = '看看这些真实细节';
  const recommendation = input.plan.recommendation;
  return {
    version: 4,
    title,
    coverTitleParts: {
      primary: coverPrimary,
      secondary: coverSecondary,
      source: 'system_composed',
    },
    platform: input.platform,
    tone: input.tone,
    templateId: input.plan.templateId,
    template: input.plan.templateName,
    templateVersion: input.plan.templateVersion,
    templateRationale: input.plan.rationale,
    shotSetId: '',
    targetDurationSec: input.targetDurationSec,
    targetNarrationDurationSec: budget.targetNarrationSec,
    contentCharacterCount,
    estimatedNarrationDurationSec: estimateNarrationDurationSec(contentCharacterCount),
    durationStatus: 'qualified',
    direction: input.plan.angle,
    creativeBrief: input.creativeBrief,
    libraryRevisionId: input.libraryRevision.id,
    sellingPointUsage: usable.map((point) => ({
      sellingPointId: point.id,
      title: point.title,
      status: selected.some((item) => item.id === point.id) ? 'used' : 'omitted',
      reason: selected.some((item) => item.id === point.id) ? '正文已引用' : '未写入正文',
    })),
    segments,
    fullScript,
    fullSubtitle: segments.map((segment) => segment.subtitle).join('\n'),
    knowledgeContext: knowledgeContext
      ? {
          matchStatus: strategy!.matchStatus,
          strategyRevisionId: strategy!.strategyCatalogRevisionId,
          normalizedModelKey: strategy!.normalizedModelKey,
          canonicalName: strategy!.canonicalName,
          displayName: buildScriptTitleContext(input.libraryRevision, knowledgeContext).displayName,
          searchTerms: buildScriptTitleContext(input.libraryRevision, knowledgeContext).searchTerms,
          searchTermsUsed: [],
          sourceRows: strategy!.sourceRows ?? [],
        }
      : undefined,
    recommendation: recommendation
      ? {
          framework: recommendation.framework ? {
            id: recommendation.framework.id,
            stableKey: recommendation.framework.stableKey,
            name: recommendation.framework.name,
            structure: recommendation.framework.structure,
            rationale: recommendation.framework.rationale,
          } : null,
          copyHook: recommendation.copyHook ? {
            id: recommendation.copyHook.id,
            stableKey: recommendation.copyHook.stableKey,
            type: recommendation.copyHook.type,
            subtype: recommendation.copyHook.subtype,
            formula: recommendation.copyHook.formula,
            example: recommendation.copyHook.example,
            rationale: recommendation.copyHook.rationale,
          } : null,
          visualHook: recommendation.visualHook ? {
            id: recommendation.visualHook.id,
            stableKey: recommendation.visualHook.stableKey,
            group: recommendation.visualHook.group,
            name: recommendation.visualHook.name,
            formula: recommendation.visualHook.formula,
            guidance: recommendation.visualHook.guidance,
            referenceAssetIds: recommendation.visualHook.referenceAssetIds,
            rationale: recommendation.visualHook.rationale,
          } : null,
        }
      : undefined,
  };
}
