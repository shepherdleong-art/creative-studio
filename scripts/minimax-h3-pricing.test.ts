import assert from 'node:assert/strict';
import {
  BILLING_MODEL_PRICES, calculateUsageCostMicros, createCoreUsageSnapshot, resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
} from '../lib/usage-pricing.ts';
import { parseUsageSnapshot } from '../lib/usage-snapshot.ts';
import { MINIMAX_H3_PRICING_VERSION, minimaxH3Quantities, referenceVideoDurationSec } from '../lib/minimax-h3-pricing.ts';

const h3Id = BILLING_MODEL_PRICES.find((entry) => entry.model === 'minimax-h3')!.id;
const provider: CoreUsageProviderSnapshot = {
  providerTable: 'video_providers', providerId: h3Id, providerName: 'H3', providerType: 'openai-video',
  configuredModel: 'minimax-h3', requestModel: 'minimax-h3', baseUrl: 'http://127.0.0.1:4000',
};
for (const [resolution, expected, unitPrice] of [['768P', 5_000_000, 500_000], ['2K', 8_000_000, 800_000]] as const) {
  const plan = resolveCoreUsagePlan(provider, { resolution })!;
  assert.equal(plan.pricingVersion, MINIMAX_H3_PRICING_VERSION);
  assert.deepEqual(plan.priceComponents, [
    { key: 'input_second', unit: 'second', unitPriceMicros: unitPrice, priceScale: 1 },
    { key: 'output_second', unit: 'second', unitPriceMicros: unitPrice, priceScale: 1 },
  ]);
  const videoUsage = { resolution, inputVideoDurationSec: 5, outputVideoDurationSec: 5 };
  assert.equal(calculateUsageCostMicros(plan, minimaxH3Quantities(videoUsage)), expected);
  assert.equal(calculateUsageCostMicros(plan, { input_second: 2.125, output_second: 15 }), Math.round(17.125 * unitPrice), 'no minimum-input or whole-second rounding');
  assert.equal(calculateUsageCostMicros(plan, { input_second: 0, output_second: 5 }), expected / 2);
  const frozen = createCoreUsageSnapshot(provider, plan, { refType: 'video-job', refId: 'h3', videoUsage });
  frozen.priceComponents[0].unitPriceMicros = 123_456;
  const parsed = parseUsageSnapshot(JSON.stringify(frozen));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.parsed.snapshot.priceComponents[0].unitPriceMicros, 123_456, 'frozen component rates survive validation');
    assert.deepEqual(parsed.parsed.snapshot.videoUsage, videoUsage);
  }
  assert.equal(parseUsageSnapshot({ ...frozen, videoUsage: { ...videoUsage, inputVideoDurationSec: null } }).ok, false);
}
assert.equal(resolveCoreUsagePlan(provider, { resolution: '1080P' }), null);
assert.equal(resolveCoreUsagePlan({ ...provider, providerId: 'external', baseUrl: 'https://external.example' }, { resolution: '2K' }), null);
assert.ok(resolveCoreUsagePlan({ ...provider, providerId: 'manual-company-h3' }, { resolution: '768P' }));
assert.equal(referenceVideoDurationSec([
  { kind: 'image', durationSec: null }, { kind: 'audio', durationSec: 15 },
  { kind: 'video', durationSec: 2.125 }, { kind: 'video', durationSec: 3.25 },
]), 5.375);
for (const durationSec of [null, 0, -1, NaN, Infinity]) {
  assert.equal(referenceVideoDurationSec([{ kind: 'video', durationSec }]), null);
}
assert.equal(referenceVideoDurationSec([{ kind: null, durationSec: null }]), null);
const old = resolveCoreUsagePlan(provider)!;
const oldSnapshot = createCoreUsageSnapshot(provider, old, { refType: 'video-job', refId: 'old' });
assert.equal(parseUsageSnapshot(oldSnapshot).ok, true);
assert.equal(calculateUsageCostMicros(old, 5), 4_000_000, 'old H3 seconds snapshots retain their historical rate');
const wan = resolveCoreUsagePlan({ ...provider, providerId: 'company-wan-3-0', configuredModel: 'wan-3.0', requestModel: 'wan-3.0' }, { resolution: '768P' })!;
assert.equal(calculateUsageCostMicros(wan, 5), 6_000_000, 'Wan remains on the existing average');
assert.deepEqual(wan.priceComponents.map((component) => component.key), ['second']);
console.log('minimax-h3-pricing.test.ts passed');
