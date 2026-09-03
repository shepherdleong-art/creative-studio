import assert from 'node:assert/strict';
import { directionBriefLimits, planDirectionBriefs, type DirectionSellingPointBrief } from '../lib/script-studio/direction-briefs.ts';
import {
  briefCandidatePoints,
  buildScriptPrompt,
  createScriptGenerator,
  normalizeGeneratedScript,
  type ScriptGeneratorInput,
} from '../lib/script-studio/generator.ts';
import { normalizeImportance } from '../lib/script-studio/selling-point-normalize.ts';
import type { LibraryRevisionView } from '../lib/script-studio/libraries.ts';
import type { PlannedScript } from '../lib/script-studio/planner.ts';
import type { SellingPointRecord } from '../lib/script-studio/types.ts';

function makePoint(overrides: Partial<SellingPointRecord> & { id: string; seq: number }): SellingPointRecord {
  return {
    revisionId: 'rev-1',
    title: `卖点${overrides.id}`,
    factText: `事实${overrides.id}`,
    pointType: 'other',
    evidenceQuote: `事实${overrides.id}`,
    sourcePageIndex: 0,
    tileRefsJson: '[]',
    evidenceRefsJson: '[]',
    modelConfidence: 'medium',
    riskLevel: 'low',
    evidenceGate: 'passed',
    usable: 1,
    disabledByUser: 0,
    themeKey: '',
    themeTitle: '',
    hierarchyRole: 'supporting',
    importance: 50,
    ...overrides,
  };
}

function makePlan(index: number, templateId: string): PlannedScript {
  return {
    index,
    templateId,
    templateName: templateId,
    templateVersion: 1,
    rationale: '测试',
    direction: templateId,
    angle: `角度${index}`,
  };
}

function makeLibrary(sellingPoints: SellingPointRecord[]): LibraryRevisionView {
  return {
    id: 'rev-1',
    libraryId: 'lib-1',
    revisionNumber: 1,
    sourceSetId: 'src-1',
    sourceFingerprint: 'fp-1',
    productName: '测试椅',
    category: '家具',
    brand: '',
    extractProviderId: 'fake',
    extractModel: 'fake-1',
    promptContractVersion: 3,
    origin: 'extraction',
    createdAt: '2026-08-31T00:00:00.000Z',
    sellingPoints,
  };
}

function briefIdSet(brief: DirectionSellingPointBrief): string {
  return [...brief.requiredPointIds, ...brief.optionalPointIds].sort().join('|');
}

// 四个主题 × 每主题 5 条，共 20 条可用卖点，覆盖充足供给场景。
const THEMES = [
  { key: 't-comfort', title: '久坐也舒服', types: ['efficacy', 'efficacy', 'structure', 'spec', 'certification'] },
  { key: 't-size', title: '小户型也能放下', types: ['spec', 'spec', 'structure', 'efficacy', 'other'] },
  { key: 't-material', title: '扎实用料', types: ['material', 'material', 'certification', 'structure', 'spec'] },
  { key: 't-look', title: '百搭外观', types: ['appearance', 'appearance', 'scenario', 'scenario', 'material'] },
] as const;
const points: SellingPointRecord[] = [];
THEMES.forEach((theme, themeIndex) => {
  theme.types.forEach((type, typeIndex) => {
    const seq = themeIndex * 5 + typeIndex + 1;
    points.push(makePoint({
      id: `p-${seq}`,
      seq,
      pointType: type as SellingPointRecord['pointType'],
      themeKey: theme.key,
      themeTitle: theme.title,
      hierarchyRole: typeIndex === 0 ? 'primary' : typeIndex === 4 ? 'detail' : 'supporting',
      importance: 90 - themeIndex * 5 - typeIndex,
    }));
  });
});
// 证据失败/用户禁用的卖点即使角色最高也不得进入卖点包；usable 被重新打开的失败卖点同样硬排除。
points.push(makePoint({ id: 'p-blocked-gate', seq: 21, pointType: 'efficacy', themeKey: 't-comfort', themeTitle: '久坐也舒服', hierarchyRole: 'primary', importance: 100, usable: 0, evidenceGate: 'failed' }));
points.push(makePoint({ id: 'p-blocked-user', seq: 22, pointType: 'efficacy', themeKey: 't-comfort', themeTitle: '久坐也舒服', hierarchyRole: 'primary', importance: 99, disabledByUser: 1 }));
points.push(makePoint({ id: 'p-failed-reopened', seq: 23, pointType: 'efficacy', themeKey: 't-comfort', themeTitle: '久坐也舒服', hierarchyRole: 'primary', importance: 98, usable: 1, evidenceGate: 'failed' }));

const plans = [makePlan(1, 'pain_point'), makePlan(2, 'scene_seeding'), makePlan(3, 'feature_showcase')];

// 15 秒容量规则落在每方向 6–10 候选 / 3–5 必选的设计约束内（并满足 15s 6–8/2–3）。
assert.deepEqual(directionBriefLimits(15), { candidateLimit: 8, requiredLimit: 3 });

const briefs = planDirectionBriefs({ sellingPoints: points, plans, targetDurationSec: 15 });
assert.equal(briefs.length, 3);
for (const brief of briefs) {
  assert.equal(brief.candidateCount <= 8, true, `15 秒脚本每个方向最多 8 条候选（${brief.templateId} 实际 ${brief.candidateCount}）`);
  assert.equal(brief.requiredPointIds.length, 3, '15 秒脚本每个方向 3 条优先事实');
  assert.equal(brief.candidateCount, brief.requiredPointIds.length + brief.optionalPointIds.length);
  assert.equal(brief.candidateCount, 8, '卖点充足时候选应填满容量');
  const ids = new Set([...brief.requiredPointIds, ...brief.optionalPointIds]);
  assert.equal(ids.has('p-blocked-gate'), false, '证据失败的卖点不得进入卖点包');
  assert.equal(ids.has('p-blocked-user'), false, '用户禁用的卖点不得进入卖点包');
  assert.equal(ids.has('p-failed-reopened'), false, 'usable 被重新打开的失败卖点同样硬排除（fail closed）');
  assert.ok(brief.themeKey, '卖点包必须带主主题');
  assert.ok(brief.rationale.includes(brief.templateId), '编排理由必须可回看');
}

// 相同输入多次编排结果一致（确定性）。
assert.deepEqual(planDirectionBriefs({ sellingPoints: points, plans, targetDurationSec: 15 }), briefs, '相同输入必须得到相同卖点包');

// 卖点充足时多方向卖点包不完全相同。
const idSets = briefs.map(briefIdSet);
assert.equal(new Set(idSets).size > 1, true, '卖点充足时多方向卖点包不应完全相同');

// 痛点方向组成：主主题「久坐也舒服」，必选 = 2 条解决问题的事实 + 1 条证据型事实。
assert.equal(briefs[0]!.themeKey, 't-comfort');
assert.equal(briefs[0]!.themeTitle, '久坐也舒服');
assert.deepEqual(briefs[0]!.requiredPointIds, ['p-1', 'p-2', 'p-4'], 'pain_point 必选必须遵守方向组成（功效×2 + 证据型×1）');
assert.equal(briefs[0]!.degraded, false);

// 场景种草组成：既有场景/外观主张，也有功能/结构类证据支撑，不得全是 scenario。
const sceneBrief = planDirectionBriefs({ sellingPoints: points, plans: [makePlan(1, 'scene_seeding')], targetDurationSec: 15 })[0]!;
const sceneRequiredTypes = sceneBrief.requiredPointIds.map((id) => points.find((point) => point.id === id)!.pointType);
assert.equal(sceneRequiredTypes.filter((type) => type === 'scenario' || type === 'appearance').length >= 1, true, '场景种草必须包含场景/外观主张');
assert.equal(sceneRequiredTypes.filter((type) => ['structure', 'efficacy', 'spec'].includes(type)).length >= 1, true, '场景种草必须包含功能/结构类证据支撑');
assert.equal(sceneRequiredTypes.every((type) => type === 'scenario'), false, '场景种草不得全部由 scenario 卖点组成');

// 卖点直给：必选必须跨 3 个不同主题。
const showcaseBrief = briefs[2]!;
const showcaseThemes = new Set(showcaseBrief.requiredPointIds.map((id) => points.find((point) => point.id === id)!.themeKey));
assert.equal(showcaseThemes.size, 3, 'feature_showcase 必须从 3 个不同主题各取 1 条强事实');

// 重复惩罚真实生效：20 条同类型高重要度卖点，两个方向不得得到一致的前 8 条。
const uniformPoints = Array.from({ length: 20 }, (_, index) => makePoint({
  id: `u-${index + 1}`,
  seq: index + 1,
  pointType: 'spec',
  themeKey: 't-uniform',
  themeTitle: '统一主题',
  hierarchyRole: index === 0 ? 'primary' : 'supporting',
  importance: 95 - index,
}));
const uniformBriefs = planDirectionBriefs({ sellingPoints: uniformPoints, plans: [makePlan(1, 'pain_point'), makePlan(2, 'comparison')], targetDurationSec: 15 });
assert.equal(uniformBriefs[0]!.candidateCount, 8);
assert.equal(uniformBriefs[1]!.candidateCount, 8);
assert.notEqual(briefIdSet(uniformBriefs[0]!), briefIdSet(uniformBriefs[1]!), '重复惩罚必须真实改变主要选点，不能只作同分回退');
const uniformOverlap = [...uniformBriefs[0]!.requiredPointIds, ...uniformBriefs[0]!.optionalPointIds]
  .filter((id) => new Set([...uniformBriefs[1]!.requiredPointIds, ...uniformBriefs[1]!.optionalPointIds]).has(id));
assert.equal(uniformOverlap.length, 0, '供给充足时后编排方向应整体让位给未使用卖点');
assert.equal(uniformBriefs[0]!.degraded, true, '类型组成不满足的方向必须标记降级');
assert.ok(uniformBriefs[0]!.rationale.includes('降级'), '降级必须写进编排理由');

// review 反例：7 条场景 + 1 条结构 + 12 条材质。scene_seeding 与 emotional
// 在硬类型优先下曾得到完全相同的 7+1；可选槽位优先未使用的方向内类型后必须分化。
const counterPoints = [
  ...Array.from({ length: 7 }, (_, index) => makePoint({ id: `c-scene-${index + 1}`, seq: index + 1, pointType: 'scenario', themeKey: 't-scene', themeTitle: '场景', importance: 90 - index })),
  makePoint({ id: 'c-struct-1', seq: 8, pointType: 'structure', themeKey: 't-struct', themeTitle: '结构', importance: 60 }),
  ...Array.from({ length: 12 }, (_, index) => makePoint({ id: `c-mat-${index + 1}`, seq: 9 + index, pointType: 'material', themeKey: 't-mat', themeTitle: '材质', importance: 55 - index })),
];
const counterBriefs = planDirectionBriefs({ sellingPoints: counterPoints, plans: [makePlan(1, 'scene_seeding'), makePlan(2, 'emotional')], targetDurationSec: 15 });
assert.notEqual(
  briefIdSet(counterBriefs[0]!),
  briefIdSet(counterBriefs[1]!),
  'scene_seeding 与 emotional 不得再获得完全相同的卖点包',
);
const emotionalIds = new Set([...counterBriefs[1]!.requiredPointIds, ...counterBriefs[1]!.optionalPointIds]);
assert.equal(
  [...emotionalIds].some((id) => id.startsWith('c-mat-')),
  true,
  'emotional 必须让未使用的方向内类型（材质）上位，而不是重复消费已用场景卖点',
);
const sceneMaterialCount = [...emotionalIds].filter((id) => id.startsWith('c-scene-')).length;
assert.equal(sceneMaterialCount < 7, true, 'emotional 不得原样复制 scene_seeding 的 7 条场景');

// 历史修订不会重新跑视觉门禁，因此进入卖点包前必须本地复核已保存的证据位置。
const invalidHistoricalPoints = [
  makePoint({
    id: 'history-page-out-of-range',
    seq: 1,
    pointType: 'appearance',
    sourcePageIndex: 999,
    tileRefsJson: JSON.stringify(['tile_1']),
    evidenceRefsJson: JSON.stringify([{ pageIndex: 999, tileRef: 'tile_1' }]),
  }),
  makePoint({
    id: 'history-bad-tile-format',
    seq: 2,
    pointType: 'appearance',
    sourcePageIndex: 0,
    tileRefsJson: JSON.stringify(['not_a_tile']),
    evidenceRefsJson: JSON.stringify([{ pageIndex: 0, tileRef: 'not_a_tile' }]),
  }),
  makePoint({
    id: 'history-tile-out-of-range',
    seq: 3,
    pointType: 'appearance',
    sourcePageIndex: 0,
    tileRefsJson: JSON.stringify(['tile_99']),
    evidenceRefsJson: JSON.stringify([{ pageIndex: 0, tileRef: 'tile_99' }]),
  }),
];
const invalidHistoricalBrief = planDirectionBriefs({
  sellingPoints: invalidHistoricalPoints,
  plans: [makePlan(1, 'scene_seeding')],
  targetDurationSec: 15,
  evidenceBounds: { pageCount: 1, pageTileCounts: [5] },
})[0]!;
assert.equal(
  invalidHistoricalBrief.candidateCount,
  0,
  '历史库中页码越界、切片格式非法或切片越界的卖点不得进入方向卖点包',
);

// 主主题连贯只是加分项：不得在排序后强制塞入方向不匹配的卖点。
const coherencePoints = [
  makePoint({ id: 'q-theme-only', seq: 1, pointType: 'other', themeKey: 'ta', themeTitle: '主题A', hierarchyRole: 'primary', importance: 100 }),
  makePoint({ id: 'q-type-match', seq: 2, pointType: 'efficacy', themeKey: 'tb', themeTitle: '主题B', hierarchyRole: 'supporting', importance: 50 }),
];
const coherenceBrief = planDirectionBriefs({ sellingPoints: coherencePoints, plans: [makePlan(1, 'pain_point')], targetDurationSec: 15 })[0]!;
assert.equal(coherenceBrief.requiredPointIds[0], 'q-type-match', '方向类型匹配优先于主题角色/重要度，主主题补位不得覆盖');
assert.equal(coherenceBrief.themeKey, 'tb', '主主题由方向匹配的最强事实决定');
assert.equal(coherenceBrief.degraded, true, '组成不足时标记降级而不是硬塞不匹配卖点');

// 老卖点库（无主题/层级字段）：按 canonical 规则派生分组键，无需重读图片即可编排。
const legacyPoints = [
  makePoint({ id: 'legacy-1', seq: 1, pointType: 'spec', title: '宽度60cm', themeTitle: '' }),
  makePoint({ id: 'legacy-2', seq: 2, pointType: 'spec', title: '可折叠', themeTitle: '' }),
  makePoint({ id: 'legacy-3', seq: 3, pointType: 'appearance', title: '黑色款', themeTitle: '' }),
];
const legacyBriefs = planDirectionBriefs({ sellingPoints: legacyPoints, plans: [makePlan(1, 'feature_showcase')], targetDurationSec: 15 });
assert.equal(legacyBriefs[0]!.candidateCount, 3, '老卖点库全部可用卖点都应参与编排');
assert.ok(legacyBriefs[0]!.themeKey.startsWith('p0:'), '缺失 themeKey 时按 pageIndex + 规范化标题派生');
assert.equal(legacyBriefs[0]!.themeTitle, '宽度60cm', '缺失 themeTitle 时回退为卖点标题');
assert.deepEqual(
  planDirectionBriefs({ sellingPoints: legacyPoints, plans: [makePlan(1, 'feature_showcase')], targetDurationSec: 15 }),
  legacyBriefs,
  '老卖点库编排同样确定',
);

// importance 规范化：null/undefined/NaN 回退 50，Number(null)=0 不得被钳成 1。
assert.equal(normalizeImportance(null), 50);
assert.equal(normalizeImportance(undefined), 50);
assert.equal(normalizeImportance(Number.NaN), 50);
assert.equal(normalizeImportance(''), 50);
assert.equal(normalizeImportance('80'), 80);
assert.equal(normalizeImportance(250), 100);

// 生成边界：提示词只包含当前方向卖点包，包外 ID 不得进入脚本引用。
const libraryRevision = makeLibrary(points);
const targetBrief = briefs[0]!;
const generatorInput: ScriptGeneratorInput = {
  libraryRevision,
  plan: plans[0]!,
  brief: targetBrief,
  audience: '测试人群',
  tone: '自然可信',
  platform: '通用',
  creativeBrief: '',
  targetDurationSec: 15,
  previousScripts: [],
};
const { userPrompt } = buildScriptPrompt(generatorInput);
const payload = JSON.parse(userPrompt) as { sellingPoints: Array<{ id: string; priority?: string }>; theme?: string };
const briefIds = new Set([...targetBrief.requiredPointIds, ...targetBrief.optionalPointIds]);
assert.equal(payload.sellingPoints.length, briefIds.size, '提示词不再包含全部卖点库');
assert.equal(payload.sellingPoints.every((point) => briefIds.has(point.id)), true, '提示词只能包含当前方向卖点包');
assert.equal(payload.sellingPoints.filter((point) => point.priority === 'required').length, targetBrief.requiredPointIds.length);
assert.equal(payload.sellingPoints.some((point) => point.id === 'p-failed-reopened'), false, '被重新打开的失败卖点也不得进入提示词');
assert.equal(payload.theme, '久坐也舒服', '主主题作为策划语境传给模型');

const outsidePoint = points.find((point) => !briefIds.has(point.id) && point.usable === 1 && point.disabledByUser === 0 && point.evidenceGate !== 'failed')!;
const normalized = normalizeGeneratedScript({
  title: '测试方案',
  coverTitleParts: { primary: '舒适椅子', secondary: '久坐不累' },
  direction: '痛点切入',
  segments: [
    { narration: '这是一段口播内容。', sellingPointIdRefs: [targetBrief.requiredPointIds[0]!, outsidePoint.id, 'p-failed-reopened'], visualIntent: '', visualKeywords: [] },
  ],
}, generatorInput);
assert.deepEqual(
  normalized.segments[0]!.sellingPointIdRefs,
  [targetBrief.requiredPointIds[0]!],
  '卖点包外与证据失败的 ID 一律不得进入脚本引用',
);
assert.equal(
  normalized.sellingPointUsage.every((usage) => briefIds.has(usage.sellingPointId)),
  true,
  '卖点使用记录也只覆盖包内候选',
);

// 方向编排不可绕过：缺少 brief 时生成直接失败，且不得回退完整卖点库。
let modelCalls = 0;
const guardedGenerator = createScriptGenerator(async () => {
  modelCalls += 1;
  return {};
}, { id: 'fake', model: 'fake' });
await assert.rejects(
  () => guardedGenerator.generate({ ...generatorInput, brief: undefined } as unknown as ScriptGeneratorInput),
  /direction_brief_required/,
  '缺少 brief 必须 fail closed，不得静默回退完整卖点库',
);
assert.equal(modelCalls, 0, '缺少 brief 时不得发起模型调用');
assert.deepEqual(
  briefCandidatePoints({ ...generatorInput, brief: undefined } as unknown as ScriptGeneratorInput),
  [],
  '缺少 brief 时候选为空而不是完整卖点库',
);

// ── 策略排序信号（方案 §2.6）：只对证据门禁白名单内的卖点做排序取舍，不扩来源 ──
const strategyPoints = [
  makePoint({ id: 's-a', seq: 1, title: '一键折叠设计', factText: '靠背一键折叠', pointType: 'efficacy', themeKey: 's-t1', themeTitle: '折叠便利', importance: 50 }),
  makePoint({ id: 's-b', seq: 2, title: '普通坐感', factText: '常规坐垫', pointType: 'efficacy', themeKey: 's-t2', themeTitle: '坐感', importance: 90 }),
  // 策略提到「智能调节」，但库中没有任何证据支持该主张 → 不得凭空进入候选
  makePoint({ id: 's-c', seq: 3, title: '透气面料', factText: '透气网布', pointType: 'material', themeKey: 's-t3', themeTitle: '材质', importance: 60 }),
];
const strategyRanking = { primarySellingPoints: ['一键折叠', '智能调节'], differentiators: ['窄缝适配'] };
const strategyBrief = planDirectionBriefs({
  sellingPoints: strategyPoints,
  plans: [makePlan(1, 'feature_showcase')],
  targetDurationSec: 15,
  strategyRanking,
})[0]!;
// 命中策略「一键折叠」的卖点 s-a 排在最前（即使 s-b 重要度更高）。
assert.equal(strategyBrief.requiredPointIds[0], 's-a', '策略卖点命中必须排在同类前面');
// 候选只来自白名单：策略「智能调节/窄缝适配」无证据支持，不得进入候选池。
const strategyIds = new Set([...strategyBrief.requiredPointIds, ...strategyBrief.optionalPointIds]);
for (const point of strategyPoints) assert.equal(strategyIds.has(point.id), true, `白名单卖点 ${point.id} 应可进入候选`);
assert.equal(strategyIds.has('s-c'), true, '未命中策略的已有证据卖点仍可进入候选');
// 关键边界：没有任何「智能调节」卖点被合成出来。
assert.equal(strategyPoints.some((point) => point.title.includes('智能调节')), false, '策略主张不得自动成为正文事实');

console.log('script-studio-direction-briefs.test.ts: ok');
