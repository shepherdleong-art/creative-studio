import path from 'node:path';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { probeVideoMedia } from '../ffmpeg';
import { completeJson, estimateVisionAnalysisCost, getAvailableProviders } from '../script-providers';
import { fitNarrationTextToDuration } from '../script-generation-v3';
import { createFinalEditWorkspace, type FinalEditWorkspaceRuntime } from './workspace';
import { analyzeVideoWithVision } from './adapters/video-analysis';
import { createOpenAiAlignmentAdapter, type AlignmentAdapter } from './adapters/alignment';
import { getFinalEditTtsAdapter, listFinalEditTtsAdapters } from './adapters/tts-registry';
import { warmPreparePreview } from './prepare-preview';
import { detectBeatPoints } from './beat-detect';
import { writeLog } from '../logger';
import { createFinalEditJobController } from './worker';
import { resolveDefaultCjkFontFamily, setDefaultCjkFontFamily } from '../media-core/cover-domain.ts';
import { listSystemFonts } from '../media-core/system-fonts.ts';

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
  // 服务端把默认 CJK 字体解析为真实可用的 family（客户端构建不能扫描文件系统，
  // 那里用静态兜底）；同一进程内的批量生产也共享这份默认。
  setDefaultCjkFontFamily(resolveDefaultCjkFontFamily(new Set(listSystemFonts().map((font) => font.family))));
  const db = getDb();
  const storageRoot = path.join(dataRoot(), 'storage');
  workspace = createFinalEditWorkspace({
    db,
    storageRoot,
    probeVideo: async ({ filePath }) => probeVideoMedia(filePath),
    analyzeVideo: async ({ filePath, videoJobId, providerId }) => {
      const provider = getAvailableProviders().find((item) => item.id === providerId && item.configured && item.supportsVision);
      if (!provider) throw new Error('没有已启用并支持图片理解的视觉分析供应商');
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
      const provider = db.prepare(`SELECT apiKey, keyEnv FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(providerId) as { apiKey: string; keyEnv: string } | undefined;
      return Boolean(resolveProviderApiKey(provider));
    },
    validateAnalysisProvider: (providerId) => getAvailableProviders().some((provider) => provider.id === providerId && provider.configured && provider.supportsVision),
    estimateAnalysisCost: ({ providerId, requestCount }) => estimateVisionAnalysisCost(providerId, requestCount),
    synthesize: async ({ projectId, segments, providerId, voice, speed, narrationHash, onSegmentComplete, signal }) => {
      const row = db.prepare(`SELECT * FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(providerId) as {
        id: string;
        name: string;
        type: string;
        baseUrl: string;
        apiKey: string;
        keyEnv: string;
        model: string;
      } | undefined;
      if (!row) throw new Error('口播配音供应商未启用');
      const apiKey = resolveProviderApiKey(row);
      if (!apiKey) throw new Error('口播配音供应商 API Key 未配置');
      const alignment = createFinalEditAlignmentAdapter(row);
      const relativeOutputPath = path.join('final-edits', 'narration', narrationHash, 'narration.wav');
      return getFinalEditTtsAdapter(providerId).synthesize({
        provider: {
          providerId: row.id,
          providerName: row.name,
          providerType: row.type,
          configuredModel: row.model,
          requestModel: row.model,
          baseUrl: row.baseUrl,
          apiKey,
          model: row.model,
        },
        voice, speed, segments,
        outputDir: path.join(storageRoot, 'final-edits', 'narration', narrationHash),
        relativeOutputPath,
        alignment,
        onSegmentComplete,
        signal,
        usageContext: {
          projectId,
          refType: 'final-edit-narration',
          refId: narrationHash,
        },
      });
    },
    warmPreview: ({ variant, sources, narrationAbsolutePath, relativePath, signal }) => warmPreparePreview({ storageRoot, variant, sources, narrationAbsolutePath, relativePath, signal }),
    createJobController: () => {
      const registration = createFinalEditJobController();
      return { signal: registration.controller.signal, release: registration.release };
    },
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
  // 逐行解析 Key，跳过"启用了但没配 Key"的供应商，避免选到必然不可用的行。
  const candidates = getDb().prepare(`SELECT id, baseUrl, apiKey, keyEnv FROM final_edit_tts_providers WHERE enabled=1 ORDER BY isBuiltin DESC, name`).all() as AlignmentFallbackProvider[];
  const provider = candidates.find((candidate) => resolveProviderApiKey(candidate));
  if (provider && getFinalEditTtsAdapter(provider.id).providesWordTimings) return true;
  return createFinalEditAlignmentAdapter(provider).configured;
}
