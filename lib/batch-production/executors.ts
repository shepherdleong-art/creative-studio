import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import {
  assertProviderExecutionAvailable,
  assertProviderExecutionIdentityStable,
  ProviderExecutionGateError,
  readManagedExecutionGeneration,
  type ProviderExecutionIdentity,
  type AssertProviderExecutionAvailableOptions,
} from '../provider-execution-gate.ts';
import { isManagedDeployment } from '../managed-deployment.ts';
import { createAnalysisVersionAndSetCurrent } from './assets.ts';
import {
  assertProjectAssetFileIdentity,
  projectAssetMimeType,
  resolveVerifiedProjectAssetMedia,
} from './project-asset-media.ts';
import {
  withPreparedMediaLease,
  type MediaTransport,
  type PreparedMediaLease,
} from '../media-transport.ts';
import { isConfiguredScriptProviderValue } from '../script-providers/config.ts';
import type { BatchTaskWorkType, ClaimedBatchTask } from './tasks.ts';

/**
 * 统一进度报告。不可测的阶段 percent 必须为 null,不允许伪造
 * “看起来在动”的假数字(供应商只返回处理中时显示阶段与等待)。
 */
export interface BatchTaskProgress {
  phase: string;
  description?: string;
  completed?: number;
  total?: number;
  /** 0–1;不可测时为 null */
  percent?: number | null;
}

export interface BatchTaskExecutionContext {
  db: Database.Database;
  claim: ClaimedBatchTask;
  signal: AbortSignal;
  /** Optional execution seams propagated by the scheduler for managed runs. */
  executionGate?: Omit<AssertProviderExecutionAvailableOptions, 'capability'>;
  mediaTransport?: MediaTransport;
  /** 报告当前阶段与真实进度(调度器负责节流落库) */
  reportProgress(progress: BatchTaskProgress): void;
}

export interface BatchTaskExecutor {
  /** 该执行器接受的任务种类 */
  workTypes: BatchTaskWorkType[];
  execute(context: BatchTaskExecutionContext): Promise<{
    resultJson?: unknown;
    /** 成功执行后若调度器拒绝迟到结果，用于删除本次未被接受的候选。 */
    discard?: () => Promise<void> | void;
    /**
     * 仅做同步数据库发布；runner 会在同一个 IMMEDIATE 事务中先复核租约、
     * 任务/批次控制态，再调用它并落成功状态，避免取消后的迟到发布。
     */
    commit?: () => {
      resultJson?: unknown;
      discard?: () => Promise<void> | void;
      progress?: BatchTaskProgress;
    };
  }>;
}

export interface BatchContentAnalysisResult {
  summary: string;
  sellingPoints: string[];
  semanticTags: string[];
  usableRanges: Array<{ startUs: number; endUs: number; qualityScore: number }>;
  qualityIssues: string[];
  coverFrameTimesUs: number[];
  scenes: Array<{
    startUs: number;
    endUs: number;
    description: string;
    labels: string[];
    qualityScore: number;
  }>;
}

export interface AnalyzeAssetExecutorOptions {
  analyzeContent?: (input: {
    filePath: string;
    assetId: string;
    providerId: string;
    model: string;
    cacheDir: string;
    signal: AbortSignal;
    mediaLease?: PreparedMediaLease;
  }) => Promise<BatchContentAnalysisResult>;
  assertProviderReady?: (
    provider: ProviderExecutionIdentity,
    options: AssertProviderExecutionAvailableOptions,
  ) => Promise<void>;
  mediaTransport?: MediaTransport;
  executionGate?: Omit<AssertProviderExecutionAvailableOptions, 'capability'>;
}

interface ScriptProviderDbRow {
  id: string;
  enabled: number;
  supportsVision: number;
  type?: string;
  apiStyle?: string;
  baseUrl: string;
  defaultBaseUrl?: string;
  apiKey: string;
  keyEnv?: string;
  model: string;
  defaultModel?: string;
  maxTokens?: number;
  visionCostPerRequest?: number;
  executionScope: 'external' | 'company';
}

function scriptProviderIdentity(
  provider: ScriptProviderDbRow,
  request: { providerId: string; model: string; executionScope: 'external' | 'company' },
  options: { env?: NodeJS.ProcessEnv; root?: string } = {},
): ProviderExecutionIdentity {
  const baseUrl = provider.baseUrl || provider.defaultBaseUrl || '';
  const model = provider.model || provider.defaultModel || '';
  const type = provider.type || provider.apiStyle || 'openai-compatible';
  const apiStyle = provider.apiStyle || type;
  const keyEnv = provider.keyEnv || '';
  const managed = isManagedDeployment(options.env ?? process.env);
  return {
    id: request.providerId,
    type,
    apiStyle,
    executionScope: provider.executionScope,
    baseUrl,
    apiKeyEnv: keyEnv,
    keyEnv,
    apiKey: provider.apiKey.trim(),
    model,
    enabled: provider.enabled === 1,
    configured: isConfiguredScriptProviderValue(baseUrl)
      && isConfiguredScriptProviderValue(provider.apiKey)
      && isConfiguredScriptProviderValue(model),
    configSignature: [
      type,
      apiStyle,
      keyEnv,
      provider.defaultBaseUrl,
      provider.defaultModel,
      provider.maxTokens,
      provider.enabled,
      provider.supportsVision,
      provider.visionCostPerRequest,
      provider.executionScope,
    ].map((value) => String(value ?? '')).join('\u0000'),
    managedGeneration: managed ? readManagedExecutionGeneration(options.root ?? dataRoot()) : undefined,
  };
}

function assertCompanyMediaTransportAvailable(
  provider: ProviderExecutionIdentity,
  available: boolean,
): void {
  if (provider.executionScope === 'company' && !available) {
    throw new ProviderExecutionGateError(
      'transport_unavailable',
      'transport_unavailable',
      provider.executionScope,
    );
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('任务已中止');
  }
}

/**
 * 素材分析执行器(asset_prepare):用 ffprobe 探测素材媒体属性,
 * 写入素材分析版本并更新素材当前分析指向。
 * 分析来源是 ffprobe,版本号固定,失败可重试。
 */
export function createAnalyzeAssetExecutor(options: AnalyzeAssetExecutorOptions = {}): BatchTaskExecutor {
  const analyzeContent = options.analyzeContent ?? (async (input) => {
    const { analyzeVideoWithVision } = await import('../final-edit/adapters/video-analysis.ts');
    return analyzeVideoWithVision({
      filePath: input.filePath,
      videoJobId: input.assetId,
      providerId: input.providerId,
      cacheDir: input.cacheDir,
      signal: input.signal,
    });
  });
  const assertProviderReady = options.assertProviderReady ?? assertProviderExecutionAvailable;
  const mediaTransport = options.mediaTransport;
  return {
    workTypes: ['asset_prepare'],
    async execute(context) {
    const { db, claim, signal } = context;
    const executionGate = options.executionGate ?? context.executionGate;
    const activeMediaTransport = mediaTransport ?? context.mediaTransport;
    if (claim.task.targetKind !== 'asset') {
      throw new Error('素材分析任务的目标必须是素材');
    }
    context.reportProgress({ phase: 'locating', description: '定位素材来源', percent: null });
    assertNotAborted(signal);
    const projectId = (db.prepare(`
      SELECT projectId FROM batch_assets WHERE id = ?
    `).get(claim.task.targetId) as { projectId: string } | undefined)?.projectId;
    if (!projectId) throw new Error('素材不存在');
    const contentRequest = db.prepare(`
      SELECT projectId, batchId, assetId, contentFingerprint, providerId, model, executionScope, analysisMode
      FROM batch_asset_analysis_requests WHERE taskId = ?
    `).get(claim.task.id) as {
      projectId: string;
      batchId: string;
      assetId: string;
      contentFingerprint: string;
      providerId: string;
      model: string;
      executionScope: 'external' | 'company';
      analysisMode: 'content';
    } | undefined;
    if (contentRequest && (
      contentRequest.projectId !== projectId
      || contentRequest.batchId !== claim.task.batchId
      || contentRequest.assetId !== claim.task.targetId
      || contentRequest.analysisMode !== 'content'
    )) throw new Error('内容分析请求谱系无效');
    context.reportProgress({ phase: 'probing', description: '探测媒体属性', percent: null });
    assertNotAborted(signal);
    const verified = await resolveVerifiedProjectAssetMedia(db, projectId, claim.task.targetId);
    // 完整指纹与 FFprobe 本身是不可中断的本地 I/O；在其返回后重新检查
    // 任务信号，避免取消后的迟到分析版本继续发布。
    assertNotAborted(signal);
    const probe = verified.media;
    if (contentRequest && contentRequest.contentFingerprint !== verified.asset.contentFingerprint) {
      throw new Error('素材内容已变化，请重新发起内容分析');
    }
    let contentAnalysis: BatchContentAnalysisResult | null = null;
    if (contentRequest) {
      const provider = db.prepare(`
        SELECT * FROM script_providers WHERE id = ?
      `).get(contentRequest.providerId) as ScriptProviderDbRow | undefined;
      if (!provider || provider.enabled !== 1 || provider.supportsVision !== 1) {
        throw new Error('视觉分析供应商已停用或不支持图片理解');
      }
      const currentModel = provider.model || provider.defaultModel || '';
      if (currentModel !== contentRequest.model) {
        throw new Error('视觉分析模型配置已变化，请重新发起内容分析');
      }
      if (provider.executionScope !== contentRequest.executionScope) {
        throw new Error('视觉分析供应商运行方式已变化，请重新发起内容分析');
      }
      const providerIdentity = scriptProviderIdentity(provider, contentRequest, {
        env: executionGate?.env,
        root: executionGate?.root,
      });
      await assertProviderReady(providerIdentity, {
        ...executionGate,
        root: executionGate?.root ?? dataRoot(),
        capability: 'media',
        mediaTransportAvailable: Boolean(activeMediaTransport),
        kind: 'script',
      });
      assertCompanyMediaTransportAvailable(providerIdentity, Boolean(activeMediaTransport));
      const assertContentExecutionStable = async (): Promise<void> => {
        const currentRow = db.prepare(`SELECT * FROM script_providers WHERE id = ?`).get(contentRequest.providerId) as ScriptProviderDbRow | undefined;
        if (!currentRow || currentRow.enabled !== 1 || currentRow.supportsVision !== 1) {
          throw new Error('content_provider_unavailable');
        }
        const currentModel = currentRow.model || currentRow.defaultModel || '';
        if (currentModel !== contentRequest.model || currentRow.executionScope !== contentRequest.executionScope) {
          throw new Error('content_provider_identity_changed');
        }
        const currentIdentity = scriptProviderIdentity(currentRow, contentRequest, {
          env: executionGate?.env,
          root: executionGate?.root,
        });
        if (isManagedDeployment(executionGate?.env ?? process.env)) {
          assertProviderExecutionIdentityStable(providerIdentity, currentIdentity);
        }
        await assertProviderReady(currentIdentity, {
          ...executionGate,
          root: executionGate?.root ?? dataRoot(),
          capability: 'media',
          mediaTransportAvailable: Boolean(activeMediaTransport),
          kind: 'script',
        });
        assertCompanyMediaTransportAvailable(currentIdentity, Boolean(activeMediaTransport));
        if (isManagedDeployment(executionGate?.env ?? process.env)) {
          const finalRow = db.prepare(`SELECT * FROM script_providers WHERE id = ?`).get(contentRequest.providerId) as ScriptProviderDbRow | undefined;
          if (!finalRow) throw new Error('content_provider_unavailable');
          assertProviderExecutionIdentityStable(
            currentIdentity,
            scriptProviderIdentity(finalRow, contentRequest, {
              env: executionGate?.env,
              root: executionGate?.root,
            }),
          );
        }
      };
      context.reportProgress({ phase: 'content_analyzing', description: '抽帧并进行画面内容分析', percent: null });
      const analyze = async (mediaLease?: PreparedMediaLease): Promise<BatchContentAnalysisResult> => {
        // Re-read provider identity after prepare and immediately before the
        // adapter call; this closes the provisioning/DB TOCTOU window.
        await assertContentExecutionStable();
        return analyzeContent({
          filePath: verified.filePath,
          assetId: claim.task.targetId,
          providerId: contentRequest.providerId,
          model: contentRequest.model,
          cacheDir: path.join(dataRoot(), 'storage', 'batch-analysis', claim.task.targetId, claim.task.id),
          signal,
          mediaLease,
        });
      };
      contentAnalysis = contentRequest.executionScope === 'company'
        ? await withPreparedMediaLease(activeMediaTransport!, {
            projectId,
            batchId: claim.task.batchId,
            taskId: claim.task.id,
            attemptId: claim.attempt.id,
            assetId: claim.task.targetId,
            mediaKind: verified.asset.mediaKind,
            absolutePath: verified.filePath,
            contentFingerprint: verified.asset.contentFingerprint,
            mimeType: projectAssetMimeType(verified.filePath),
            sizeBytes: verified.fileIdentity.size,
          }, analyze, { signal })
        : await analyze();
      assertNotAborted(signal);
    }
    context.reportProgress({ phase: 'verified', description: '媒体核验完成，正在发布', percent: null });
    return {
      commit: () => {
        assertNotAborted(signal);
        const assetState = db.prepare(`
          SELECT status FROM batch_assets WHERE id = ? AND projectId = ?
        `).get(claim.task.targetId, projectId) as { status: string } | undefined;
        if (assetState?.status !== 'online') {
          throw new Error('素材已离线或归档,不能发布分析结果');
        }
        assertProjectAssetFileIdentity(verified.filePath, verified.fileIdentity);
        // 分析版本、current 指针与任务成功由 runner 的同一事务发布。
        const analysisId = createAnalysisVersionAndSetCurrent(db, {
          assetId: claim.task.targetId,
          analyzerVersion: contentRequest ? 'batch-content-analysis-v1' : 'batch-analysis-v1',
          providerId: contentRequest?.providerId ?? 'ffprobe',
          model: contentRequest?.model ?? 'ffprobe',
          analysisJson: contentRequest && contentAnalysis
            ? {
                analysisLevel: 'content',
                analyzer: 'vision',
                durationUs: probe.durationUs,
                width: probe.width,
                height: probe.height,
                ...contentAnalysis,
              }
            : {
                analysisLevel: 'technical',
                analyzer: 'ffprobe',
                durationUs: probe.durationUs,
                width: probe.width,
                height: probe.height,
              },
          now: () => new Date(),
        });
        return {
          resultJson: { analysisId, analysisLevel: contentRequest ? 'content' : 'technical' },
          progress: {
            phase: 'analyzed',
            description: contentRequest ? '内容分析完成' : '基础分析完成',
            percent: 1,
          },
        };
      },
    };
    },
  };
}

export const analyzeAssetExecutor = createAnalyzeAssetExecutor();

/** 按任务种类选择执行器;没有注册执行器的任务种类返回 null。 */
export function findExecutor(
  executors: BatchTaskExecutor[],
  workType: BatchTaskWorkType,
): BatchTaskExecutor | undefined {
  return executors.find((executor) => executor.workTypes.includes(workType));
}
