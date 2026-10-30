import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { createVideoJobsForShot, parseVideoJobCreationItem, type VideoJobCreationItem } from '@/lib/video-job-create';
import { validateVideoTailFrameBatchDrafts } from '@/lib/video-tail-frame';

const MAX_ITEMS = 10;

// Create multiple "运镜" video jobs for a single shot in one call, then start
// the video queue with multi-worker concurrency so they run in parallel.
// Each item can specify its own provider and duration for maximum flexibility.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    // Append independent candidates; never replace synced receipts or film selections.
    // This is also safe before a reassembled production has been adopted into mixcut.
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const shotId = body.shotId as string;
    if (!shotId) return NextResponse.json({ error: 'shotId is required' }, { status: 400 });

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const normalizedItems: VideoJobCreationItem[] = [];
    for (const rawItem of rawItems) {
      const parsed = parseVideoJobCreationItem(rawItem);
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
      normalizedItems.push(parsed.item);
    }
    const tailFrameDraftError = validateVideoTailFrameBatchDrafts(normalizedItems);
    if (tailFrameDraftError) return NextResponse.json({ error: tailFrameDraftError }, { status: 400 });
    const items = normalizedItems.filter((item) => item.prompt.length > 0);

    if (items.length === 0) return NextResponse.json({ error: 'at least one prompt is required' }, { status: 400 });
    if (items.length > MAX_ITEMS) return NextResponse.json({ error: `最多 ${MAX_ITEMS} 条运镜` }, { status: 400 });
    if (items.some((item) => !item.providerId)) return NextResponse.json({ error: '每行都需要选择供应商' }, { status: 400 });

    const result = await createVideoJobsForShot({ shotSetId, shotId, items, batch: true, db });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    const projectId = (db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as { projectId: string }).projectId;

    // Auto-start video queue if idle (multi-worker so 运镜 jobs run concurrently)
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

    return NextResponse.json({ success: true, videoJobIds: result.videoJobIds });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
