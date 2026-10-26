import {
  BILLING_MODEL_PRICES,
  resolveCoreUsagePlan,
  type CoreUsageCategory,
  type CoreUsagePriceComponentV1,
  type CoreUsageSnapshotV1,
} from './usage-pricing.ts';

export interface ParsedSnapshot {
  snapshot: CoreUsageSnapshotV1;
  category: CoreUsageCategory;
}

const CORE_CATEGORIES: Readonly<Record<string, CoreUsageCategory>> = {
  ...Object.fromEntries(BILLING_MODEL_PRICES.map((entry) => [entry.key, entry.category])),
  'company-image2-medium': 'image',
  'company-qiniuyun-gpt-image-2-medium': 'image',
  'company-kling-3-0': 'video',
  'company-qiniuyun-kling-3-0': 'video',
  'company-seedance-fast': 'video',
  'company-seedance-2-5': 'video',
  'company-gpt-5-6-luna': 'llm_text',
  'doubao-seed-tts-2': 'tts',
};

const COMPONENT_KEYS_BY_CORE_MODEL: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(BILLING_MODEL_PRICES.map((entry) => [entry.key, [entry.category === 'image' ? 'image' : entry.category === 'video' ? 'second' : 'request']])),
  'company-image2-medium': ['image'],
  'company-qiniuyun-gpt-image-2-medium': ['image'],
  'company-kling-3-0': ['second'],
  'company-qiniuyun-kling-3-0': ['second'],
  'company-seedance-fast': ['second'],
  'company-seedance-2-5': ['second'],
  'company-gpt-5-6-luna': ['input_token', 'output_token', 'cached_input_token'],
  'doubao-seed-tts-2': ['character'],
};

const COMPONENT_UNITS_BY_KEY: Readonly<Record<string, string>> = {
  request: 'request',
  image: 'image',
  second: 'second',
  input_token: 'token',
  output_token: 'token',
  cached_input_token: 'token',
  character: 'character',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function snapshotProvider(value: unknown): CoreUsageSnapshotV1['provider'] | null {
  if (!isRecord(value)) return null;
  const providerTable = asNonEmptyString(value.providerTable);
  const providerId = asNonEmptyString(value.providerId);
  const providerName = typeof value.providerName === 'string' ? value.providerName.trim() : '';
  const providerType = asNonEmptyString(value.providerType);
  const configuredModel = asNonEmptyString(value.configuredModel);
  const requestModel = asNonEmptyString(value.requestModel);
  if (!providerTable || !providerId || !providerType || !configuredModel || !requestModel) return null;
  const provider: CoreUsageSnapshotV1['provider'] = {
    providerTable: providerTable as CoreUsageSnapshotV1['provider']['providerTable'],
    providerId,
    providerName,
    providerType,
    configuredModel,
    requestModel,
  };
  const executionScope = asNonEmptyString(value.executionScope);
  const apiStyle = asNonEmptyString(value.apiStyle);
  const baseUrl = asNonEmptyString(value.baseUrl);
  if (executionScope) provider.executionScope = executionScope as 'company' | 'external';
  if (apiStyle) provider.apiStyle = apiStyle;
  if (baseUrl) provider.baseUrl = baseUrl;
  return provider;
}

/** Parse a versioned snapshot without consulting the current price registry. */
export function parseUsageSnapshot(value: unknown): { ok: true; parsed: ParsedSnapshot } | { ok: false; error: string } {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'usage snapshot is invalid JSON' };
    }
  }
  if (!isRecord(raw)) return { ok: false, error: 'usage snapshot must be an object' };
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: 'usage snapshot schemaVersion is unsupported' };
  }
  const coreModelKey = asNonEmptyString(raw.coreModelKey);
  const pricingVersion = asNonEmptyString(raw.pricingVersion);
  const startedAt = asNonEmptyString(raw.startedAt);
  const refType = typeof raw.refType === 'string' ? raw.refType : '';
  const refId = typeof raw.refId === 'string' ? raw.refId : '';
  const provider = snapshotProvider(raw.provider);
  const components = raw.priceComponents;
  if (!coreModelKey || !pricingVersion || !startedAt || !provider || !Array.isArray(components)) {
    return { ok: false, error: 'usage snapshot is missing required fields' };
  }
  const category = CORE_CATEGORIES[coreModelKey];
  const expectedKeys = coreModelKey === 'company-gpt-5-6-luna' && components.length === 1
    ? ['request'] : COMPONENT_KEYS_BY_CORE_MODEL[coreModelKey];
  if (!category || !expectedKeys || components.length !== expectedKeys.length) {
    return { ok: false, error: 'usage snapshot core model is unsupported' };
  }
  // Re-check the frozen provider identity as a scope gate. The current plan is
  // used only to validate identity/coreModelKey; its prices never replace the
  // prices stored in this historical snapshot.
  const currentPlan = resolveCoreUsagePlan(provider);
  if (!currentPlan || currentPlan.coreModelKey !== coreModelKey) {
    return { ok: false, error: 'usage snapshot provider identity is unsupported' };
  }
  const normalizedComponents: CoreUsagePriceComponentV1[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (!isRecord(component)) return { ok: false, error: 'usage snapshot price component is invalid' };
    const key = asNonEmptyString(component.key);
    const unit = asNonEmptyString(component.unit);
    const unitPriceMicros = component.unitPriceMicros;
    const priceScale = component.priceScale;
    if (
      !key || key !== expectedKeys[index] || !unit || COMPONENT_UNITS_BY_KEY[key] !== unit
      || typeof unitPriceMicros !== 'number' || !Number.isInteger(unitPriceMicros) || unitPriceMicros < 0
      || typeof priceScale !== 'number' || !Number.isInteger(priceScale) || priceScale <= 0
    ) {
      return { ok: false, error: 'usage snapshot price component is invalid' };
    }
    normalizedComponents.push({
      key: key as CoreUsagePriceComponentV1['key'],
      unit: unit as CoreUsagePriceComponentV1['unit'],
      unitPriceMicros,
      priceScale,
    });
  }
  return {
    ok: true,
    parsed: {
      category,
      snapshot: {
        schemaVersion: 1,
        provider,
        coreModelKey,
        pricingVersion,
        priceComponents: normalizedComponents,
        startedAt,
        ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
        refType,
        refId,
      },
    },
  };
}
