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

// 引用合法卖点（含证据门禁 skipped 的低风险卖点）可以通过。
const withRefs = validateScriptContent(makeContent(['sp-ok']), { libraryRevision: library });
assert.deepEqual(withRefs.issues, [], '合法引用不应产生任何问题');
assert.equal(withRefs.ok, true);

// usable 被重新打开的失败卖点仍不在引用白名单（fail closed）。
const failedRefs = validateScriptContent(makeContent(['sp-failed-reopened']), { libraryRevision: library });
assert.equal(failedRefs.ok, false);
assert.ok(failedRefs.issues.some((issue) => issue.startsWith('unknown_selling_point:sp-failed-reopened')), '证据失败卖点即使被重新打开也不算合法引用');

console.log('script-studio-validation.test.ts: ok');
