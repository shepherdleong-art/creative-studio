import assert from 'node:assert/strict';
import {
  claimVerifiedByQuote,
  runEvidenceGate,
  usableSellingPoints,
} from '../lib/script-studio/evidence-gate.ts';
import type { LibrarySellingPointInput } from '../lib/script-studio/libraries.ts';
import type { EvidenceReprobe } from '../lib/script-studio/adapters/reprobe.ts';
import { getScriptStudioLimits } from '../lib/script-studio/limits.ts';

assert.equal(getScriptStudioLimits().reprobeBatchSize, 4, '真机验证复核默认每批 4 条');
assert.equal(getScriptStudioLimits().reprobeMaxImagesPerBatch, 6, '8 图批处理真机更慢且会连带排除更多卖点');

function point(overrides: Partial<LibrarySellingPointInput> = {}): LibrarySellingPointInput {
  return {
    title: '51 道工序',
    factText: '经过 51 道工序',
    pointType: 'spec',
    evidenceQuote: '经过 51 道工序',
    sourcePageIndex: 0,
    tileRefs: ['3'],
    modelConfidence: 'high',
    riskLevel: 'high',
    ...overrides,
  };
}

const verifiedReprobe: EvidenceReprobe = {
  kind: 'vision_closed_question',
  async verify(input) {
    return { quote: input.claim.includes('51') ? `原文：${input.claim}` : null };
  },
};

const lowRisk = runEvidenceGate([
  point({
    title: '黑色外观',
    factText: '产品外观为黑色',
    pointType: 'appearance',
    evidenceQuote: '产品外观为黑色',
    riskLevel: 'low',
  }),
], { reprobe: verifiedReprobe });
assert.equal((await lowRisk).points[0]?.usable, true);
assert.equal((await lowRisk).points[0]?.evidenceGate, 'skipped');

const highRiskPass = await runEvidenceGate([
  point({ factText: '经过 51 道工序', modelConfidence: 'high' }),
], { reprobe: verifiedReprobe });
assert.equal(highRiskPass.points[0]?.evidenceGate, 'passed');
assert.equal(highRiskPass.points[0]?.usable, true);

const highRiskWrong = await runEvidenceGate([
  point({ factText: '经过 999 道工序', evidenceQuote: '经过 999 道工序', modelConfidence: 'high' }),
], { reprobe: verifiedReprobe });
assert.equal(highRiskWrong.points[0]?.evidenceGate, 'failed', '模型 confidence 不能单独准入');
assert.equal(highRiskWrong.points[0]?.usable, false);

const noReprobe = await runEvidenceGate([point({ factText: '经过 999 道工序', evidenceQuote: '经过 999 道工序' })]);
assert.equal(noReprobe.points[0]?.evidenceGate, 'failed');

const promotion = await runEvidenceGate([
  point({
    title: '限时特价',
    factText: '限时立减 100 元',
    pointType: 'other',
    evidenceQuote: '限时立减 100 元',
    modelConfidence: 'high',
  }),
], { reprobe: verifiedReprobe });
assert.equal(promotion.points[0]?.usable, false, '促销信息不作为长期卖点');
assert.equal(promotion.points[0]?.evidenceGate, 'failed');

assert.equal(claimVerifiedByQuote('51 道工序', '经过51道工序'), true, '规范化后允许空白差异');
assert.equal(claimVerifiedByQuote('51 道工序', '采用材料'), false, '摘录不足时不能核验');
assert.equal(usableSellingPoints([...highRiskPass.points, ...highRiskWrong.points]).length, 1);

// 高风险二次核验有界并发：不超过 concurrency，输出顺序与输入一致。
let inFlight = 0;
let maxInFlight = 0;
const delayedReprobe: EvidenceReprobe = {
  kind: 'vision_closed_question',
  async verify(input) {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return { quote: input.claim };
  },
};
const manyPoints = Array.from({ length: 6 }, (_, index) => point({
  title: `卖点${index + 1}`,
  factText: `经过 5${index} 道工序`,
  evidenceQuote: `经过 5${index} 道工序`,
}));
const concurrent = await runEvidenceGate(manyPoints, { reprobe: delayedReprobe, concurrency: 2 });
assert.equal(maxInFlight, 2, '并发度不得越过上限');
assert.deepEqual(concurrent.points.map((item) => item.title), manyPoints.map((item) => item.title), '输出顺序必须与输入一致');
assert.equal(concurrent.verifiedHighRisk, 6);

// 二次核验批处理：每条候选仍有独立封闭问题和服务端匹配，但共享一次视觉请求。
let batchCalls = 0;
const batchedReprobe = {
  kind: 'vision_closed_question' as const,
  async verify() {
    throw new Error('批处理可用时不应回退到逐条 verify');
  },
  async verifyMany(input: {
    claims: Array<{ id: string; claim: string; imageIndexes: number[] }>;
    tiles: Array<{ mimeType: string; imageBase64: string }>;
  }) {
    batchCalls += 1;
    assert.equal(input.tiles.length <= 6, true, '单次二次核验不得超过图片预算');
    assert.equal(input.claims.every((claim) => claim.imageIndexes.length > 0), true, '每条候选必须指向对应证据图');
    return {
      results: input.claims.map((claim) => ({ id: claim.id, quote: claim.claim })),
    };
  },
} as EvidenceReprobe;
const batched = await runEvidenceGate(manyPoints, {
  reprobe: batchedReprobe,
  evidenceTiles: (item) => {
    const index = Number.parseInt(item.title.replace(/\D/g, ''), 10) || 1;
    return [
      { mimeType: 'image/jpeg', imageBase64: `tile-${Math.ceil(index / 2)}` },
      { mimeType: 'image/jpeg', imageBase64: `tile-${Math.ceil(index / 2) + 1}` },
    ];
  },
  concurrency: 2,
  batchSize: 3,
  maxImagesPerBatch: 6,
});
assert.equal(batchCalls, 2, '6 条候选应合并成 2 次核验请求');
assert.equal(batched.verifiedHighRisk, 6);
assert.equal(batched.reprobeRequestCount, 2, '任务指标必须记录真实核验请求数');
assert.deepEqual(batched.points.map((item) => item.title), manyPoints.map((item) => item.title));

// 非法证据位置 fail closed：pageIndex=999、tileRef=not_a_tile 不得被当作可用证据。
const invalidLocation = await runEvidenceGate([
  point({
    title: '黑色外观',
    factText: '产品外观为黑色',
    pointType: 'appearance',
    evidenceQuote: '产品外观为黑色',
    riskLevel: 'low',
    sourcePageIndex: 999,
    tileRefs: ['not_a_tile'],
  }),
], { reprobe: verifiedReprobe, pageCount: 2, pageTileCounts: [5, 5] });
assert.equal(invalidLocation.points[0]?.evidenceGate, 'failed', '页码越界 + 非法切片引用必须判为证据失败');
assert.equal(invalidLocation.points[0]?.usable, false);

const tileOutOfRange = await runEvidenceGate([
  point({
    title: '黑色外观',
    factText: '产品外观为黑色',
    pointType: 'appearance',
    evidenceQuote: '产品外观为黑色',
    riskLevel: 'low',
    sourcePageIndex: 0,
    tileRefs: ['tile_99'],
  }),
], { reprobe: verifiedReprobe, pageCount: 1, pageTileCounts: [5] });
assert.equal(tileOutOfRange.points[0]?.evidenceGate, 'failed', '切片引用越过该页切片数必须判为证据失败');

const badFormatNoRange = await runEvidenceGate([
  point({
    title: '黑色外观',
    factText: '产品外观为黑色',
    pointType: 'appearance',
    evidenceQuote: '产品外观为黑色',
    riskLevel: 'low',
    sourcePageIndex: 0,
    tileRefs: ['not_a_tile'],
  }),
], { reprobe: verifiedReprobe });
assert.equal(badFormatNoRange.points[0]?.evidenceGate, 'failed', '未提供页数范围时非法切片格式同样 fail closed');

// 信号已取消时，剩余高风险卖点按「未核验」排除，不再发起核验调用。
const aborted = await runEvidenceGate([point()], { reprobe: verifiedReprobe, signal: AbortSignal.abort() });
assert.equal(aborted.points[0]?.evidenceGate, 'failed');
assert.equal(aborted.excludedHighRiskUnverified, 1);

console.log('script-studio-evidence-gate.test.ts: ok');
