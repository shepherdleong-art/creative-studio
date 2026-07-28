import assert from 'node:assert/strict';

const {
  getDefaultSelectedSellingPointKeys,
  getSellingPointSelectionKey,
  getScriptStrategyAnalysisV3ValidationIssues,
  isCompleteScriptStrategyAnalysisV3,
  resolveSelectedSellingPoints,
} = await import('../lib/script-strategy' + '.ts');

const completeAnalysis = {
  version: 3 as const,
  rankings: [
    {
      sellingPointId: 'sp-a', rank: 1, title: '安全面料', priority: 'highest' as const, reason: '符合人群和平台需求',
      factors: { audienceFit: 5, platformFit: 4, sellingPointStrength: 4 },
    },
    {
      sellingPointId: 'sp-b', rank: 2, title: '实木框架', priority: 'high' as const, reason: '提供清晰差异化证据',
      factors: { audienceFit: 4, platformFit: 4, sellingPointStrength: 5 },
    },
    {
      sellingPointId: 'sp-c', rank: 3, title: '自然皮纹', priority: 'high' as const, reason: '适合视觉表达',
      factors: { audienceFit: 4, platformFit: 5, sellingPointStrength: 4 },
    },
    {
      sellingPointId: 'sp-d', rank: 4, title: '方便清洁', priority: 'medium' as const, reason: '作为补充',
      factors: { audienceFit: 3, platformFit: 3, sellingPointStrength: 3 },
    },
  ],
  audienceInsight: '家庭用户重视安全与质感',
  platformAdvice: '小红书适合生活方式与材质证据',
  recommendedTemplate: { id: 'scene_seeding', name: '场景种草', reason: '适合场景代入' },
  recommendationSource: 'model' as const,
};

assert.deepEqual(
  getDefaultSelectedSellingPointKeys(completeAnalysis),
  ['sp-a', 'sp-b', 'sp-c'],
  'V3 分析后默认选择真实排序前三的稳定 ID，而不是标题或唯一 highest',
);
assert.equal(getSellingPointSelectionKey(completeAnalysis.rankings[0]), 'sp-a');
assert.equal(getSellingPointSelectionKey({ title: '旧版卖点' }), '旧版卖点');

assert.deepEqual(
  resolveSelectedSellingPoints(completeAnalysis, ['sp-b', 'sp-a']),
  [
    { sellingPointId: 'sp-b', title: '实木框架', priority: 'high', reason: '提供清晰差异化证据' },
    { sellingPointId: 'sp-a', title: '安全面料', priority: 'highest', reason: '符合人群和平台需求' },
  ],
  '生成入参必须由稳定 ID 回填原始卖点文案和分析依据',
);
assert.deepEqual(
  resolveSelectedSellingPoints(completeAnalysis, ['实木框架']),
  [{ sellingPointId: 'sp-b', title: '实木框架', priority: 'high', reason: '提供清晰差异化证据' }],
  '历史草稿只保存标题时仍可兼容恢复',
);

assert.equal(isCompleteScriptStrategyAnalysisV3(completeAnalysis), true);
assert.equal(isCompleteScriptStrategyAnalysisV3({
  ...completeAnalysis,
  rankings: completeAnalysis.rankings.map((ranking) => ({ ...ranking, rank: 1 })),
}), false, '重复 rank 的历史分析不得伪装成完整结果');
assert.equal(isCompleteScriptStrategyAnalysisV3({
  ...completeAnalysis,
  rankings: [{ ...completeAnalysis.rankings[0], factors: { audienceFit: 0, platformFit: 4, sellingPointStrength: 4 } }],
}), false, '越界或残缺 factors 不得通过完整性检查');
assert.ok(getScriptStrategyAnalysisV3ValidationIssues({
  ...completeAnalysis,
  platformAdvice: '',
}).includes('platformAdvice_required'), '最终分析合同必须返回具体、可定位的错误');

console.log('script strategy tests passed');
