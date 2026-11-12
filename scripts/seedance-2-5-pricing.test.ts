import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateUsageCostMicros, createCoreUsageSnapshot, resolveCoreUsagePlan } from '../lib/usage-pricing.ts';
import { parseUsageSnapshot } from '../lib/usage-snapshot.ts';
import { estimateSeedance25ReferenceVideoTokens, estimateSeedance25VideoTokens, seedance25StageOutputSize, SEEDANCE_25_STAGE_PRICING_VERSION } from '../lib/seedance-2-5-pricing.ts';

const provider = {
  providerTable: 'video_providers' as const, providerId: 'company-seedance-2-5',
  providerName: '公司 Seedance 2.5', providerType: 'openai-video',
  configuredModel: 'doubao-seedance-2-5-260628', requestModel: 'doubao-seedance-2-5-260628',
};
for (const generationStage of ['draft', 'final-from-draft'] as const) {
  for (const hasInputVideo of [false, true]) {
    const plan = resolveCoreUsagePlan(provider, { generationStage, hasInputVideo });
    assert.ok(plan);
    assert.equal(plan.pricingVersion, SEEDANCE_25_STAGE_PRICING_VERSION);
    assert.equal(plan.unit, 'token');
    const yuanPerMillion = generationStage === 'draft' ? (hasInputVideo ? 42 : 70) : (hasInputVideo ? 46 : 77);
    assert.equal(calculateUsageCostMicros(plan, 1_000_000), yuanPerMillion * 1_000_000);
    const snapshot = createCoreUsageSnapshot(provider, plan, { refType: 'canvas-task', refId: 'task' });
    const parsed = parseUsageSnapshot(snapshot);
    assert.equal(parsed.ok, true, 'stage token snapshots must pass the shared ledger gate');
  }
}
const draft = resolveCoreUsagePlan(provider, { generationStage: 'draft', hasInputVideo: false })!;
const final = resolveCoreUsagePlan(provider, { generationStage: 'final-from-draft', hasInputVideo: false })!;
assert.deepEqual(seedance25StageOutputSize('draft', '16:9'), [854, 480]);
assert.deepEqual(seedance25StageOutputSize('final-from-draft', '9:16'), [1080, 1920]);
const draftTokens = estimateSeedance25VideoTokens(5, 854, 480)!;
const finalTokens = estimateSeedance25VideoTokens(5, 1920, 1080)!;
assert.equal(calculateUsageCostMicros(draft, draftTokens), 3_362_625);
assert.equal(calculateUsageCostMicros(final, finalTokens), 18_711_000);
assert.equal(calculateUsageCostMicros(draft, draftTokens) + calculateUsageCostMicros(final, finalTokens), 22_073_625);
assert.equal(estimateSeedance25VideoTokens(-1, 854, 480), null);
assert.equal(estimateSeedance25VideoTokens(5, NaN, 480), null);
assert.equal(seedance25StageOutputSize('draft', 'unsupported'), null);
// Existing direct-generation snapshots keep their original per-second price.
const legacy = resolveCoreUsagePlan(provider)!;
assert.equal(calculateUsageCostMicros(legacy, 5), 9_450_000);
assert.equal(parseUsageSnapshot(createCoreUsageSnapshot(provider, legacy, { refType: 'video-job', refId: 'old' })).ok, true);
// Do not replace a frozen historical token price with today's rate.
const oldTokenSnapshot = createCoreUsageSnapshot(provider, draft, { refType: 'canvas-task', refId: 'old-draft' });
oldTokenSnapshot.priceComponents[0].unitPriceMicros = 60_000_000;
const parsedOld = parseUsageSnapshot(oldTokenSnapshot);
assert.equal(parsedOld.ok, true);
if (parsedOld.ok) assert.equal(calculateUsageCostMicros(parsedOld.parsed.snapshot, 1_000_000), 60_000_000);
assert.equal(resolveCoreUsagePlan({ ...provider, providerId: 'external', baseUrl: 'https://external.example' }, { generationStage: 'draft', hasInputVideo: false }), null);
// Literal reference-duration thresholds extracted from the official 339-row table.
const minimumFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/seedance-2-5-minimum-token-thresholds.json', import.meta.url), 'utf8')) as {
  minimumReferenceDurationByOutputDuration: Record<string, number>;
};
for (const [duration, minimumInput] of Object.entries(minimumFixture.minimumReferenceDurationByOutputDuration)) {
  for (const stage of ['draft', 'final-from-draft'] as const) {
    for (const ratio of ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']) {
      const size = seedance25StageOutputSize(stage, ratio)!;
      const estimate = estimateSeedance25ReferenceVideoTokens(Number(duration), 2, size[0], size[1])!;
      assert.equal(estimate.minimumInputVideoDurationSec, minimumInput, `${stage}/${ratio}/${duration}s`);
      assert.ok(estimate.billableTokens >= estimate.estimatedTokens);
      assert.ok(estimate.billableTokens >= estimate.minimumTokens);
    }
  }
}
for (const example of [
  { output: 4, input: 2, width: 854, height: 480, minimum: 67_252.5, billable: 67_252.5 },
  { output: 5, input: 3, width: 854, height: 480, minimum: 86_467.5, billable: 86_467.5 },
  { output: 5, input: 4, width: 854, height: 480, minimum: 86_467.5, billable: 86_467.5 },
  { output: 5, input: 5, width: 854, height: 480, minimum: 86_467.5, billable: 96_075 },
  { output: 5, input: 30, width: 854, height: 480, minimum: 86_467.5, billable: 336_262.5 },
  { output: 6, input: 2, width: 854, height: 480, minimum: 96_075, billable: 96_075 },
  { output: 7, input: 2, width: 854, height: 480, minimum: 115_290, billable: 115_290 },
  { output: 30, input: 2, width: 854, height: 480, minimum: 480_375, billable: 480_375 },
  { output: 5, input: 3, width: 1920, height: 1080, minimum: 437_400, billable: 437_400 },
  { output: 5, input: 5, width: 1920, height: 1080, minimum: 437_400, billable: 486_000 },
  { output: 5, input: 3, width: 560, height: 752, minimum: 88_830, billable: 88_830 },
]) {
  const estimate = estimateSeedance25ReferenceVideoTokens(example.output, example.input, example.width, example.height)!;
  assert.equal(estimate.minimumTokens, example.minimum);
  assert.equal(estimate.billableTokens, example.billable);
}
const withVideoDraft = resolveCoreUsagePlan(provider, { generationStage: 'draft', hasInputVideo: true })!;
const withVideoFinal = resolveCoreUsagePlan(provider, { generationStage: 'final-from-draft', hasInputVideo: true })!;
assert.equal(calculateUsageCostMicros(withVideoDraft, 86_467.5), 3_631_635);
assert.equal(calculateUsageCostMicros(withVideoFinal, 437_400), 20_120_400);
for (const args of [[5, 0, 854, 480], [-1, 3, 854, 480], [5, NaN, 854, 480], [5, Infinity, 854, 480], [5, 3, 0, 480]]) {
  assert.equal(estimateSeedance25ReferenceVideoTokens(args[0], args[1], args[2], args[3]), null);
}
console.log('seedance-2-5-pricing tests passed');
