import assert from 'node:assert/strict';
import { createVisionExtractor } from '../lib/script-studio/adapters/vision-extract.ts';
import type { ScriptStudioCompleteJsonRequest } from '../lib/script-studio/llm-contract.ts';
import { getScriptStudioLimits } from '../lib/script-studio/limits.ts';

function makeTiles(count: number): Array<{ mimeType: string; imageBase64: string }> {
  return Array.from({ length: count }, (_, index) => ({ mimeType: 'image/jpeg', imageBase64: `tile-${index + 1}` }));
}

function makePage(tileCount: number) {
  return {
    pageIndex: 0,
    imageAssetId: 'img-1',
    filename: 'detail.png',
    sourceWidth: 1024,
    sourceHeight: tileCount * 1000,
    tiles: makeTiles(tileCount),
  };
}

// 公司 Luna 对 14 张详情页切片的真实请求连续命中 120 秒超时；6 张已实测约 16.6 秒。
const previousBatchSize = process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_TILE_BATCH_SIZE;
delete process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_TILE_BATCH_SIZE;
assert.equal(getScriptStudioLimits().extractTileBatchSize, 6, '真实生产默认单批必须保持为 6 张，避免 Luna 大批请求超时');
assert.equal(getScriptStudioLimits().extractConcurrency, 4, '公司网关已验证 4 路并发，43 片应尽量压缩为两轮请求');
assert.equal(getScriptStudioLimits().extractRequestTimeoutMs, 120_000, '75 秒提前重试真机反而变慢，必须保留供应商默认超时');
assert.equal(getScriptStudioLimits().extractMaxAttempts, 2, '超时批重试一次，避免连续抽签把单批拖到 3 个阈值');
if (previousBatchSize === undefined) {
  delete process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_TILE_BATCH_SIZE;
} else {
  process.env.CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_TILE_BATCH_SIZE = previousBatchSize;
}

// 43 片按 14/批拆成 4 次调用；并发有上限；批提示用整页 1-based 编号。
let inFlight =  0;
let maxInFlight = 0;
const calls: ScriptStudioCompleteJsonRequest[] = [];
const extractor = createVisionExtractor(async (request) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  calls.push(request);
  await new Promise((resolve) => setTimeout(resolve, 5));
  inFlight -= 1;
  const range = (JSON.parse(request.userPrompt) as { tileRange: { start: number; end: number } }).tileRange;
  return {
    productName: '测试商品',
    category: '家具',
    brand: '测试牌',
    sellingPoints: [{
      title: `第${range.start}片卖点`,
      factText: '实木框架',
      pointType: 'material',
      evidenceQuote: '实木框架',
      tileRefs: [`tile_${range.start}`],
      confidence: 'medium',
      riskLevel: 'high',
    }],
  };
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 14, concurrency: 3 });

const result = await extractor.extract({ pages: [makePage(43)] });
assert.equal(calls.length, 4, '43 片应按 14/批拆成 4 次调用');
assert.equal(maxInFlight <= 3, true, '批调用并发不得越过上限');
assert.equal(calls.every((call) => (call.images?.length || 0) <= 14), true, '单次请求不超过批大小');
assert.equal(calls.every((call) => call.timeoutMs === 120_000), true, '视觉批请求保留供应商已验证的默认超时');
assert.deepEqual(
  calls.map((call) => (JSON.parse(call.userPrompt) as { tileRange: unknown }).tileRange),
  [{ start: 1, end: 14 }, { start: 15, end: 28 }, { start: 29, end: 42 }, { start: 43, end: 43 }],
  '批提示必须携带整页编号区间',
);
assert.equal(result.sellingPoints.length, 4);
assert.deepEqual(
  result.sellingPoints.map((point) => point.tileRefs?.[0]),
  ['tile_1', 'tile_15', 'tile_29', 'tile_43'],
  '合并后 tileRefs 保持整页编号与页内顺序',
);
assert.deepEqual(
  result.sellingPoints.map((point) => point.evidenceRefs),
  [
    [{ pageIndex: 0, tileRef: 'tile_1' }],
    [{ pageIndex: 0, tileRef: 'tile_15' }],
    [{ pageIndex: 0, tileRef: 'tile_29' }],
    [{ pageIndex: 0, tileRef: 'tile_43' }],
  ],
  '每条证据引用从解析起就带 pageIndex + tileRef 配对',
);
assert.equal(result.productName, '测试商品');
assert.equal(result.promptContractVersion,  3);
// 提取合约 v3：提示词要求模型返回主题与层级字段；老响应缺失字段时本地默认值兜底。
assert.equal(calls.every((call) => call.userPrompt.includes('themeKey') && call.userPrompt.includes('hierarchyRole') && call.userPrompt.includes('importance')), true, '提取提示词必须要求主题与层级字段');
assert.equal(calls.every((call) => call.userPrompt.includes('大标题只用于分组与排序')), true, '大标题不得被当作证据豁免');
assert.deepEqual(
  result.sellingPoints.map((point) => [point.themeKey, point.themeTitle, point.hierarchyRole, point.importance]),
  [['', '', 'supporting', 50], ['', '', 'supporting', 50], ['', '', 'supporting', 50], ['', '', 'supporting', 50]],
  '老视觉响应缺少新字段时必须回退本地默认值',
);
assert.deepEqual(
  result.batchMetrics?.map((metric) => ({
    pageIndex: metric.pageIndex,
    start: metric.start,
    end: metric.end,
    attempts: metric.attempts,
    attemptCount: metric.attemptElapsedMs.length,
  })),
  [
    { pageIndex: 0, start: 1, end: 14, attempts: 1, attemptCount: 1 },
    { pageIndex: 0, start: 15, end: 28, attempts: 1, attemptCount: 1 },
    { pageIndex: 0, start: 29, end: 42, attempts: 1, attemptCount: 1 },
    { pageIndex: 0, start: 43, end: 43, attempts: 1, attemptCount: 1 },
  ],
  '提取结果必须按切片顺序记录每批耗时元数据',
);
assert.equal(result.batchMetrics?.every((metric) => metric.elapsedMs >= 0), true);

// 小页不拆批：10 片单次调用。
let smallCalls = 0;
const smallExtractor = createVisionExtractor(async () => {
  smallCalls += 1;
  return { productName: '', category: '', brand: '', sellingPoints: [] };
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 14, concurrency: 3 });
await smallExtractor.extract({ pages: [makePage(10)] });
assert.equal(smallCalls, 1, '不超过批大小的页只调用一次');

// 取消信号：已中断时不再发起调用。
const aborted = new AbortController();
aborted.abort();
let abortedCalls = 0;
const abortExtractor = createVisionExtractor(async () => {
  abortedCalls += 1;
  return {};
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 5, concurrency: 2 });
await assert.rejects(() => abortExtractor.extract({ pages: [makePage(43)] }, aborted.signal), /取消|aborted/i);
assert.equal(abortedCalls, 0, '已取消时不应再发起提取调用');

// 单批瞬时失败（如模型偶发非 JSON）重试一次后成功。
let flakyCalls = 0;
const flakyExtractor = createVisionExtractor(async () => {
  flakyCalls += 1;
  if (flakyCalls === 1) throw new Error('fake 返回了无效 JSON');
  return { productName: '测试商品', category: '', brand: '', sellingPoints: [] };
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 50, concurrency: 3 });
const flakyResult = await flakyExtractor.extract({ pages: [makePage(10)] });
assert.equal(flakyCalls, 2, '单批失败应重试一次');
assert.equal(flakyResult.productName, '测试商品');
assert.equal(flakyResult.batchMetrics?.[0]?.attempts, 2, '指标必须暴露真实重试次数');
assert.equal(flakyResult.batchMetrics?.[0]?.attemptElapsedMs.length, 2);

// 重试后仍失败：抛错并带切片范围，便于定位是哪一批。
let failedCalls = 0;
const failExtractor = createVisionExtractor(async () => {
  failedCalls += 1;
  throw new Error('fake 返回了无效 JSON');
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 50, concurrency: 3 });
await assert.rejects(() => failExtractor.extract({ pages: [makePage(10)] }), /第 1-10 张切片提取失败/);
assert.equal(failedCalls, 2, '单批失败只重试一次');

// 新合约响应：主题与层级字段被完整解析，非法值同样回退默认值。
// 模型 themeKey 只作辅助信息透传；稳定分组键由本地在入库时按页码+规范化标题生成。
const themedExtractor = createVisionExtractor(async () => ({
  productName: '测试商品',
  category: '家具',
  brand: '',
  sellingPoints: [
    {
      title: '加宽坐深', factText: '坐深 60cm', pointType: 'spec', evidenceQuote: '坐深 60cm',
      tileRefs: ['tile_1'], themeKey: 'comfort', themeTitle: '久坐也舒服', hierarchyRole: 'primary', importance: 90,
    },
    {
      title: '普通卖点', factText: '普通事实', pointType: 'other', evidenceQuote: '普通事实',
      tileRefs: ['tile_2'], themeKey: 'x', themeTitle: '某区域', hierarchyRole: 'boss', importance: 999,
    },
    {
      title: '空重要度卖点', factText: '普通事实二', pointType: 'other', evidenceQuote: '普通事实二',
      tileRefs: ['tile_3'], themeKey: 'x', themeTitle: '某区域', importance: null,
    },
  ],
}), { id: 'fake', model: 'fake' }, { tileBatchSize: 50, concurrency: 1 });
const themedResult = await themedExtractor.extract({ pages: [makePage(3)] });
assert.equal(themedResult.promptContractVersion, 3);
assert.deepEqual(
  themedResult.sellingPoints.map((point) => [point.themeKey, point.themeTitle, point.hierarchyRole, point.importance]),
  [['comfort', '久坐也舒服', 'primary', 90], ['x', '某区域', 'supporting', 100], ['x', '某区域', 'supporting', 50]],
  '主题与层级字段必须解析；非法角色/越界重要度/null 重要度回退默认',
);

// 同页同标题跨识别批次：两个批次返回相同 themeTitle 时解析保持一致，由入库时的
// canonical themeKey（pageIndex + 规范化标题）完成归并。
const batchThemeExtractor = createVisionExtractor(async (request) => {
  const range = (JSON.parse(request.userPrompt) as { tileRange: { start: number; end: number } }).tileRange;
  return {
    productName: '', category: '', brand: '',
    sellingPoints: [{
      title: `批次${range.start}卖点`, factText: `事实${range.start}`, pointType: 'spec',
      evidenceQuote: `事实${range.start}`, tileRefs: [`tile_${range.start}`],
      themeKey: range.start === 1 ? 'theme-1' : 'theme-2', themeTitle: '久坐也舒服',
    }],
  };
}, { id: 'fake', model: 'fake' }, { tileBatchSize: 2, concurrency: 1 });
const batchThemeResult = await batchThemeExtractor.extract({ pages: [makePage(4)] });
assert.deepEqual(
  batchThemeResult.sellingPoints.map((point) => [point.sourcePageIndex, point.themeTitle]),
  [[0, '久坐也舒服'], [0, '久坐也舒服']],
  '跨批次同页同标题必须原样保留，归并由本地 canonical themeKey 完成',
);

console.log('script-studio-vision-extract.test.ts: ok');
