/**
 * Phase 6 知识提示与埋词契约：
 * 1. 匹配策略时 prompt 注入统一名称+搜索词埋词约束；未匹配时无埋词门禁。
 * 2. 推荐存在时 prompt 注入框架结构、文案钩子公式与画面钩子建议；秒数不作为硬约束。
 * 3. normalizeGeneratedScript 产出 v4 内容：knowledgeContext + recommendation。
 * 4. 校验器按 title/cover 组合执行埋词门禁；fallback 满足埋词。
 */
import assert from 'node:assert/strict';
import {
  buildScriptPrompt,
  normalizeGeneratedScript,
  buildDeterministicFallbackScript,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';
import { validateScriptContent } from '../lib/script-studio/validation.ts';
import { checkTitleEmbedding } from '../lib/script-studio/title-embedding.ts';
import { planScriptDirections } from '../lib/script-studio/planner.ts';
import type { LibraryRevisionView } from '../lib/script-studio/libraries.ts';
import type { FrozenKnowledgeContext } from '../lib/script-studio/knowledge-context.ts';
import type { PlannedScript } from '../lib/script-studio/planner.ts';
import type { DirectionSellingPointBrief } from '../lib/script-studio/direction-briefs.ts';

const library = {
  id: 'rev-1',
  productName: '微醺功能沙发',
  category: '沙发',
  brand: '',
  sellingPoints: [
    { id: 'p1', title: '一键折叠', factText: '靠背可以一键折叠放平', pointType: 'efficacy', evidenceQuote: '靠背可以一键折叠放平', seq: 1, usable: 1, disabledByUser: 0, evidenceGate: 'passed', hierarchyRole: 'primary', importance: 80, themeKey: 't-1', themeTitle: '久坐也舒服', sourcePageIndex: 0 },
  ],
} as unknown as LibraryRevisionView;

const matchedKnowledge = {
  strategy: {
    matchStatus: 'matched',
    strategyCatalogRevisionId: 'strategy-rev-1',
    strategyEntryId: 'entry-1',
    normalizedModelKey: 'xq9a',
    canonicalName: '微醺功能沙发',
    searchTerms: ['微醺沙发', '折叠沙发'],
    primarySellingPoints: ['一键折叠'],
    differentiators: [],
    categoryMindsets: ['客厅'],
    sourceRows: [2, 3],
  },
  template: { templateCatalogRevisionId: 'template-rev-1', usedCatalog: true, fallbackWarning: null },
  recommendations: [],
  fingerprint: 'fp-matched',
} as FrozenKnowledgeContext;

const unmatchedKnowledge = {
  strategy: {
    matchStatus: 'unmatched',
    strategyCatalogRevisionId: null,
    strategyEntryId: null,
    normalizedModelKey: null,
    canonicalName: null,
    searchTerms: [],
    primarySellingPoints: [],
    differentiators: [],
    categoryMindsets: [],
    sourceRows: [],
  },
  template: { templateCatalogRevisionId: null, usedCatalog: false, fallbackWarning: '未启用脚本模板库，已按现有静态模板生成' },
  recommendations: [],
  fingerprint: 'fp-unmatched',
} as FrozenKnowledgeContext;

const planWithRecommendation: PlannedScript = {
  ...planScriptDirections(library, 1, '').plans[0]!,
  recommendation: {
    planIndex: 1,
    framework: { id: 'fw-1', stableKey: '01', name: '01 痛点解决型', structure: ['痛点暴露', '产品解决'], rationale: '按证据卖点类型选框架' },
    copyHook: { id: 'ch-1', stableKey: '痛点式:行为反问', type: '痛点式', subtype: '行为反问', formula: '为什么越来越多人开始【行为变化】？', example: '为什么越来越多人开始淘汰传统餐桌？', rationale: '首选钩子' },
    visualHook: { id: 'vh-1', stableKey: '0→1 生成:开场', group: '0→1 生成', name: '快递箱爆炸开场', formula: '[快递箱]→[炸开]', guidance: '可灵首尾帧', referenceAssetIds: ['asset-1'], rationale: '按钩子标签评分' },
  },
};

const brief: DirectionSellingPointBrief = {
  planIndex: 1,
  templateId: 'pain_point',
  themeKey: 't-1',
  themeTitle: '久坐也舒服',
  requiredPointIds: ['p1'],
  optionalPointIds: [],
  candidateCount: 1,
  degraded: false,
  rationale: '测试',
};

const baseInput = {
  libraryRevision: library,
  plan: planWithRecommendation,
  brief,
  audience: '关注沙发的人群',
  tone: '自然可信',
  platform: '小红书',
  creativeBrief: '',
  targetDurationSec: 20,
  previousScripts: [],
} satisfies Omit<ScriptGeneratorInput, 'signal' | 'validationFeedback' | 'knowledgeContext'>;

// 1. 匹配策略时 prompt 注入埋词约束与推荐
const matchedPrompt = buildScriptPrompt({ ...baseInput, knowledgeContext: matchedKnowledge });
assert.ok(matchedPrompt.userPrompt.includes('标题埋词约束'), '匹配时必须注入标题埋词约束');
assert.ok(matchedPrompt.userPrompt.includes('微醺功能沙发'), '埋词约束必须包含统一名称');
assert.ok(matchedPrompt.userPrompt.includes('微醺沙发'), '埋词约束必须包含搜索词');
assert.ok(matchedPrompt.userPrompt.includes('01 痛点解决型'), 'prompt 必须注入推荐框架名称');
assert.ok(matchedPrompt.userPrompt.includes('痛点暴露'), 'prompt 必须注入框架结构');
assert.ok(matchedPrompt.userPrompt.includes('为什么越来越多人开始【行为变化】'), 'prompt 必须注入文案钩子公式');
assert.ok(matchedPrompt.userPrompt.includes('快递箱爆炸开场'), 'prompt 必须注入画面钩子建议');
assert.ok(matchedPrompt.userPrompt.includes('可灵首尾帧'), 'prompt 必须注入画面钩子制作建议');

// 2. 未匹配时无埋词门禁，但推荐照常注入
const unmatchedPrompt = buildScriptPrompt({ ...baseInput, knowledgeContext: unmatchedKnowledge });
assert.ok(!unmatchedPrompt.userPrompt.includes('标题埋词约束'), '未匹配时不得启用埋词门禁');

// 3. 模板秒数不作为硬约束：结构按 + 拆段，不出现「3s/5s」强制切段
assert.doesNotMatch(matchedPrompt.userPrompt, /3s|5s|按秒切段|每段秒数/, '模板秒数不得成为硬分段约束');

// 4. normalizeGeneratedScript 产出 v4 内容
const raw = {
  title: '微醺功能沙发｜折叠沙发怎么选',
  coverTitleParts: { primary: '微醺功能沙发', secondary: '折叠沙发选购指南' },
  direction: '痛点切入',
  segments: [{ narration: '靠背可以一键折叠放平，久坐也不累；再搭配可调节头枕，小户型也能轻松放下；透气面料夏天也不闷，实用又舒服。选购沙发建议选折叠收纳款，家里来客也坐得下，收纳方便还不占地方。', sellingPointIdRefs: ['p1'], visualIntent: '展示折叠', visualKeywords: ['折叠'] }],
  sellingPointUsage: [{ sellingPointId: 'p1', status: 'used', reason: '正文已引用' }],
};
const normalized = normalizeGeneratedScript(raw, { ...baseInput, knowledgeContext: matchedKnowledge });
assert.equal(normalized.version, 4);
assert.ok(normalized.knowledgeContext, 'v4 内容必须带知识上下文');
assert.equal(normalized.knowledgeContext!.matchStatus, 'matched');
assert.equal(normalized.knowledgeContext!.canonicalName, '微醺功能沙发');
assert.ok(normalized.knowledgeContext!.searchTermsUsed.length >= 1, '必须记录实际命中的搜索词');
assert.ok(normalized.recommendation, 'v4 内容必须带推荐说明');
assert.equal(normalized.recommendation!.framework!.name, '01 痛点解决型');
assert.equal(normalized.recommendation!.copyHook!.formula, '为什么越来越多人开始【行为变化】？');
assert.deepEqual(normalized.recommendation!.visualHook!.referenceAssetIds, ['asset-1']);

// 5. 校验器：title/cover 组合各自满足埋词约束；title 缺少搜索词时失败
const validValidation = validateScriptContent(normalized, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(validValidation.ok, true, '满足埋词约束的标题必须通过');

const badTitle = validateScriptContent({
  ...normalized,
  title: '随便一个名字',
  coverTitleParts: { ...normalized.coverTitleParts, secondary: '随便副标题' },
}, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(badTitle.ok, false);
assert.ok(badTitle.issues.some((issue) => issue.includes('title_embedding')), '缺少统一名称/搜索词的标题必须被埋词门禁拦下');

// 6. 未匹配时校验不启用埋词门禁
const unmatchedValid = validateScriptContent({ ...normalized, title: '随便一个名字' }, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'unmatched', canonicalName: null, searchTerms: [] },
});
assert.equal(unmatchedValid.ok, true, '未匹配时不得启用埋词门禁');

// 7. 确定性兜底脚本满足埋词：title 含统一名称、cover 组合含统一名称+搜索词
const fallback = buildDeterministicFallbackScript({ ...baseInput, knowledgeContext: matchedKnowledge });
assert.equal(fallback.version, 4);
const fallbackValidation = validateScriptContent(fallback, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(fallbackValidation.ok, true, '确定性兜底必须满足埋词约束');

// 8. 纯函数 checkTitleEmbedding：title 与 cover 分组独立判定
assert.deepEqual(checkTitleEmbedding({ matchStatus: 'unmatched', canonicalName: null, searchTerms: [] }, '任意', '任意').issues, []);
const embeddingResult = checkTitleEmbedding(
  { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
  '微醺功能沙发｜折叠沙发怎么选',
  '微醺功能沙发折叠沙发',
);
assert.equal(embeddingResult.ok, true);
assert.deepEqual(new Set(embeddingResult.searchTermsUsed), new Set(['折叠沙发']), '记录实际命中（≤2 个）的搜索词');

console.log('script-studio-knowledge-prompt tests passed');
