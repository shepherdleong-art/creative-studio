import path from 'node:path';
import { getDb } from '../db';
import { dataRoot } from '../data-root';
import { probeDurationSec } from '../ffmpeg';
import { estimateVisionAnalysisCost, getAvailableProviders } from '../script-providers';
import { createFinalEditWorkspace, type FinalEditWorkspaceRuntime } from './workspace';
import { analyzeVideoWithVision } from './adapters/video-analysis';
import { createOpenAiAlignmentAdapter } from './adapters/alignment';
import { getFinalEditTtsAdapter } from './adapters/tts-registry';

let workspace: FinalEditWorkspaceRuntime | null = null;
let prepareRecoveryStarted = false;

export function getFinalEditWorkspace(): FinalEditWorkspaceRuntime {
  if (workspace) return workspace;
  const db = getDb();
  const storageRoot = path.join(dataRoot(), 'storage');
  workspace = createFinalEditWorkspace({
    db,
    storageRoot,
    probeVideo: async ({ filePath }) => ({ durationUs: Math.round(await probeDurationSec(filePath) * 1_000_000), width: 0, height: 0, fps: 0 }),
    analyzeVideo: async ({ filePath, videoJobId, providerId }) => {
      const provider = getAvailableProviders().find((item) => item.id === providerId && item.configured && item.supportsVision);
      if (!provider) throw new Error('没有已启用并支持图片理解的视觉分析供应商');
      return analyzeVideoWithVision({ filePath, videoJobId, providerId: provider.id, cacheDir: path.join(storageRoot, 'final-edits', 'analysis', videoJobId) });
    },
    estimateAnalysisCost: ({ providerId, requestCount }) => estimateVisionAnalysisCost(providerId, requestCount),
    synthesize: async ({ segments, providerId, voice, speed, narrationHash }) => {
      const row = db.prepare(`SELECT * FROM final_edit_tts_providers WHERE id=? AND enabled=1`).get(providerId) as { baseUrl: string; apiKey: string; keyEnv: string; model: string } | undefined;
      if (!row) throw new Error('口播配音供应商未启用');
      const apiKey = row.apiKey.trim() || (row.keyEnv ? (process.env[row.keyEnv] || '').trim() : '');
      if (!apiKey) throw new Error('口播配音供应商 API Key 未配置');
      const alignment = createOpenAiAlignmentAdapter();
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
  return createOpenAiAlignmentAdapter().configured;
}
