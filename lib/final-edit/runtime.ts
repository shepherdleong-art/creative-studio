import path from 'node:path';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { probeVideoMedia } from '../ffmpeg';
import { estimateVisionAnalysisCost, getAvailableProviders } from '../script-providers';
import { createFinalEditWorkspace, type FinalEditWorkspaceRuntime } from './workspace';
import { analyzeVideoWithVision } from './adapters/video-analysis';
import { createOpenAiAlignmentAdapter, type AlignmentAdapter } from './adapters/alignment';
import { getFinalEditTtsAdapter, listFinalEditTtsAdapters } from './adapters/tts-registry';

let workspace: FinalEditWorkspaceRuntime | null = null;
let prepareRecoveryStarted = false;

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
    estimateAnalysisCost: ({ providerId, requestCount }) => estimateVisionAnalysisCost(providerId, requestCount),
    synthesize: async ({ segments, providerId, voice, speed, narrationHash }) => {
      const row = db.prepare(`SELECT * FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(providerId) as { baseUrl: string; apiKey: string; keyEnv: string; model: string } | undefined;
      if (!row) throw new Error('口播配音供应商未启用');
      const apiKey = resolveProviderApiKey(row);
      if (!apiKey) throw new Error('口播配音供应商 API Key 未配置');
      const alignment = createFinalEditAlignmentAdapter({ id: providerId, ...row });
      const relativeOutputPath = path.join('final-edits', 'narration', narrationHash, 'narration.wav');
      return getFinalEditTtsAdapter(providerId).synthesize({
        provider: { baseUrl: row.baseUrl, apiKey, model: row.model },
        voice, speed, segments,
        outputDir: path.join(storageRoot, 'final-edits', 'narration', narrationHash),
        relativeOutputPath,
        alignment,
      });
    },
  });
  return workspace;
}

export function recoverFinalEditPrepareJobs() {
  if (prepareRecoveryStarted) return;
  prepareRecoveryStarted = true;
  const db = getDb();
  db.prepare(`UPDATE final_edit_jobs SET status='queued', phase='recovered_after_restart', startedAt=NULL WHERE kind='prepare' AND status='running'`).run();
  const jobs = db.prepare(`SELECT id FROM final_edit_jobs WHERE kind='prepare' AND status='queued' ORDER BY createdAt`).all() as Array<{ id: string }>;
  const activeWorkspace = getFinalEditWorkspace();
  for (const job of jobs) void activeWorkspace.resumePrepareJob(job.id);
}

export function isFinalEditAlignmentConfigured(): boolean {
  const provider = getDb().prepare(`SELECT id, baseUrl, apiKey, keyEnv FROM final_edit_tts_providers WHERE enabled=1 ORDER BY isBuiltin DESC, name LIMIT 1`).get() as AlignmentFallbackProvider | undefined;
  return createFinalEditAlignmentAdapter(provider).configured;
}
