import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getAvailableProviders } from '@/lib/script-providers';
import { probeVideoMedia } from '@/lib/ffmpeg';
import { analyzeVideoWithVision } from '@/lib/final-edit/adapters/video-analysis';
import { resolveStoragePath } from '@/lib/final-edit/storage-path';
import { analyzeFinalEditAsset } from '@/lib/final-edit/asset-analysis';

export async function POST(request: Request, { params }: { params: Promise<{ videoJobId: string }> }) {
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
    const result = await analyzeFinalEditAsset({
      db: getDb(),
      probeVideo: ({ filePath }) => probeVideoMedia(filePath),
      analyzeVideo: ({ filePath, videoJobId, providerId }) => analyzeVideoWithVision({ filePath, videoJobId, providerId, cacheDir: path.join(storageRoot, 'final-edits', 'analysis', videoJobId) }),
    }, { filePath, videoJobId, shotSetId: row.shotSetId, providerId: provider.id, model: provider.model, mode: 'refresh' });
    return NextResponse.json({ success: true, analysis: result.analysis });
  } catch (error) { return NextResponse.json({ error: 'reanalyze_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
