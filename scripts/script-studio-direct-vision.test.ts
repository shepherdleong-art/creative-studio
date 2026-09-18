import assert from 'node:assert/strict';
import { createDirectVisionExtractor } from '../lib/script-studio/adapters/direct-vision.ts';
import type { VisionExtractInput } from '../lib/script-studio/adapters/vision-extract.ts';
import { runEvidenceGate } from '../lib/script-studio/evidence-gate.ts';

const input = (count: number): VisionExtractInput => ({ pages: Array.from({ length: count }, (_, pageIndex) => ({
  pageIndex, imageAssetId: `asset-${pageIndex}`, filename: `${pageIndex}.jpg`, sourceWidth: 1200, sourceHeight: 800,
  tiles: [{ mimeType: 'image/jpeg', imageBase64: `image-${pageIndex}` }],
})) });
const response = (imageRefs: number[] = [1]) => ({ productName: '测试床', category: '床', brand: '', sellingPoints: [{
  title: '高脚方便清洁', detail: '床脚高度 15cm，便于清洁床下。', factText: '床脚高度 15cm', evidenceQuote: '15cm高脚', imageRefs, pointType: 'spec', importance: 90,
}] });

for (const count of [2, 50, 55, 101]) {
  const sizes: number[] = [];
  let active = 0;
  let maxActive = 0;
  const extractor = createDirectVisionExtractor(async (request) => {
    assert.equal(request.preserveImageBytes, true);
    assert.equal(request.temperature, 1);
    sizes.push(request.images!.length);
    maxActive = Math.max(maxActive, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response([1, request.images!.length]);
  }, { id: 'luna', model: 'test' });
  const result = await extractor.extract(input(count));
  assert.equal(sizes.length, Math.ceil(count / 50));
  assert.ok(sizes.every((size) => size <= 50));
  assert.ok(maxActive <= 2);
  assert.equal(sizes.reduce((a, b) => a + b, 0), count);
  assert.equal(result.promptContractVersion, 7);
  assert.equal(result.sellingPoints.at(-1)!.evidenceRefs!.at(-1)!.pageIndex, count - 1, '后续批次必须映射回原页码');
  if (count === 55) assert.deepEqual(sizes, [28, 27]);
}
let attempts = 0;
const retries = createDirectVisionExtractor(async () => { attempts++; return response(attempts === 1 ? [99] : [1]); }, { id: 'luna', model: 'test' });
await retries.extract(input(2));
assert.equal(attempts, 2, '越界引用必须拒绝并有界重试');
const cancelled = AbortSignal.abort();
await assert.rejects(() => retries.extract(input(2), cancelled), { name: 'AbortError' });
assert.equal(attempts, 2, '取消后不得发起请求');
const valid = (await retries.extract(input(2))).sellingPoints[0]!;
const gate = await runEvidenceGate([valid, { ...valid, evidenceQuote: '' }, { ...valid, evidenceRefs: [{ pageIndex: 999, tileRef: 'tile_1' }] }], {
  manualReview: true, pageCount: 2, pageTileCounts: [1, 1],
  reprobe: { kind: 'vision_closed_question', async verify() { throw new Error('不得自动二次核验'); } },
});
assert.equal(gate.reprobeRequestCount, 0);
assert.equal(gate.points[0]!.usable, true);
assert.equal(gate.points[0]!.riskLevel, 'high');
assert.equal(gate.points[0]!.evidenceGate, 'skipped', '单次识图不得标记核验通过');
assert.equal(gate.excludedStructural, 2);
console.log('script-studio-direct-vision.test.ts: ok');
