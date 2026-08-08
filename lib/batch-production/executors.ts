import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import {
  assertProviderExecutionAvailable,
  type ProviderExecutionIdentity,
  type AssertProviderExecutionAvailableOptions,
} from '../provider-execution-gate.ts';
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
import { isCosMediaConfigured } from '../cos-media.ts';
import { isConfiguredScriptProviderValue } from '../script-providers/config.ts';
import {
  buildBatchScenes,
  buildBatchSentences,
  batchSemanticPoolKey,
  batchSemanticScriptKey,
  persistBatchSemanticMatrix,
  readBatchSemanticMatrix,
  resolveBatchSemanticProvider,
  scoreBatchSemanticMatrix,
  type BatchSemanticPoolRow,
  type BatchSemanticProviderMetaLike,
} from './semantic-match.ts';
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
  /** 任务以成功收场但实际跳过执行时给出机器可读原因(如 no-content-analysis) */
  skipped?: string;
}

export interface BatchTaskExecutionContext {
  db: Database.Database;
  claim: ClaimedBatchTask;
  signal: AbortSignal;
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
    const { analyzeVideoWithVision } = await import('../media-core/adapters/video-analysis.ts');
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
        SELECT enabled, supportsVision,
               COALESCE(NULLIF(baseUrl, ''), NULLIF(defaultBaseUrl, ''), '') AS baseUrl,
               apiKey, executionScope,
               COALESCE(NULLIF(model, ''), NULLIF(defaultModel, ''), '') AS model
        FROM script_providers WHERE id = ?
      `).get(contentRequest.providerId) as {
        enabled: number;
        supportsVision: number;
        baseUrl: string;
        apiKey: string;
        executionScope: 'external' | 'company';
        model: string;
      } | undefined;
      if (!provider || provider.enabled !== 1 || provider.supportsVision !== 1) {
        throw new Error('视觉分析供应商已停用或不支持图片理解');
      }
      if (provider.model !== contentRequest.model) {
        throw new Error('视觉分析模型配置已变化，请重新发起内容分析');
      }
      if (provider.executionScope !== contentRequest.executionScope) {
        throw new Error('视觉分析供应商运行方式已变化，请重新发起内容分析');
      }
      await assertProviderReady({
        id: contentRequest.providerId,
        executionScope: contentRequest.executionScope,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled === 1,
        configured: isConfiguredScriptProviderValue(provider.baseUrl)
          && isConfiguredScriptProviderValue(provider.apiKey)
          && isConfiguredScriptProviderValue(provider.model),
      }, {
        root: dataRoot(),
        capability: 'media',
        // 优先显式注入的任务级 MediaTransport；未注入时默认 analyzeContent 会把
        // 抽帧图片交给 completeJson 的 COS 受控传输，因此 COS 已配置同样满足 media 能力。
        mediaTransportAvailable: Boolean(mediaTransport) || isCosMediaConfigured(),
      });
      context.reportProgress({ phase: 'content_analyzing', description: '抽帧并进行画面内容分析', percent: null });
      const analyze = (mediaLease?: PreparedMediaLease) => analyzeContent({
        filePath: verified.filePath,
        assetId: claim.task.targetId,
        providerId: contentRequest.providerId,
        model: contentRequest.model,
        cacheDir: path.join(dataRoot(), 'storage', 'batch-analysis', claim.task.targetId, claim.task.id),
        signal,
        mediaLease,
      });
      contentAnalysis = contentRequest.executionScope === 'company' && mediaTransport
        ? await withPreparedMediaLease(mediaTransport, {
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

/** 带机器可读 code 的执行器错误;runner 落账时优先采用 code 作为 errorCode。 */
export class BatchExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchExecutorError';
    this.code = code;
  }
}

export interface SemanticScoreExecutorOptions {
  /** 测试注入;默认真实 LLM 打分(completeJson)。 */
  scoreBatch?: typeof scoreBatchSemanticMatrix;
  /** 测试注入;默认 getAvailableProviders()。 */
  listProviders?: () => BatchSemanticProviderMetaLike[];
}

/**
 * 语义匹配执行器(semantic_score):对一份脚本快照做 句段 × 素材池场景
 * 的 LLM 语义矩阵打分,结果按内容指纹(scriptKey + poolKey)落库,
 * 分配装配(buildFrozenInput)同步读出挂到每个 segment 上。
 * 无内容分析场景 → 成功跳过;矩阵已存在 → 幂等复用;
 * 打分 fallback → failed(errorCode semantic_fallback,可经现有 retry API 重试),不落库。
 */
export function createSemanticScoreExecutor(options: SemanticScoreExecutorOptions = {}): BatchTaskExecutor {
  const scoreBatch = options.scoreBatch ?? scoreBatchSemanticMatrix;
  return {
    workTypes: ['semantic_score'],
    async execute(context) {
      const { db, claim, signal } = context;
      if (claim.task.targetKind !== 'script_snapshot') throw new Error('语义匹配任务的目标必须是脚本快照');
      const snapshot = db.prepare(`
        SELECT s.id, s.batchVersionId, s.bodyText
        FROM batch_script_snapshots s
        JOIN batch_production_versions v ON v.id = s.batchVersionId
        WHERE s.id = ? AND v.batchId = ?
      `).get(claim.task.targetId, claim.task.batchId) as {
        id: string;
        batchVersionId: string;
        bodyText: string;
      } | undefined;
      if (!snapshot) throw new Error('语义匹配任务的目标脚本快照不存在');
      const projectId = (db.prepare(`
        SELECT projectId FROM batch_productions WHERE id = ?
      `).get(claim.task.batchId) as { projectId: string } | undefined)?.projectId;
      if (!projectId) throw new Error('语义匹配任务的批次不存在');
      assertNotAborted(signal);
      context.reportProgress({ phase: 'locating', description: '读取冻结脚本与素材池场景', percent: null });
      const sentences = buildBatchSentences(snapshot.bodyText);
      // SQL 与 allocation-store.buildFrozenInput 的素材池读取保持一致;
      // 只取语义场景构造所需的三列。
      const poolRows = db.prepare(`
        SELECT pool.assetId, assets.contentFingerprint, analysis.analysisJson
        FROM batch_asset_pool_items pool
        JOIN batch_assets assets ON assets.id = pool.assetId
        JOIN batch_asset_analysis analysis ON analysis.id = pool.analysisId
        WHERE pool.batchVersionId = ?
        ORDER BY pool.createdAt, pool.id
      `).all(snapshot.batchVersionId) as BatchSemanticPoolRow[];
      const scenes = buildBatchScenes(poolRows);
      if (!scenes.length) {
        return {
          resultJson: { scriptSnapshotId: snapshot.id, skipped: 'no-content-analysis' },
          commit: () => ({
            resultJson: { scriptSnapshotId: snapshot.id, skipped: 'no-content-analysis' },
            progress: {
              phase: 'semantic_score',
              description: '素材池没有内容分析场景，跳过语义匹配（分配将使用关键词兜底）',
              percent: 1,
              skipped: 'no-content-analysis',
            },
          }),
        };
      }
      const scriptKey = batchSemanticScriptKey(sentences);
      const poolKey = batchSemanticPoolKey(scenes);
      if (readBatchSemanticMatrix(db, projectId, scriptKey, poolKey)) {
        return {
          resultJson: { scriptSnapshotId: snapshot.id, scriptKey, poolKey, reused: true },
          commit: () => ({
            resultJson: { scriptSnapshotId: snapshot.id, scriptKey, poolKey, reused: true },
            progress: { phase: 'semantic_score', description: '语义矩阵已存在，直接复用', percent: 1 },
          }),
        };
      }
      const provider = await resolveBatchSemanticProvider(db, {
        batchVersionId: snapshot.batchVersionId,
        listProviders: options.listProviders,
      });
      if (!provider) {
        throw new BatchExecutorError('no_provider', '没有可用的脚本供应商，无法进行语义匹配打分');
      }
      context.reportProgress({
        phase: 'semantic_score',
        description: `语义矩阵打分（${sentences.length} 句 × ${scenes.length} 场景）`,
        percent: null,
      });
      const outcome = await scoreBatch({
        sentences,
        scenes,
        providerId: provider.providerId,
        model: provider.model,
      });
      assertNotAborted(signal);
      if (outcome.fallback) {
        throw new BatchExecutorError('semantic_fallback', '语义矩阵打分未得到有效结果，可重试；分配将使用关键词兜底');
      }
      return {
        commit: () => {
          assertNotAborted(signal);
          const persisted = persistBatchSemanticMatrix(db, {
            projectId,
            scriptKey,
            poolKey,
            providerId: provider.providerId,
            model: outcome.model,
            scores: outcome.scores,
            hooks: outcome.hooks,
          });
          return {
            resultJson: {
              scriptSnapshotId: snapshot.id,
              scriptKey,
              poolKey,
              matrixId: persisted.id,
              created: persisted.created,
            },
            progress: {
              phase: 'semantic_score',
              description: `语义匹配完成（${sentences.length} 句 × ${scenes.length} 场景）`,
              percent: 1,
            },
          };
        },
      };
    },
  };
}

export const semanticScoreExecutor = createSemanticScoreExecutor();

/** 按任务种类选择执行器;没有注册执行器的任务种类返回 null。 */
export function findExecutor(
  executors: BatchTaskExecutor[],
  workType: BatchTaskWorkType,
): BatchTaskExecutor | undefined {
  return executors.find((executor) => executor.workTypes.includes(workType));
}
