/** 知识来源保留、搜索词与标题分离和推荐兼容性。 */
import assert from 'node:assert/strict';
import {
  buildScriptPrompt,
  normalizeGeneratedScript,
  buildDeterministicFallbackScript,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';
import { validateScriptContent } from '../lib/script-studio/validation.ts';
import { checkTitleEmbedding, matchedSearchTerms } from '../lib/script-studio/title-embedding.ts';
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

// 1. 匹配策略时分开搜索词上下文与推荐
const matchedPrompt = buildScriptPrompt({ ...baseInput, knowledgeContext: matchedKnowledge });
assert.ok(matchedPrompt.userPrompt.includes('搜索词单独保留'), '匹配时说明搜索词独立保留');
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
  coverTitleParts: { primary: '一键折叠沙发', secondary: '折叠沙发选购指南' },
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

// 5. 校验器：标题可自然使用搜索词，缺少搜索词也可以通过
const validValidation = validateScriptContent(normalized, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(validValidation.ok, true, '具体卖点标题可以通过');

const badTitle = validateScriptContent({
  ...normalized,
  title: '随便一个名字',
  coverTitleParts: { ...normalized.coverTitleParts, secondary: '随便副标题' },
}, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(badTitle.ok, true, '标题无需强行包含商品名称或搜索词');

// 6. 未匹配时校验不启用埋词门禁
const unmatchedValid = validateScriptContent({ ...normalized, title: '随便一个名字' }, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'unmatched', canonicalName: null, searchTerms: [] },
});
assert.equal(unmatchedValid.ok, true, '未匹配时不得启用埋词门禁');

// 7. 确定性兜底从方向和已核验卖点取标题
const fallback = buildDeterministicFallbackScript({ ...baseInput, knowledgeContext: matchedKnowledge });
assert.equal(fallback.version, 4);
const fallbackValidation = validateScriptContent(fallback, {
  libraryRevision: library,
  titleEmbeddingContext: { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
});
assert.equal(fallbackValidation.ok, true, '确定性兜底仍须满足标题基本约束');

// 8. 兼容入口 checkTitleEmbedding：只统计自然命中的搜索词
assert.deepEqual(checkTitleEmbedding({ matchStatus: 'unmatched', canonicalName: null, searchTerms: [] }, '任意', '任意').issues, []);
const embeddingResult = checkTitleEmbedding(
  { matchStatus: 'matched', canonicalName: '微醺功能沙发', searchTerms: ['微醺沙发', '折叠沙发'] },
  '微醺功能沙发｜折叠沙发怎么选',
  '微醺功能沙发折叠沙发',
);
assert.equal(embeddingResult.ok, true);
assert.deepEqual(new Set(embeddingResult.searchTermsUsed), new Set(['折叠沙发']), '记录实际命中（≤2 个）的搜索词');

// 9. 脏词表回归（PC615 真实数据）：统一名称自身即命中 3 个子串词，门禁必须仍可通过
// 词表含孤立「#」、与统一名称相同的词条、以及层层包含的词根（储物床 ⊂ 储物床推荐 ⊂ …）。
const pc615Context = {
  matchStatus: 'matched' as const,
  canonicalName: '#林氏真皮储物床PC615',
  searchTerms: [
    '#林氏家居', '#', '#林氏家居床', '#林氏真皮储物床PC615',
    '主卧床', '真皮床', '储物床', '高箱床', '小户型',
    '储物床推荐', '储物床怎么挑',
  ],
};
// 孤立「#」不具备检索语义，不计入埋词。
assert.deepEqual(matchedSearchTerms('#林氏真皮储物床PC615', ['#']), [], '孤立的 # 不算命中搜索词');
// 互相包含的命中只算一个概念：统一名称自身（最长）吸收「储物床」。
assert.deepEqual(matchedSearchTerms('#林氏真皮储物床PC615', pc615Context.searchTerms), ['#林氏真皮储物床PC615']);
// 仅含统一名称的标题/封面即可通过：「必须含统一名称」与「最多 2 个搜索词」不再互斥。
const pc615Result = checkTitleEmbedding(pc615Context, '#林氏真皮储物床PC615', '#林氏真皮储物床PC615臻选好床');
assert.equal(pc615Result.ok, true, `仅含统一名称必须通过：${pc615Result.issues.join(',')}`);
// 统一名称 + 一个独立词根 = 2 个概念，仍通过；且「储物床推荐」吸收「储物床」不重复计数。
const pc615Two = checkTitleEmbedding(pc615Context, '#林氏真皮储物床PC615｜主卧床推荐', '#林氏真皮储物床PC615储物床推荐');
assert.equal(pc615Two.ok, true, `两个概念必须通过：${pc615Two.issues.join(',')}`);
// 搜索词数量不再成为封面强制条件，长度/型号约束由标题策略检查。
const pc615Stuffed = checkTitleEmbedding(pc615Context, '#林氏真皮储物床PC615主卧床高箱床小户型', '#林氏真皮储物床PC615');
assert.equal(pc615Stuffed.ok, true, '搜索词统计本身不再对标题施加门禁');
// 词表清洗后为空（全是「#」这类残留）时只约束统一名称，不得让门禁永远无法通过。
const degenerate = checkTitleEmbedding(
  { matchStatus: 'matched', canonicalName: '某产品', searchTerms: ['#', '＃'] },
  '某产品开箱',
  '某产品臻选',
);
assert.equal(degenerate.ok, true, `无语义词表不得拦截：${degenerate.issues.join(',')}`);

assert.deepEqual(normalized.knowledgeContext!.searchTerms, matchedKnowledge.strategy.searchTerms);
console.log('script-studio-knowledge-prompt tests passed');
