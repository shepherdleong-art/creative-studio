import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getAvailableProviders } from '@/lib/script-providers';
import { probeVideoMedia } from '@/lib/ffmpeg';
import { analyzeVideoWithVision } from '@/lib/final-edit/adapters/video-analysis';
import { resolveStoragePath } from '@/lib/final-edit/storage-path';
import { FINAL_EDIT_ANALYZER_VERSION } from '@/lib/final-edit/workspace';

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
    const result = await analyzeVideoWithVision({ filePath, videoJobId, providerId: provider.id, cacheDir: path.join(storageRoot, 'final-edits', 'analysis', videoJobId) });
    // 与 prepare 同源探测媒体信息：旧实现不写 mediaJson，导致新插入的分析行
    // durationUs 恒为 0，所有 clip 被编辑期校验判超限（素材删除/替换全部被拒）。
    const media = await probeVideoMedia(filePath);
    const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const timestamp = new Date().toISOString();
    // 对齐 workspace.ts 的完整写入（含 shotSetId / analyzerVersion / mediaJson）。
    getDb().prepare(`
      INSERT INTO final_edit_asset_analysis
        (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, updatedAt, analyzedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)
      ON CONFLICT(videoJobId) DO UPDATE SET shotSetId=excluded.shotSetId, fileFingerprint=excluded.fileFingerprint,
        providerId=excluded.providerId, model=excluded.model, analyzerVersion=excluded.analyzerVersion, status='succeeded',
        mediaJson=excluded.mediaJson, generatedJson=excluded.generatedJson,
        errorCode=NULL, errorMessage=NULL, analyzedAt=excluded.analyzedAt, updatedAt=excluded.updatedAt
    `).run(videoJobId, row.shotSetId, fingerprint, provider.id, provider.model, FINAL_EDIT_ANALYZER_VERSION, JSON.stringify(media), JSON.stringify(result), timestamp, timestamp);
    return NextResponse.json({ success: true, analysis: result });
  } catch (error) { return NextResponse.json({ error: 'reanalyze_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
