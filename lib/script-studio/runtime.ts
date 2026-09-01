import type Database from 'better-sqlite3';
import { completeJson, getAvailableProviders } from '../script-providers/index.ts';
import { ScriptStudioError } from './errors.ts';
import type { ScriptStudioCompleteJsonRequest } from './llm-contract.ts';
import {
  createScriptGenerator,
  type ScriptGenerator,
} from './generator.ts';
import { createVisionClosedQuestionReprobe, type EvidenceReprobe } from './adapters/reprobe.ts';
import { createVisionExtractor, type VisionExtractor } from './adapters/vision-extract.ts';
import { getScriptStudioLimits } from './limits.ts';
import {
  pinRuntimeProviderModel,
  selectScriptStudioRuntimeProviders,
  type ScriptStudioRuntimeProvider,
} from './provider-selection.ts';
import {
  createScriptStudioRunDeps,
  type ScriptStudioRunDeps,
} from './runner.ts';
import { getTask, type TaskView } from './tasks.ts';

export function resolveRuntimeProviders(requestedProviderId?: string | null): {
  vision: ScriptStudioRuntimeProvider;
  text: ScriptStudioRuntimeProvider;
} {
  return selectScriptStudioRuntimeProviders(getAvailableProviders(), requestedProviderId);
}

function providerCompleteJson(providerId: string, model: string, projectId: string, taskId: string, refType: string) {
  return (input: ScriptStudioCompleteJsonRequest) => completeJson({
    providerId,
    model,
    ...input,
    usageContext: {
      enabled: true,
      projectId,
      refType,
      refId: taskId,
    },
  } as Parameters<typeof completeJson>[0]);
}

export function createRuntimeDeps(
  db: Database.Database,
  task: TaskView,
  options: { signal?: AbortSignal; fallbackOnInvalid?: boolean } = {},
): {
  runDeps: ScriptStudioRunDeps;
  visionExtractor: VisionExtractor;
  reprobe: EvidenceReprobe;
  generator: ScriptGenerator;
} {
  const inputSnapshot = JSON.parse(task.inputSnapshotJson || '{}') as Record<string, unknown>;
  const requestedProviderId = typeof inputSnapshot.providerId === 'string'
    ? inputSnapshot.providerId
    : null;
  // 执行模型以任务快照为准：排队期间供应商配置从模型 A 改为 B，实际调用仍用快照里的 A。
  const providers = pinRuntimeProviderModel(
    resolveRuntimeProviders(requestedProviderId),
    inputSnapshot.providerModel,
  );
  const projectId = task.projectId;
  const taskId = task.id;
  const limits = getScriptStudioLimits();
  const visionExtractor = createVisionExtractor(
    providerCompleteJson(providers.vision.id, providers.vision.model, projectId, taskId, 'script-studio-vision'),
    providers.vision,
    {
      maxTokens: limits.maxTokensPerPage,
      tileBatchSize: limits.extractTileBatchSize,
      concurrency: limits.extractConcurrency,
      requestTimeoutMs: limits.extractRequestTimeoutMs,
      maxAttempts: limits.extractMaxAttempts,
    },
  );
  const reprobe = createVisionClosedQuestionReprobe(
    providerCompleteJson(providers.text.id, providers.text.model, projectId, taskId, 'script-studio-reprobe'),
  );
  const generator = createScriptGenerator(
    providerCompleteJson(providers.text.id, providers.text.model, projectId, taskId, 'script-studio-generate'),
    providers.text,
    { maxTokens: getScriptStudioLimits().maxTokensPerPage },
  );
  const runDeps = createScriptStudioRunDeps(db, {
    projectId,
    taskId,
    sourceSetId: task.sourceSetId,
    libraryRevisionId: task.libraryRevisionId,
    inputSnapshot,
    visionExtractor,
    reprobe,
    generator,
    signal: options.signal,
    fallbackOnInvalid: options.fallbackOnInvalid,
  });
  return { runDeps, visionExtractor, reprobe, generator };
}

export function loadTask(db: Database.Database, projectId: string, taskId: string): TaskView {
  const task = getTask(db, projectId, taskId);
  if (!task) throw new ScriptStudioError('not_found', '任务不存在或不属于当前项目');
  return task;
}
