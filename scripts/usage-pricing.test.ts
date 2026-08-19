import assert from 'node:assert/strict';
import {
  CORE_USAGE_PRICING_VERSION,
  calculateUsageCostMicros,
  createCoreUsageSnapshot,
  normalizeGptTokenUsage,
  resolveCoreUsagePlan,
  type CoreUsageProviderSnapshot,
} from '../lib/usage-pricing.ts';

function snapshot(overrides: Partial<CoreUsageProviderSnapshot> = {}): CoreUsageProviderSnapshot {
  return {
    providerTable: 'providers',
    providerId: 'company-gateway-image2-medium',
    providerName: '公司图片',
    providerType: 'gateway-task-image',
    configuredModel: 'image2-medium',
    requestModel: 'image2-medium',
    ...overrides,
  };
}

function mustPlan(provider: CoreUsageProviderSnapshot) {
  const plan = resolveCoreUsagePlan(provider);
  assert.ok(plan, `expected a plan for ${provider.providerId}`);
  return plan;
}

const imagePlan = mustPlan(snapshot());
assert.equal(imagePlan.coreModelKey, 'company-image2-medium');
assert.equal(imagePlan.category, 'image');
assert.equal(imagePlan.pricingVersion, CORE_USAGE_PRICING_VERSION);
assert.deepEqual(imagePlan.priceComponents, [
  { key: 'image', unit: 'image', unitPriceMicros: 1_050_000, priceScale: 1 },
]);
assert.equal(calculateUsageCostMicros(imagePlan, { image: 1 }), 1_050_000);

const klingPlan = mustPlan(snapshot({
  providerTable: 'video_providers',
  providerId: 'company-kling-3-0',
  providerType: 'openai-video',
  configuredModel: 'kling-3.0',
  requestModel: 'kling-3.0',
}));
assert.equal(klingPlan.coreModelKey, 'company-kling-3-0');
assert.deepEqual(klingPlan.priceComponents, [
  { key: 'second', unit: 'second', unitPriceMicros: 2_990_000, priceScale: 5 },
]);
assert.equal(calculateUsageCostMicros(klingPlan, { second: 5 }), 2_990_000);
assert.equal(calculateUsageCostMicros(klingPlan, { second: 1 }), 598_000);
assert.equal(calculateUsageCostMicros(klingPlan, { second: 7 }), 4_186_000);

const seedancePlan = mustPlan(snapshot({
  providerTable: 'video_providers',
  providerId: 'company-seedance-2-0-fast',
  providerType: 'openai-video',
  configuredModel: 'doubao-seedance-2-0-fast-260128',
  requestModel: 'doubao-seedance-2-0-fast-260128',
}));
assert.equal(seedancePlan.coreModelKey, 'company-seedance-fast');
assert.equal(calculateUsageCostMicros(seedancePlan, { second: 5 }), 11_730_000);
assert.equal(calculateUsageCostMicros(seedancePlan, { second: 3 }), 7_038_000);
assert.equal(calculateUsageCostMicros(seedancePlan, { second: 8 }), 18_768_000);

const gptPlan = mustPlan(snapshot({
  providerTable: 'script_providers',
  providerId: 'gpt',
  providerType: 'openai-compatible',
  executionScope: 'company',
  apiStyle: 'openai-compatible',
  configuredModel: 'GPT-5-6-Luna-Standard',
  requestModel: 'GPT-5-6-Luna-Standard',
}));
assert.equal(gptPlan.coreModelKey, 'company-gpt-5-6-luna');
assert.equal(gptPlan.unitPriceMicros, 0);
assert.equal(gptPlan.priceScale, 1);
assert.deepEqual(gptPlan.priceComponents, [
  { key: 'input_token', unit: 'token', unitPriceMicros: 2_887_800, priceScale: 1_000_000 },
  { key: 'output_token', unit: 'token', unitPriceMicros: 12_995_200, priceScale: 1_000_000 },
  { key: 'cached_input_token', unit: 'token', unitPriceMicros: 288_780, priceScale: 1_000_000 },
]);
const normalizedGpt = normalizeGptTokenUsage({ promptTokens: 1_000_003, completionTokens: 3, cachedTokens: 3 });
assert.deepEqual(normalizedGpt, {
  uncachedInputTokens: 1_000_000,
  cachedReadTokens: 3,
  outputTokens: 3,
});
assert.equal(
  calculateUsageCostMicros(gptPlan, normalizedGpt),
  2_887_800 + 1 + 39,
  'GPT rounds each component before summing and never uses its 0/1 top-level price',
);
const roundedGpt = calculateUsageCostMicros(gptPlan, {
  uncachedInputTokens: 1,
  cachedReadTokens: 1,
  outputTokens: 1,
});
assert.equal(roundedGpt, 16, 'each one-token GPT component rounds independently');

const ttsPlan = mustPlan(snapshot({
  providerTable: 'final_edit_tts_providers',
  providerId: 'doubao-seed-tts-2',
  providerType: 'doubao-http-chunked',
  configuredModel: 'seed-tts-2.0',
  requestModel: 'seed-tts-2.0',
}));
assert.equal(ttsPlan.coreModelKey, 'doubao-seed-tts-2');
assert.deepEqual(ttsPlan.priceComponents, [
  { key: 'character', unit: 'character', unitPriceMicros: 280_000, priceScale: 1_000 },
]);
assert.equal(calculateUsageCostMicros(ttsPlan, { character: Array.from('你好🙂').length }), 840);

// Trimming each supplied field is permitted, but matching remains exact and case-sensitive.
assert.ok(resolveCoreUsagePlan(snapshot({
  providerId: ' company-gateway-image2-medium ',
  providerType: ' gateway-task-image ',
  configuredModel: ' image2-medium ',
  requestModel: ' image2-medium ',
})));

const negativeCases: Array<Partial<CoreUsageProviderSnapshot>> = [
  { providerId: 'packy-image', providerType: 'openai-compatible' },
  { providerId: 'company-gateway-image2-medium', providerType: 'gateway-task-image', configuredModel: 'gemini-3.1-flash-image-preview', requestModel: 'gemini-3.1-flash-image-preview' },
  { providerId: 'company-gateway-image2-medium', providerType: 'gateway-task-image', configuredModel: 'image2-medium', requestModel: 'image2-medium-preview' },
  { providerId: 'company-gateway-image2-medium', providerType: 'gateway-task-image', configuredModel: 'IMAGE2-MEDIUM', requestModel: 'IMAGE2-MEDIUM' },
  { providerTable: 'video_providers', providerId: 'kling-3', providerType: 'kling', configuredModel: 'kling-3.0', requestModel: 'kling-3.0' },
  { providerTable: 'video_providers', providerId: 'company-kling-3-0', providerType: 'kling', configuredModel: 'kling-3.0', requestModel: 'kling-3.0' },
  { providerTable: 'video_providers', providerId: 'company-kling-3-0', providerType: 'openai-video', configuredModel: 'kling-v3', requestModel: 'kling-v3' },
  { providerTable: 'video_providers', providerId: 'company-seedance-2-0-fast', providerType: 'jimeng', configuredModel: 'doubao-seedance-2-0-fast-260128', requestModel: 'doubao-seedance-2-0-fast-260128' },
  { providerTable: 'script_providers', providerId: 'gpt', providerType: 'openai-compatible', executionScope: 'external', apiStyle: 'openai-compatible', configuredModel: 'GPT-5-6-Luna-Standard', requestModel: 'GPT-5-6-Luna-Standard' },
  { providerTable: 'script_providers', providerId: 'gpt', providerType: 'openai-compatible', executionScope: 'company', apiStyle: 'anthropic-messages', configuredModel: 'GPT-5-6-Luna-Standard', requestModel: 'GPT-5-6-Luna-Standard' },
  { providerTable: 'script_providers', providerId: 'gpt', providerType: 'openai-compatible', executionScope: 'company', apiStyle: 'openai-compatible', configuredModel: 'gpt-5-6-luna-standard', requestModel: 'gpt-5-6-luna-standard' },
  { providerTable: 'script_providers', providerId: 'gpt', providerType: 'openai-compatible', executionScope: 'company', apiStyle: 'openai-compatible', configuredModel: 'GPT-5-6-Luna-Standard', requestModel: 'GPT-5-6-Luna-Standard-Preview' },
  { providerTable: 'final_edit_tts_providers', providerId: 'vapi-qwen3-tts', providerType: 'vapi-qwen-json-url', configuredModel: 'seed-tts-2.0', requestModel: 'seed-tts-2.0' },
  { providerTable: 'final_edit_tts_providers', providerId: 'doubao-seed-tts-2', providerType: 'doubao-http-chunked', configuredModel: 'seed-tts-2', requestModel: 'seed-tts-2' },
  { providerTable: 'final_edit_tts_providers', providerId: 'doubao-seed-tts-2', providerType: 'doubao-http-chunked', configuredModel: 'seed-tts-2.0', requestModel: 'seed-tts-2.0-preview' },
];
for (const overrides of negativeCases) {
  assert.equal(resolveCoreUsagePlan(snapshot(overrides)), null, `must reject ${JSON.stringify(overrides)}`);
}

const snapshotValue = createCoreUsageSnapshot(
  snapshot(),
  imagePlan,
  { startedAt: '2026-08-18T00:00:00.000Z', projectId: 'project-1', refType: 'job', refId: 'job-1' },
);
assert.deepEqual(snapshotValue, {
  schemaVersion: 1,
  provider: snapshot(),
  coreModelKey: 'company-image2-medium',
  pricingVersion: CORE_USAGE_PRICING_VERSION,
  priceComponents: imagePlan.priceComponents,
  startedAt: '2026-08-18T00:00:00.000Z',
  projectId: 'project-1',
  refType: 'job',
  refId: 'job-1',
});

console.log('usage-pricing tests passed');
