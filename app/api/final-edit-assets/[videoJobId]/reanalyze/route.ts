import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getAvailableProviders } from '@/lib/script-providers';
import { analyzeVideoWithVision } from '@/lib/final-edit/adapters/video-analysis';
import { assertFinalEditAnalysisExecutionAvailable } from '@/lib/final-edit/runtime';
import { ProviderExecutionGateError } from '@/lib/provider-execution-gate';
import { resolveStoragePath } from '@/lib/final-edit/storage-path';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ videoJobId: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { videoJobId } = await params;
    const body = await request.json().catch(() => ({})) as { providerId?: string };
    const provider = getAvailableProviders().find((item) => item.id === body.providerId && item.configured && item.supportsVision)
      || getAvailableProviders().find((item) => item.configured && item.supportsVision);
    if (!provider) return NextResponse.json({ error: 'vision_provider_unavailable', message: '没有可用的视觉分析供应商' }, { status: 409 });
    const row = getDb().prepare(`SELECT id, shotSetId, localVideoPath FROM video_jobs WHERE id=? AND status='succeeded'`).get(videoJobId) as { id: string; shotSetId: string; localVideoPath: string } | undefined;
    if (!row?.localVideoPath) return NextResponse.json({ error: 'video_not_found', message: '视频素材不存在' }, { status: 404 });
    const storageRoot = path.join(dataRoot(), 'storage');
    const filePath = resolveStoragePath(storageRoot, row.localVideoPath, { allowAbsolute: true });
    await assertFinalEditAnalysisExecutionAvailable(provider.id);
    const result = await analyzeVideoWithVision({ filePath, videoJobId, providerId: provider.id, cacheDir: path.join(storageRoot, 'final-edits', 'analysis', videoJobId) });
    const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const timestamp = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO final_edit_asset_analysis (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, generatedJson, updatedAt, analyzedAt)
      VALUES (?, ?, ?, ?, ?, '1', 'succeeded', ?, ?, ?)
      ON CONFLICT(videoJobId) DO UPDATE SET fileFingerprint=excluded.fileFingerprint, providerId=excluded.providerId, model=excluded.model,
        status='succeeded', generatedJson=excluded.generatedJson, errorCode=NULL, errorMessage=NULL, updatedAt=excluded.updatedAt, analyzedAt=excluded.analyzedAt
    `).run(videoJobId, row.shotSetId, fingerprint, provider.id, provider.model, JSON.stringify(result), timestamp, timestamp);
    return NextResponse.json({ success: true, analysis: result });
  } catch (error) {
    if (error instanceof ProviderExecutionGateError) {
      const status = error.code === 'managed_workbench_locked' ? 423 : 409;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    return NextResponse.json({ error: 'reanalyze_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
