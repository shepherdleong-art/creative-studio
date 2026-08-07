import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { probeVideoMedia } from '../ffmpeg';
import { completeJson, estimateVisionAnalysisCost, getAvailableProviders } from '../script-providers';
import { isManagedDeployment } from '../managed-deployment';
import { filterManagedProviders, loadManagedProviderAllowlist } from '../managed-provider-policy';
import {
  assertProviderExecutionAvailable,
  assertProviderExecutionIdentityStable,
  ProviderExecutionGateError,
  readManagedExecutionGeneration,
  type ProviderExecutionIdentity,
  type AssertProviderExecutionAvailableOptions,
} from '../provider-execution-gate';
import { fitNarrationTextToDuration } from '../script-generation-v3';
import { createFinalEditWorkspace, type FinalEditWorkspaceRuntime } from './workspace';
import { analyzeVideoWithVision } from './adapters/video-analysis';
import { createOpenAiAlignmentAdapter, type AlignmentAdapter } from './adapters/alignment';
import { getFinalEditTtsAdapter, listFinalEditTtsAdapters } from './adapters/tts-registry';
import { warmPreparePreview } from './prepare-preview';
import { detectBeatPoints } from './beat-detect';
import { writeLog } from '../logger';

let workspace: FinalEditWorkspaceRuntime | null = null;
let prepareRecoveryStarted = false;
const runtimeStartedAt = new Date().toISOString();

type AlignmentFallbackProvider = {
  id: string;
  baseUrl: string;
  apiKey: string;
  keyEnv: string;
};

function resolveProviderApiKey(provider?: Pick<AlignmentFallbackProvider, 'apiKey' | 'keyEnv'>): string {
  return provider?.apiKey.trim() || (provider?.keyEnv ? (process.env[provider.keyEnv] || '').trim() : '');
}


type FinalEditProviderExecutionOptions = Pick<
  AssertProviderExecutionAvailableOptions,
  'root' | 'inspectRuntime' | 'companyRuntime' | 'allowlist' | 'env'
>;

type FinalEditTtsProviderRow = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  keyEnv: string;
  model: string;
  enabled: number;
  isBuiltin: number;
  costPerThousandCharacters?: number;
};

type FinalEditScriptProviderRow = {
  id: string;
  name: string;
  type: string;
  apiStyle: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  keyEnv: string;
  baseUrlEnv: string;
  modelEnv: string;
  defaultBaseUrl: string;
  defaultModel: string;
  maxTokens: number;
  enabled: number;
  supportsVision: number;
  visionCostPerRequest: number;
  executionScope: string;
};

function executionApiKey(apiKey: string, keyEnv: string, env: NodeJS.ProcessEnv = process.env): string {
  return apiKey.trim() || (keyEnv ? String(env[keyEnv] || '').trim() : '');
}

function managedGeneration(options: FinalEditProviderExecutionOptions): string | null | undefined {
  return isManagedDeployment(options.env ?? process.env)
    ? readManagedExecutionGeneration(options.root)
    : undefined;
}

function ttsIdentity(row: FinalEditTtsProviderRow, options: FinalEditProviderExecutionOptions): ProviderExecutionIdentity {
  const apiKey = executionApiKey(row.apiKey, row.keyEnv, options.env);
  return {
    id: row.id,
    executionScope: 'external',
    type: row.type,
    baseUrl: row.baseUrl,
    keyEnv: row.keyEnv,
    apiKey,
    model: row.model,
    enabled: Boolean(row.enabled),
    configured: Boolean(row.enabled && apiKey && row.baseUrl.trim() && row.model.trim()),
    configSignature: [row.name, row.type, row.keyEnv, row.model, row.isBuiltin, row.costPerThousandCharacters ?? ''].map(String).join('\u0000'),
    managedGeneration: managedGeneration(options),
  };
}

function scriptIdentity(row: FinalEditScriptProviderRow, options: FinalEditProviderExecutionOptions): ProviderExecutionIdentity {
  const apiKey = executionApiKey(row.apiKey, row.keyEnv, options.env);
  return {
    id: row.id,
    executionScope: row.executionScope === 'company' ? 'company' : 'external',
    type: row.type,
    apiStyle: row.apiStyle,
    baseUrl: row.baseUrl,
    apiKeyEnv: row.keyEnv,
    keyEnv: row.keyEnv,
    apiKey,
    model: row.model,
    enabled: Boolean(row.enabled),
    configured: Boolean(row.enabled && apiKey && row.baseUrl.trim() && row.model.trim()),
    configSignature: [row.name, row.type, row.apiStyle, row.keyEnv, row.baseUrlEnv, row.modelEnv, row.defaultBaseUrl, row.defaultModel, row.maxTokens, row.supportsVision, row.visionCostPerRequest, row.executionScope].map(String).join('\u0000'),
    managedGeneration: managedGeneration(options),
  };
}

function missingProviderError(scope: 'external' | 'company'): ProviderExecutionGateError {
  return new ProviderExecutionGateError('provider_unconfigured', '供应商不存在或未启用', scope);
}

function readTtsProvider(db: Database.Database, providerId: string): FinalEditTtsProviderRow | undefined {
  return db.prepare(`SELECT id, name, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, costPerThousandCharacters FROM final_edit_tts_providers WHERE id=?`).get(providerId) as FinalEditTtsProviderRow | undefined;
}

/**
 * Gate a final-edit TTS run and return only the immutable, post-gate provider
 * snapshot used by the adapter. The row is deliberately read again after the
 * first gate so a same-id key/route/model rotation cannot cross the boundary.
 */
export async function assertFinalEditTtsExecutionAvailable(
  providerId: string,
  options: FinalEditProviderExecutionOptions & { db?: Database.Database } = {},
): Promise<{ provider: { baseUrl: string; apiKey: string; model: string }; identity: ProviderExecutionIdentity }> {
  const db = options.db ?? getDb();
  const managed = isManagedDeployment(options.env ?? process.env);
  const firstRow = readTtsProvider(db, providerId);
  if (!firstRow) throw missingProviderError('external');
  const firstIdentity = ttsIdentity(firstRow, options);
  await assertProviderExecutionAvailable(firstIdentity, {
    ...options,
    capability: 'media',
    kind: 'tts',
    mediaTransportAvailable: true,
  });
  if (!managed) {
    const apiKey = executionApiKey(firstRow.apiKey, firstRow.keyEnv, options.env);
    return {
      provider: { baseUrl: firstRow.baseUrl, apiKey, model: firstRow.model },
      identity: firstIdentity,
    };
  }
  const currentRow = readTtsProvider(db, providerId);
  if (!currentRow) throw missingProviderError(firstIdentity.executionScope);
  const currentIdentity = ttsIdentity(currentRow, options);
  assertProviderExecutionIdentityStable(firstIdentity, currentIdentity);
  await assertProviderExecutionAvailable(currentIdentity, {
    ...options,
    capability: 'media',
    kind: 'tts',
    mediaTransportAvailable: true,
  });
  const finalRow = readTtsProvider(db, providerId);
  if (!finalRow) throw missingProviderError(currentIdentity.executionScope);
  const finalIdentity = ttsIdentity(finalRow, options);
  assertProviderExecutionIdentityStable(currentIdentity, finalIdentity);
  const apiKey = executionApiKey(finalRow.apiKey, finalRow.keyEnv, options.env);
  return {
    provider: { baseUrl: finalRow.baseUrl, apiKey, model: finalRow.model },
    identity: finalIdentity,
  };
}
export async function assertFinalEditRenderExecutionAvailable(
  db: Database.Database,
  groupId: string,
  options: FinalEditProviderExecutionOptions = {},
): Promise<void> {
  const row = db.prepare(`SELECT narrationConfigJson FROM final_edit_groups WHERE id=?`).get(groupId) as { narrationConfigJson: string } | undefined;
  let providerId = '';
  if (row?.narrationConfigJson) {
    try {
      const parsed = JSON.parse(row.narrationConfigJson) as { providerId?: unknown };
      providerId = String(parsed.providerId || '').trim();
    } catch {
      providerId = '';
    }
  }
  if (!providerId) {
    if (!isManagedDeployment(options.env ?? process.env)) return;
    providerId = 'doubao-seed-tts-2';
  }
  await assertFinalEditTtsExecutionAvailable(providerId, { ...options, db });
}
function readScriptProvider(db: Database.Database, providerId: string): FinalEditScriptProviderRow | undefined {
  return db.prepare(`SELECT id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv, defaultBaseUrl, defaultModel, maxTokens, enabled, supportsVision, visionCostPerRequest, executionScope FROM script_providers WHERE id=?`).get(providerId) as FinalEditScriptProviderRow | undefined;
}

/**
 * Visual analysis has no task-level MediaTransport. In managed mode this
 * intentionally fails closed before FFmpeg/network work; unrestricted mode
 * keeps the existing direct-provider behavior.
 */
export async function assertFinalEditAnalysisExecutionAvailable(
  providerId: string,
  options: FinalEditProviderExecutionOptions & { db?: Database.Database } = {},
): Promise<ProviderExecutionIdentity> {
  const db = options.db ?? getDb();
  const managed = isManagedDeployment(options.env ?? process.env);
  const firstRow = readScriptProvider(db, providerId);
  if (!firstRow) throw missingProviderError('company');
  const firstIdentity = scriptIdentity(firstRow, options);
  await assertProviderExecutionAvailable(firstIdentity, {
    ...options,
    capability: 'media',
    kind: 'script',
    mediaTransportAvailable: false,
  });
  if (!managed) return firstIdentity;
  const currentRow = readScriptProvider(db, providerId);
  if (!currentRow) throw missingProviderError(firstIdentity.executionScope);
  const currentIdentity = scriptIdentity(currentRow, options);
  assertProviderExecutionIdentityStable(firstIdentity, currentIdentity);
  await assertProviderExecutionAvailable(currentIdentity, {
    ...options,
    capability: 'media',
    kind: 'script',
    mediaTransportAvailable: false,
  });
  return currentIdentity;
}
function createFinalEditAlignmentAdapter(provider?: AlignmentFallbackProvider): AlignmentAdapter {
  const alignmentModel = provider
    ? listFinalEditTtsAdapters().find((adapter) => adapter.id === provider.id)?.alignmentModel
    : undefined;
  const fallback = provider && alignmentModel
    ? { baseUrl: provider.baseUrl, apiKey: resolveProviderApiKey(provider), model: alignmentModel }
    : undefined;
  return createOpenAiAlignmentAdapter(process.env, fallback);
}

export function getFinalEditWorkspace(): FinalEditWorkspaceRuntime {
  if (workspace) return workspace;
  const db = getDb();
  const storageRoot = path.join(dataRoot(), 'storage');
  workspace = createFinalEditWorkspace({
    db,
    storageRoot,
    probeVideo: async ({ filePath }) => probeVideoMedia(filePath),
    analyzeVideo: async ({ filePath, videoJobId, providerId }) => {
      const provider = getAvailableProviders().find((item) => item.id === providerId && item.configured && item.supportsVision);
      if (!provider) throw new Error('没有已启用并支持图片理解的视觉分析供应商');
      await assertFinalEditAnalysisExecutionAvailable(provider.id);
      return analyzeVideoWithVision({ filePath, videoJobId, providerId: provider.id, cacheDir: path.join(storageRoot, 'final-edits', 'analysis', videoJobId) });
    },
    scoreSemanticMatrix: (input) => completeJson({
      providerId: input.providerId,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    }),
    fitNarrationDuration: ({ providerId, script, actualNarrationUs, targetNarrationUs }) => fitNarrationTextToDuration({
      script,
      actualNarrationUs,
      targetNarrationUs,
    }, {
      completeJson: (request) => completeJson({ providerId, ...request }),
    }),
    log: (input) => writeLog(input),
    detectBeatPoints,
    validateTtsProvider: (providerId) => {
      const provider = readTtsProvider(db, providerId);
      if (!provider || !provider.enabled) return false;
      if (isManagedDeployment()) {
        if (!filterManagedProviders('tts', [provider], loadManagedProviderAllowlist())[0]) return false;
      }
      return Boolean(executionApiKey(provider.apiKey, provider.keyEnv));
    },
    validateAnalysisProvider: (providerId) => getAvailableProviders().some((provider) => provider.id === providerId && provider.configured && provider.supportsVision),
    estimateAnalysisCost: ({ providerId, requestCount }) => estimateVisionAnalysisCost(providerId, requestCount),
    synthesize: async ({ segments, providerId, voice, speed, narrationHash, onSegmentComplete }) => {
      const authorized = await assertFinalEditTtsExecutionAvailable(providerId, { db });
      const adapter = getFinalEditTtsAdapter(providerId);
      const alignment = createFinalEditAlignmentAdapter({ id: providerId, ...authorized.provider, keyEnv: authorized.identity.keyEnv || '' });
      const relativeOutputPath = path.join('final-edits', 'narration', narrationHash, 'narration.wav');
      return adapter.synthesize({
        provider: authorized.provider,
        voice, speed, segments,
        outputDir: path.join(storageRoot, 'final-edits', 'narration', narrationHash),
        relativeOutputPath,
        alignment,
        onSegmentComplete,
      });
    },
    warmPreview: ({ variant, sources, narrationAbsolutePath, relativePath }) => warmPreparePreview({ storageRoot, variant, sources, narrationAbsolutePath, relativePath }),
  });
  return workspace;
}

export function recoverFinalEditPrepareJobs() {
  if (prepareRecoveryStarted) return;
  prepareRecoveryStarted = true;
  const db = getDb();
  db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='analyzing', progress=0, startedAt=NULL WHERE kind='prepare' AND status='running' AND (startedAt IS NULL OR startedAt < ?)`).run(runtimeStartedAt);
  const jobs = db.prepare(`SELECT id FROM final_edit_jobs WHERE kind='prepare' AND status='queued' ORDER BY createdAt`).all() as Array<{ id: string }>;
  const activeWorkspace = getFinalEditWorkspace();
  for (const job of jobs) void activeWorkspace.resumePrepareJob(job.id);
}

export function isFinalEditAlignmentConfigured(): boolean {
  const managed = isManagedDeployment();
  const rows = getDb().prepare(`SELECT id, type, baseUrl, apiKey, keyEnv, model, enabled, isBuiltin, name FROM final_edit_tts_providers WHERE enabled=1 ORDER BY isBuiltin DESC, name`).all() as Array<FinalEditTtsProviderRow>;
  const provider = managed
    ? filterManagedProviders('tts', rows, loadManagedProviderAllowlist())[0]
    : rows[0];
  if (!provider) return false;
  const apiKey = executionApiKey(provider.apiKey, provider.keyEnv);
  if (managed && !apiKey) return false;
  if (getFinalEditTtsAdapter(provider.id).providesWordTimings) return true;
  return createFinalEditAlignmentAdapter({ id: provider.id, baseUrl: provider.baseUrl, apiKey, keyEnv: provider.keyEnv }).configured;
}
