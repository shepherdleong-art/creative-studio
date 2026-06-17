import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { getVideoProviderConfigState } from '@/lib/video-auth';

const MAX_ITEMS = 10;

interface BatchItem {
  prompt: string;
  templateId: string | null;
  providerId: string;
  durationSec: number;
}

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
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const shotId = body.shotId as string;

    // Normalize items: each must have prompt + providerId + optional templateId/durationSec
    const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    const items: BatchItem[] = rawItems
      .map((it) => {
        const obj = (it ?? {}) as Record<string, unknown>;
        return {
          prompt: (obj.prompt as string)?.trim() || '',
          templateId: (obj.templateId as string) || null,
          providerId: (obj.providerId as string) || '',
          durationSec: (() => { const v = Number(obj.durationSec); const sec = (Number.isFinite(v) && v > 0) ? v : 5; return Math.max(2, Math.min(15, sec)); })(),
        };
      })
      .filter((it) => it.prompt.length > 0);

    if (!shotId) return NextResponse.json({ error: 'shotId is required' }, { status: 400 });
    if (items.length === 0) return NextResponse.json({ error: 'at least one prompt is required' }, { status: 400 });
    if (items.length > MAX_ITEMS) return NextResponse.json({ error: `最多 ${MAX_ITEMS} 条运镜` }, { status: 400 });
    if (items.some((it) => !it.providerId)) return NextResponse.json({ error: '每行都需要选择供应商' }, { status: 400 });

    // Validate shot belongs to this shot set
    const shot = db.prepare(`SELECT * FROM shots WHERE id = ? AND shotSetId = ?`).get(shotId, shotSetId) as {
      id: string; latestGeneratedImageId: string | null; sourceImageId: string;
    } | undefined;
    if (!shot) return NextResponse.json({ error: 'Shot not found in this shot set' }, { status: 404 });

    // Pre-validate all unique providers and resolve models
    const uniqueProviderIds = [...new Set(items.map((it) => it.providerId))];
    const providerCache = new Map<string, { model: string }>();
    for (const pid of uniqueProviderIds) {
      const prov = db.prepare(`SELECT * FROM video_providers WHERE id = ? AND enabled = 1`).get(pid) as {
        id: string; name: string; type: string; baseUrlEnv: string; apiKeyEnv: string; defaultModel: string;
      } | undefined;
      if (!prov) return NextResponse.json({ error: `视频供应商 ${pid} 未找到或已禁用` }, { status: 400 });
      const providerConfig = getVideoProviderConfigState(prov);
      if (!providerConfig.configured) {
        return NextResponse.json(
          { error: `视频供应商 ${prov.name} 未配置完整：${providerConfig.missing.join(', ')}` },
          { status: 400 }
        );
      }
      providerCache.set(pid, { model: prov.defaultModel });
    }

    // Get project ID from shot set
    const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as {
      projectId: string;
    } | undefined;
    if (!shotSet) return NextResponse.json({ error: 'Shot set not found' }, { status: 404 });

    // Use latest generated image, fallback to source image
    const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;

    const insert = db.prepare(`
      INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, providerId, model, templateId, prompt, durationSec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const videoJobIds: string[] = [];
    const createAll = db.transaction(() => {
      for (const item of items) {
        const videoJobId = uuidv4();
        const p = providerCache.get(item.providerId)!;
        insert.run(videoJobId, shotSet.projectId, shotSetId, shotId, sourceImageId, item.providerId, p.model, item.templateId, item.prompt, item.durationSec);
        videoJobIds.push(videoJobId);
      }
    });
    createAll();

    // Auto-start video queue if idle (multi-worker so 运镜 jobs run concurrently)
    const qStatus = getVideoQueueStatus(shotSet.projectId);
    if (qStatus === 'idle') {
      runVideoQueue({
        projectId: shotSet.projectId,
        concurrency: DEFAULT_VIDEO_CONCURRENCY,
        timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
      }).catch((err) => {
        console.error(`[VideoQueue] Auto-start failed:`, err);
      });
    }

    return NextResponse.json({ success: true, videoJobIds });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
