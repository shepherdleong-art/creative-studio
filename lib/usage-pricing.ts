/**
 * The small, dependency-free pricing boundary for the core usage dashboard.
 *
 * The dashboard deliberately does not read a provider's editable cost fields.
 * A provider is eligible only when its complete runtime identity matches one
 * of the five entries below, and every amount is kept in integer micros.
 */

export const CORE_USAGE_PRICING_VERSION = 'core-usage-pricing-v1';
export const PRICING_VERSION = CORE_USAGE_PRICING_VERSION;

export type CoreUsageProviderTable =
  | 'providers'
  | 'video_providers'
  | 'script_providers'
  | 'final_edit_tts_providers';

export type CoreUsageCategory = 'image' | 'video' | 'llm_text' | 'llm_vision' | 'tts';

export type CoreUsageModelKey =
  | 'company-image2-medium'
  | 'company-kling-3-0'
  | 'company-seedance-fast'
  | 'company-gpt-5-6-luna'
  | 'doubao-seed-tts-2';

export type CoreUsagePriceComponentKey =
  | 'image'
  | 'request'
  | 'second'
  | 'input_token'
  | 'output_token'
  | 'cached_input_token'
  | 'character';

export type CoreUsageUnit = 'image' | 'request' | 'second' | 'token' | 'character';

export interface CoreUsageProviderSnapshot {
  providerTable: CoreUsageProviderTable;
  providerId: string;
  providerName: string;
  providerType: string;
  executionScope?: 'company' | 'external';
  apiStyle?: string;
  configuredModel: string;
  requestModel: string;
}

export interface CoreUsagePriceComponentV1 {
  key: CoreUsagePriceComponentKey;
  unit: CoreUsageUnit;
  unitPriceMicros: number;
  priceScale: number;
}

export interface CoreUsagePlan {
  coreModelKey: CoreUsageModelKey;
  category: CoreUsageCategory;
  displayModel: string;
  pricingVersion: string;
  priceComponents: readonly CoreUsagePriceComponentV1[];
  /** A single-component convenience value; GPT intentionally uses 0/1. */
  unit: CoreUsageUnit;
  unitPriceMicros: number;
  priceScale: number;
}

export interface CoreUsageSnapshotV1 {
  schemaVersion: 1;
  provider: CoreUsageProviderSnapshot;
  coreModelKey: string;
  pricingVersion: string;
  priceComponents: CoreUsagePriceComponentV1[];
  startedAt: string;
  projectId?: string;
  refType: string;
  refId: string;
}

export interface CoreUsageSnapshotOptions {
  startedAt?: string;
  projectId?: string;
  refType: string;
  refId: string;
}

export interface GptTokenUsageInput {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cachedReadTokens?: number;
}

export interface NormalizedGptTokenUsage {
  uncachedInputTokens: number;
  cachedReadTokens: number;
  outputTokens: number;
}

const IMAGE_COMPONENT: CoreUsagePriceComponentV1 = {
  key: 'image',
  unit: 'image',
  unitPriceMicros: 1_050_000,
  priceScale: 1,
};
const KLING_COMPONENT: CoreUsagePriceComponentV1 = {
  key: 'second',
  unit: 'second',
  unitPriceMicros: 2_990_000,
  priceScale: 5,
};
const SEEDANCE_COMPONENT: CoreUsagePriceComponentV1 = {
  key: 'second',
  unit: 'second',
  unitPriceMicros: 11_730_000,
  priceScale: 5,
};
const GPT_COMPONENTS: readonly CoreUsagePriceComponentV1[] = [
  { key: 'input_token', unit: 'token', unitPriceMicros: 2_887_800, priceScale: 1_000_000 },
  { key: 'output_token', unit: 'token', unitPriceMicros: 12_995_200, priceScale: 1_000_000 },
  { key: 'cached_input_token', unit: 'token', unitPriceMicros: 288_780, priceScale: 1_000_000 },
];
const TTS_COMPONENT: CoreUsagePriceComponentV1 = {
  key: 'character',
  unit: 'character',
  unitPriceMicros: 280_000,
  priceScale: 1_000,
};

function cloneComponents(components: readonly CoreUsagePriceComponentV1[]): readonly CoreUsagePriceComponentV1[] {
  return Object.freeze(components.map((component) => Object.freeze({ ...component })));
}

function createPlan(
  coreModelKey: CoreUsageModelKey,
  category: CoreUsageCategory,
  displayModel: string,
  components: readonly CoreUsagePriceComponentV1[],
  topLevel?: { unitPriceMicros: number; priceScale: number },
): CoreUsagePlan {
  const priceComponents = cloneComponents(components);
  return Object.freeze({
    coreModelKey,
    category,
    displayModel,
    pricingVersion: CORE_USAGE_PRICING_VERSION,
    priceComponents,
    unit: priceComponents[0].unit,
    unitPriceMicros: topLevel?.unitPriceMicros ?? priceComponents[0].unitPriceMicros,
    priceScale: topLevel?.priceScale ?? priceComponents[0].priceScale,
  });
}

/** The fixed registry is exported for read-only consumers and tests. */
export const CORE_USAGE_PRICING = Object.freeze({
  image: Object.freeze({ unitPriceMicros: IMAGE_COMPONENT.unitPriceMicros, priceScale: IMAGE_COMPONENT.priceScale }),
  kling: Object.freeze({ unitPriceMicros: KLING_COMPONENT.unitPriceMicros, priceScale: KLING_COMPONENT.priceScale }),
  seedance: Object.freeze({ unitPriceMicros: SEEDANCE_COMPONENT.unitPriceMicros, priceScale: SEEDANCE_COMPONENT.priceScale }),
  gptInput: Object.freeze({ unitPriceMicros: GPT_COMPONENTS[0].unitPriceMicros, priceScale: GPT_COMPONENTS[0].priceScale }),
  gptOutput: Object.freeze({ unitPriceMicros: GPT_COMPONENTS[1].unitPriceMicros, priceScale: GPT_COMPONENTS[1].priceScale }),
  gptCachedInput: Object.freeze({ unitPriceMicros: GPT_COMPONENTS[2].unitPriceMicros, priceScale: GPT_COMPONENTS[2].priceScale }),
  tts: Object.freeze({ unitPriceMicros: TTS_COMPONENT.unitPriceMicros, priceScale: TTS_COMPONENT.priceScale }),
});

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function matchesIdentity(
  provider: Partial<CoreUsageProviderSnapshot>,
  expected: {
    providerTable: CoreUsageProviderTable;
    providerId: string;
    providerType: string;
    configuredModel: string;
    requestModel: string;
    executionScope?: string;
    apiStyle?: string;
  },
): boolean {
  if (
    trimmed(provider.providerTable) !== expected.providerTable
    || trimmed(provider.providerId) !== expected.providerId
    || trimmed(provider.providerType) !== expected.providerType
    || trimmed(provider.configuredModel) !== expected.configuredModel
    || trimmed(provider.requestModel) !== expected.requestModel
  ) {
    return false;
  }
  if (expected.executionScope !== undefined && trimmed(provider.executionScope) !== expected.executionScope) {
    return false;
  }
  if (expected.apiStyle !== undefined && trimmed(provider.apiStyle) !== expected.apiStyle) {
    return false;
  }
  return true;
}

/**
 * Resolve the fixed plan for a complete provider identity.
 *
 * Every comparison is exact after trimming the individual input field. No
 * display name, alias, case folding, or regular expression is consulted.
 */
export function resolveCoreUsagePlan(
  providerSnapshot: CoreUsageProviderSnapshot | null | undefined,
): CoreUsagePlan | null {
  if (!providerSnapshot || typeof providerSnapshot !== 'object') return null;
  const provider = providerSnapshot as Partial<CoreUsageProviderSnapshot>;

  if (matchesIdentity(provider, {
    providerTable: 'providers',
    providerId: 'company-gateway-image2-medium',
    providerType: 'gateway-task-image',
    configuredModel: 'image2-medium',
    requestModel: 'image2-medium',
  })) {
    return createPlan('company-image2-medium', 'image', 'image2-medium', [IMAGE_COMPONENT]);
  }

  if (matchesIdentity(provider, {
    providerTable: 'video_providers',
    providerId: 'company-kling-3-0',
    providerType: 'openai-video',
    configuredModel: 'kling-3.0',
    requestModel: 'kling-3.0',
  })) {
    return createPlan('company-kling-3-0', 'video', 'kling-3.0', [KLING_COMPONENT]);
  }

  if (matchesIdentity(provider, {
    providerTable: 'video_providers',
    providerId: 'company-seedance-2-0-fast',
    providerType: 'openai-video',
    configuredModel: 'doubao-seedance-2-0-fast-260128',
    requestModel: 'doubao-seedance-2-0-fast-260128',
  })) {
    return createPlan(
      'company-seedance-fast',
      'video',
      'doubao-seedance-2-0-fast-260128',
      [SEEDANCE_COMPONENT],
    );
  }

  if (matchesIdentity(provider, {
    providerTable: 'script_providers',
    providerId: 'gpt',
    providerType: 'openai-compatible',
    executionScope: 'company',
    apiStyle: 'openai-compatible',
    configuredModel: 'GPT-5-6-Luna-Standard',
    requestModel: 'GPT-5-6-Luna-Standard',
  })) {
    return createPlan(
      'company-gpt-5-6-luna',
      'llm_text',
      'GPT-5-6-Luna-Standard',
      GPT_COMPONENTS,
      { unitPriceMicros: 0, priceScale: 1 },
    );
  }

  if (matchesIdentity(provider, {
    providerTable: 'final_edit_tts_providers',
    providerId: 'doubao-seed-tts-2',
    providerType: 'doubao-http-chunked',
    configuredModel: 'seed-tts-2.0',
    requestModel: 'seed-tts-2.0',
  })) {
    return createPlan('doubao-seed-tts-2', 'tts', 'seed-tts-2.0', [TTS_COMPONENT]);
  }

  return null;
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Calculate one component using integer micros and the specified rounding rule. */
export function calculateComponentCostMicros(
  quantity: number,
  component: CoreUsagePriceComponentV1,
): number {
  const safeQuantity = asNonNegativeNumber(quantity);
  if (!Number.isFinite(component.unitPriceMicros) || component.priceScale <= 0) return 0;
  return Math.round(safeQuantity * component.unitPriceMicros / component.priceScale);
}

export type CoreUsageQuantities =
  | number
  | readonly number[]
  | Readonly<Record<string, number>>
  | NormalizedGptTokenUsage;

function quantityForComponent(
  quantity: CoreUsageQuantities,
  component: CoreUsagePriceComponentV1,
  index: number,
): number {
  if (typeof quantity === 'number') return index === 0 ? quantity : 0;
  if (Array.isArray(quantity)) return quantity[index] ?? 0;

  const quantityRecord = quantity as Readonly<Record<string, number>>;
  const keysByComponent: Record<CoreUsagePriceComponentKey, readonly string[]> = {
    image: ['image', 'images'],
    request: ['request', 'requests'],
    second: ['second', 'seconds', 'durationSec', 'durationSeconds'],
    input_token: ['input_token', 'inputTokens', 'uncachedInputTokens'],
    output_token: ['output_token', 'outputTokens', 'completionTokens'],
    cached_input_token: ['cached_input_token', 'cachedInputTokens', 'cachedReadTokens', 'cachedTokens'],
    character: ['character', 'characters', 'unicodeCharacters'],
  };
  for (const key of keysByComponent[component.key]) {
    const value = quantityRecord[key];
    if (value !== undefined) return value;
  }
  return 0;
}

/**
 * Calculate a plan (or a raw component list) by rounding each component first
 * and summing only the resulting integer micros.
 */
export function calculateUsageCostMicros(
  planOrComponents: Pick<CoreUsagePlan, 'priceComponents'> | readonly CoreUsagePriceComponentV1[],
  quantity: CoreUsageQuantities,
): number {
  const components: readonly CoreUsagePriceComponentV1[] = Array.isArray(planOrComponents)
    ? planOrComponents as readonly CoreUsagePriceComponentV1[]
    : (planOrComponents as Pick<CoreUsagePlan, 'priceComponents'>).priceComponents;
  return components.reduce(
    (sum, component, index) => sum + calculateComponentCostMicros(quantityForComponent(quantity, component, index), component),
    0,
  );
}

export const calculateCoreUsageCostMicros = calculateUsageCostMicros;

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Split prompt usage so cached input is never charged again at the uncached rate. */
export function normalizeGptTokenUsage(input: GptTokenUsageInput): NormalizedGptTokenUsage {
  const promptTokens = nonNegativeInteger(input.promptTokens);
  const cachedReadTokens = nonNegativeInteger(input.cachedReadTokens ?? input.cachedTokens);
  return {
    uncachedInputTokens: Math.max(promptTokens - cachedReadTokens, 0),
    cachedReadTokens,
    outputTokens: nonNegativeInteger(input.completionTokens),
  };
}

export const normalizeGptUsage = normalizeGptTokenUsage;

export function calculateGptUsageCostMicros(input: GptTokenUsageInput): number {
  return calculateUsageCostMicros(GPT_COMPONENTS, normalizeGptTokenUsage(input));
}

export const calculateGptTokenCostMicros = calculateGptUsageCostMicros;

function snapshotProvider(provider: CoreUsageProviderSnapshot): CoreUsageProviderSnapshot {
  const normalized: CoreUsageProviderSnapshot = {
    ...provider,
    providerTable: trimmed(provider.providerTable) as CoreUsageProviderTable,
    providerId: trimmed(provider.providerId),
    providerName: trimmed(provider.providerName),
    providerType: trimmed(provider.providerType),
    configuredModel: trimmed(provider.configuredModel),
    requestModel: trimmed(provider.requestModel),
  };
  if (provider.executionScope !== undefined) normalized.executionScope = trimmed(provider.executionScope) as 'company' | 'external';
  if (provider.apiStyle !== undefined) normalized.apiStyle = trimmed(provider.apiStyle);
  return normalized;
}

export function createCoreUsageSnapshot(
  provider: CoreUsageProviderSnapshot,
  plan: Pick<CoreUsagePlan, 'coreModelKey' | 'pricingVersion' | 'priceComponents'>,
  options: CoreUsageSnapshotOptions,
): CoreUsageSnapshotV1 {
  return {
    schemaVersion: 1,
    provider: snapshotProvider(provider),
    coreModelKey: plan.coreModelKey,
    pricingVersion: plan.pricingVersion,
    priceComponents: plan.priceComponents.map((component) => ({ ...component })),
    startedAt: options.startedAt ?? new Date().toISOString(),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    refType: options.refType,
    refId: options.refId,
  };
}

export const makeCoreUsageSnapshot = createCoreUsageSnapshot;
export const createUsageSnapshot = createCoreUsageSnapshot;
