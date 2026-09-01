import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { getVideoProviderConfigState } from '@/lib/video-auth';
import { validateVideoTailFrameAsset, validateVideoTailFrameBatchDrafts } from '@/lib/video-tail-frame';
import { normalizeVideoMultiShotForStorage } from '@/lib/video-multi-shot';
import { countVideoJobsForShot, planVideoJobDisplayName } from '@/lib/video-output-filenames';

const MAX_ITEMS = 10;

interface BatchItem {
  prompt: string;
  templateId: string | null;
  providerId: string;
  durationSec: number;
  tailImageId: string | null;
  multiShot: unknown;
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
    const normalizedItems: BatchItem[] = rawItems.map((it) => {
      const obj = (it ?? {}) as Record<string, unknown>;
      return {
        prompt: (obj.prompt as string)?.trim() || '',
        templateId: (obj.templateId as string) || null,
        providerId: (obj.providerId as string) || '',
        durationSec: (() => { const v = Number(obj.durationSec); const sec = (Number.isFinite(v) && v > 0) ? v : 5; return Math.max(2, Math.min(15, sec)); })(),
        tailImageId: typeof obj.tailImageId === 'string' && obj.tailImageId.trim()
          ? obj.tailImageId.trim()
          : null,
        multiShot: obj.multiShot,
      };
    });
    const tailFrameDraftError = validateVideoTailFrameBatchDrafts(normalizedItems);
    if (tailFrameDraftError) {
      return NextResponse.json({ error: tailFrameDraftError }, { status: 400 });
    }
    const items = normalizedItems.filter((it) => it.prompt.length > 0);

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
    const providerCache = new Map<string, { model: string; type: string }>();
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
      const model = (prov.defaultModel || '').trim();
      providerCache.set(pid, { model, type: prov.type });
    }

    // Get project ID from shot set
    const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as {
      projectId: string;
    } | undefined;
    if (!shotSet) return NextResponse.json({ error: 'Shot set not found' }, { status: 404 });

    // Use latest generated image, fallback to source image
    const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;

    const insert = db.prepare(`
      INSERT INTO video_jobs
        (id, projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model, templateId, prompt, durationSec, multiShot, createdAt, displayName)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const videoJobIds: string[] = [];
    const createAll = db.transaction(() => {
      for (const item of items) {
        const provider = providerCache.get(item.providerId)!;
        const tailFrameValidation = validateVideoTailFrameAsset({
          db,
          tailImageId: item.tailImageId,
          projectId: shotSet.projectId,
          providerType: provider.type,
          model: provider.model,
        });
        if (!tailFrameValidation.ok) return tailFrameValidation;
      }

      // 友好展示名（D5）：批量同 shot 多条运镜按请求原始顺序续号（现有任务数
      // 为基数，逐条 +1）。createdAt 逐条加 1ms，保证 (createdAt, id) 排名与
      // 请求顺序、持久化版次一致；物理文件名仍由队列生成，不受影响。
      const versionBase = countVideoJobsForShot(db, shotId);
      const batchBaseMs = Date.now();
      items.forEach((item, index) => {
        const videoJobId = uuidv4();
        const p = providerCache.get(item.providerId)!;
        const multiShot = normalizeVideoMultiShotForStorage(p.type, p.model, item.multiShot);
        const displayName = planVideoJobDisplayName(db, {
          shotId,
          sourceImageId,
          templateId: item.templateId,
          versionNumber: versionBase + index + 1,
        });
        insert.run(
          videoJobId, shotSet.projectId, shotSetId, shotId, sourceImageId, item.tailImageId,
          item.providerId, p.model, item.templateId, item.prompt, item.durationSec, multiShot,
          new Date(batchBaseMs + index).toISOString(), displayName,
        );
        videoJobIds.push(videoJobId);
      });
      return { ok: true as const };
    });
    const createResult = createAll();
    if (!createResult.ok) {
      return NextResponse.json({ error: createResult.error }, { status: 400 });
    }

    // Auto-start video queue if idle (multi-worker so 运镜 jobs run concurrently)
    const qStatus = getVideoQueueStatus(shotSet.projectId);
    if (qStatus === 'idle') {
      const projectRow = db.prepare(`SELECT videoConcurrency FROM projects WHERE id = ?`).get(shotSet.projectId) as { videoConcurrency?: number } | undefined;
      const concurrency = Math.max(1, Math.min(10, Number(projectRow?.videoConcurrency) || DEFAULT_VIDEO_CONCURRENCY));
      runVideoQueue({
        projectId: shotSet.projectId,
        concurrency,
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
