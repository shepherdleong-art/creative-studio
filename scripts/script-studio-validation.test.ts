import assert from 'node:assert/strict';
import { buildScriptDurationBudget, countScriptContentCharacters } from '../lib/script-duration-policy.ts';
import { validateScriptContent } from '../lib/script-studio/validation.ts';
import type { LibraryRevisionView } from '../lib/script-studio/libraries.ts';
import type { ScriptStudioScriptContent, SellingPointRecord } from '../lib/script-studio/types.ts';

function makePoint(overrides: Partial<SellingPointRecord> & { id: string; seq: number }): SellingPointRecord {
  return {
    revisionId: 'rev-1',
    title: `卖点${overrides.id}`,
    factText: `事实${overrides.id}`,
    pointType: 'spec',
    evidenceQuote: `事实${overrides.id}`,
    sourcePageIndex: 0,
    tileRefsJson: '[]',
    evidenceRefsJson: '[]',
    modelConfidence: 'medium',
    riskLevel: 'low',
    evidenceGate: 'passed',
    usable: 1,
    disabledByUser: 0,
    themeKey: 't-1',
    themeTitle: '主题',
    hierarchyRole: 'supporting',
    importance: 50,
    detailText: '',
    detailStatus: 'missing',
    ...overrides,
  };
}

const points = [
  makePoint({ id: 'sp-ok', seq: 1, evidenceGate: 'skipped' }),
  makePoint({ id: 'sp-failed-reopened', seq: 2, evidenceGate: 'failed', usable: 1 }),
];

const library: LibraryRevisionView = {
  id: 'rev-1',
  libraryId: 'lib-1',
  revisionNumber: 1,
  sourceSetId: 'src-1',
  sourceFingerprint: 'fp',
  productName: '测试产品',
  category: '家具',
  brand: '',
  extractProviderId: 'fake',
  extractModel: 'fake-1',
  promptContractVersion: 3,
  origin: 'extraction',
  createdAt: '2026-08-31T00:00:00.000Z',
  sellingPoints: points,
};

function makeContent(sellingPointIdRefs: string[]): ScriptStudioScriptContent {
  // 动态凑足 15 秒时长预算，避免时长问题干扰引用断言。
  const budget = buildScriptDurationBudget(15);
  const sentence = '这是一段验证卖点引用的口播内容，';
  let narration = sentence;
  while (countScriptContentCharacters(narration) < budget.minContentCharacters) {
    narration += sentence;
  }
  while (countScriptContentCharacters(narration) > budget.maxContentCharacters) {
    narration = narration.slice(0, -1);
  }
  return {
    version: 3,
    title: '测试方案',
    coverTitleParts: { primary: '舒适椅子', secondary: '久坐不累', source: 'model' },
    platform: '通用',
    tone: '自然可信',
    templateId: 'pain_point',
    template: '痛点切入',
    templateVersion: 1,
    templateRationale: '测试',
    shotSetId: '',
    targetDurationSec: 15,
    targetNarrationDurationSec: 13,
    contentCharacterCount: 56,
    estimatedNarrationDurationSec: 14,
    durationStatus: 'qualified',
    direction: '痛点切入',
    creativeBrief: '',
    libraryRevisionId: 'rev-1',
    sellingPointUsage: [],
    segments: [{
      id: 'segment-1',
      narration,
      subtitle: narration,
      sellingPointIdRefs,
      sellingPointRefs: [],
      visualIntent: '',
      visualKeywords: [],
    }],
    fullScript: narration,
    fullSubtitle: narration,
  };
}

// 零卖点引用不得通过正式校验（review 反例：56 字、sellingPointIdRefs=[] 曾返回 ok=true）。
const zeroRefs = validateScriptContent(makeContent([]), { libraryRevision: library });
assert.equal(zeroRefs.ok, false, '零卖点引用的脚本不得通过校验');
assert.ok(zeroRefs.issues.includes('selling_point_refs_required'), '必须给出明确的卖点引用缺失问题');

// 软时长目标（方案 §2.3）：字数偏离预算只作提示，不进入阻断性 issues，不阻止保存。
const shortContent = makeContent(['sp-ok']);
shortContent.segments = [{ ...shortContent.segments[0]!, narration: '偏短但有引用的完整表达。' }];
const shortResult = validateScriptContent(shortContent, { libraryRevision: library });
assert.equal(shortResult.ok, true, '仅时长偏短不应产生阻断问题');
assert.deepEqual(shortResult.issues.filter((issue) => issue.startsWith('duration_')), [], '时长偏离不再进入阻断性 issues');
assert.deepEqual(shortResult.durationHints, ['duration_too_short'], '偏短如实记录为时长提示');
assert.equal(shortResult.content.durationStatus, 'too_short', 'durationStatus 如实计算不改报合格');

const longContent = makeContent(['sp-ok']);
longContent.segments = [{ ...longContent.segments[0]!, narration: `${longContent.segments[0]!.narration}再补一大段超预算的完整表达内容用于验证偏长也不阻断保存。` }];
const longResult = validateScriptContent(longContent, { libraryRevision: library });
assert.deepEqual(longResult.issues.filter((issue) => issue.startsWith('duration_')), [], '偏长同样不阻断');
assert.deepEqual(longResult.durationHints, ['duration_too_long'], '偏长如实记录为时长提示');
assert.equal(longResult.content.durationStatus, 'too_long', '偏长候选可保存但状态如实展示');

// 引用合法卖点（含证据门禁 skipped 的低风险卖点）可以通过。
const withRefs = validateScriptContent(makeContent(['sp-ok']), { libraryRevision: library });
assert.deepEqual(withRefs.issues, [], '合法引用不应产生任何问题');
assert.equal(withRefs.ok, true);

// usable 被重新打开的失败卖点仍不在引用白名单（fail closed）。
const failedRefs = validateScriptContent(makeContent(['sp-failed-reopened']), { libraryRevision: library });
assert.equal(failedRefs.ok, false);
assert.ok(failedRefs.issues.some((issue) => issue.startsWith('unknown_selling_point:sp-failed-reopened')), '证据失败卖点即使被重新打开也不算合法引用');

// 正文不同也必须单独检查标题和完整封面组合。
const differentBody = { ...makeContent(['sp-ok']), fullScript: '另一段完全不同的正文' };
const duplicateTitles = validateScriptContent(makeContent(['sp-ok']), {
  libraryRevision: library,
  siblingScripts: [differentBody],
});
assert.ok(duplicateTitles.issues.includes('duplicate_title'), '同标题不得因正文不同而通过');
assert.ok(duplicateTitles.issues.includes('duplicate_cover_combo'), '封面主副标题组合必须独立去重');

const samePrimaryDifferentSecondary = validateScriptContent({ ...makeContent(['sp-ok']), title: '方案甲篇', coverTitleParts: { primary: '舒适椅子', secondary: '靠背轻柔承托', source: 'model' } }, {
  libraryRevision: library,
  siblingScripts: [{ ...differentBody, title: '方案乙篇', coverTitleParts: { primary: '舒适椅子', secondary: '久坐不累' } }],
});
assert.equal(samePrimaryDifferentSecondary.issues.includes('duplicate_cover_combo'), false, '同商品展示名主标题配不同实质卖点应放行');

const differentPrimarySameSecondary = validateScriptContent({ ...makeContent(['sp-ok']), title: '方案丙篇', coverTitleParts: { primary: '轻盈椅子', secondary: '久坐不累', source: 'model' } }, {
  libraryRevision: library,
  siblingScripts: [{ ...differentBody, title: '方案丁篇', coverTitleParts: { primary: '舒适椅子', secondary: '久坐不累' } }],
});
assert.equal(differentPrimarySameSecondary.issues.includes('duplicate_cover_combo'), false, '不同主标题配同副标题不等同于完整组合重复');

const reorderedSecondary = validateScriptContent({ ...makeContent(['sp-ok']), title: '方案戊篇', coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅高颜值隔断', source: 'model' } }, {
  libraryRevision: library,
  siblingScripts: [{ ...differentBody, title: '方案己篇', coverTitleParts: { primary: '林氏摩卡沙发', secondary: '横厅隔断高颜值' } }],
});
assert.ok(reorderedSecondary.issues.includes('duplicate_cover_combo'), '副标题词序调换也必须拦截');

const modelOnly = validateScriptContent({ ...makeContent(['sp-ok']), title: 'BS001' }, {
  libraryRevision: { ...library, productName: 'BS001' },
});
assert.equal(modelOnly.ok, false, '不得直接套用商品型号作为标题');

console.log('script-studio-validation.test.ts: ok');
