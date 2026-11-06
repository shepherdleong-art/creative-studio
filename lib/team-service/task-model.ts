// Frozen execution facts only. Never resolve a provider's current configuration here.
type JsonObject = Record<string, unknown>;

export type TeamModelCall = {
  attemptId: string | null;
  providerName: string;
  model: string | null;
  modelStatus: 'recorded' | 'pending';
  submissionState: string;
  createdAt: string | null;
};

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function parse(value: unknown): JsonObject {
  if (typeof value !== 'string' || !value) return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readProviderModel(snapshot: JsonObject, request?: JsonObject) {
  const usageProvider = parse(snapshot.provider);
  return {
    providerName: text(snapshot.name) ?? text(snapshot.providerName) ?? text(usageProvider.providerName)
      ?? text(snapshot.providerIdentity) ?? text(snapshot.providerId) ?? text(snapshot.id) ?? text(usageProvider.providerId),
    providerId: text(snapshot.providerId) ?? text(snapshot.providerIdentity) ?? text(snapshot.id) ?? text(usageProvider.providerId),
    model: text(request?.model) ?? text(snapshot.requestModel) ?? text(snapshot.modelAlias)
      ?? text(snapshot.model) ?? text(usageProvider.requestModel) ?? text(snapshot.coreModelKey),
  };
}

export function projectModelCall(options: {
  snapshot: unknown;
  inputSnapshot?: unknown;
  pricingSnapshot?: unknown;
  attemptId?: string | null;
  submissionState?: string | null;
  createdAt?: string | null;
  module: string;
  legacyModel?: unknown;
  legacyUsageSnapshot?: unknown;
}): TeamModelCall | null {
  const snapshot = parse(options.snapshot);
  const request = object(parse(options.inputSnapshot).request);
  const pricing = parse(options.pricingSnapshot);
  const legacyUsage = parse(options.legacyUsageSnapshot);
  const fact = readProviderModel(snapshot, request);
  const pricingFact = readProviderModel(pricing);
  const legacyFact = readProviderModel(legacyUsage);
  const model = fact.model ?? pricingFact.model ?? legacyFact.model ?? text(options.legacyModel);
  const hasFrozenDisplayName = Boolean(text(snapshot.name) || text(snapshot.providerName)
    || text(parse(snapshot.provider).providerName));
  const legacyProviderName = hasFrozenDisplayName
    || (fact.providerId !== null && legacyFact.providerId !== fact.providerId) ? undefined : legacyFact.providerName;
  const providerName = legacyProviderName ?? fact.providerName ?? pricingFact.providerName;
  const submitted = options.submissionState !== null && options.submissionState !== undefined && options.submissionState !== 'not_sent';
  if (!model && !providerName && !submitted) return null;
  return {
    attemptId: options.attemptId ?? null,
    providerName: providerName ?? '未记录',
    model,
    modelStatus: model ? submitted ? 'recorded' : 'pending' : 'pending',
    submissionState: options.submissionState ?? 'not_sent',
    createdAt: options.createdAt ?? null,
  };
}

export function summarizeModelCalls(calls: TeamModelCall[], module: string, configured = false): {
  providerName: string; model: string | null; modelStatus: string;
} {
  if (['canvas_export', 'batch', 'final_edit'].includes(module)) {
    return { providerName: '不适用（本地处理）', model: null, modelStatus: 'not_applicable' };
  }
  if (calls.length === 0) return { providerName: '未记录', model: null, modelStatus: 'missing' };
  const models = new Set(calls.map(call => call.model).filter(Boolean));
  const providers = new Set(calls.map(call => call.providerName));
  return {
    providerName: providers.size === 1 ? calls[0].providerName : `${providers.size} 个供应商（见调用记录）`,
    model: models.size === 0 ? null : models.size === 1 ? calls.find(call => call.model)?.model ?? null : `${models.size} 个模型（见调用记录）`,
    modelStatus: calls.some(call => call.modelStatus === 'recorded')
      ? models.size > 1 ? 'multiple' : 'recorded' : calls.some(call => call.model) ? 'pending' : configured ? 'undetermined' : 'missing',
  };
}
