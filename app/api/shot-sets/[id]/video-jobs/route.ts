import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { toStorageImageUrl, toStorageVideoUrl } from '@/lib/storage-url';
import { createVideoJobsForShot, parseVideoJobCreationItem } from '@/lib/video-job-create';
import { resolveVideoJobDisplayNames } from '@/lib/video-output-filenames';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    // New video candidates do not change production receipts or the film's selected clips.
    // Allow step-four generation for reassembled sets, including unfinished productions.
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const shotId = body.shotId as string;
    if (!shotId) return NextResponse.json({ error: 'shotId is required' }, { status: 400 });
    const parsed = parseVideoJobCreationItem(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const item = parsed.item;
    if (!item.providerId) return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    if (!item.prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });

    const result = await createVideoJobsForShot({ shotSetId, shotId, items: [item], db });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const projectId = (db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as { projectId: string }).projectId;

    // Auto-start video queue if idle
    const qStatus = getVideoQueueStatus(projectId);
    if (qStatus === 'idle') {
      const projectRow = db.prepare(`SELECT videoConcurrency FROM projects WHERE id = ?`).get(projectId) as { videoConcurrency?: number } | undefined;
      const concurrency = Math.max(1, Math.min(10, Number(projectRow?.videoConcurrency) || DEFAULT_VIDEO_CONCURRENCY));
      runVideoQueue({
        projectId,
        concurrency,
        timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
      }).catch((err) => {
        console.error(`[VideoQueue] Auto-start failed:`, err);
      });
    }

    return NextResponse.json({ success: true, videoJobId: result.videoJobIds[0] });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    const jobs = db.prepare(`
      SELECT vj.*, vp.name as providerName, vpt.name as templateName, ia.path as posterImagePath
      FROM video_jobs vj
      LEFT JOIN video_providers vp ON vp.id = vj.providerId
      LEFT JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      LEFT JOIN image_assets ia ON ia.id = vj.sourceImageId
      WHERE vj.shotSetId = ?
      ORDER BY vj.createdAt DESC, vj.rowid ASC
    `).all(shotSetId) as Array<Record<string, unknown> & { posterImagePath?: string | null }>;

    // 播放与下载按登记路径生成 URL，filename 仅表示文件名。
    // 旧任务 displayName 为 NULL，由共享 helper 确定性派生，不回写数据库。
    const displayNames = resolveVideoJobDisplayNames(db, jobs.map((job) => String(job.id)));
    const jobsWithPosters = jobs.map(({ posterImagePath, ...job }) => ({
      ...job,
      displayName: displayNames.get(String(job.id)) ?? null,
      posterImageUrl: toStorageImageUrl(posterImagePath),
      videoUrl: toStorageVideoUrl(typeof job.localVideoPath === 'string' ? job.localVideoPath : null),
    }));

    return NextResponse.json({ jobs: jobsWithPosters });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
