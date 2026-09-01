import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_CONCURRENCY, DEFAULT_VIDEO_TIMEOUT_MS } from '@/lib/video-queue';
import { toStorageImageUrl } from '@/lib/storage-url';
import { getVideoProviderConfigState } from '@/lib/video-auth';
import { validateVideoTailFrameAsset } from '@/lib/video-tail-frame';
import { normalizeVideoMultiShotForStorage } from '@/lib/video-multi-shot';
import { countVideoJobsForShot, planVideoJobDisplayName, resolveVideoJobDisplayNames } from '@/lib/video-output-filenames';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: shotSetId } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const shotId = body.shotId as string;
    const providerId = body.providerId as string;
    const templateId = (body.templateId as string) || null;
    const prompt = (body.prompt as string)?.trim();
    const durationSec = Number(body.durationSec) || 5;
    const tailImageId = typeof body.tailImageId === 'string' && body.tailImageId.trim()
      ? body.tailImageId.trim()
      : null;

    if (!shotId) return NextResponse.json({ error: 'shotId is required' }, { status: 400 });
    if (!providerId) return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    if (!prompt) return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
    if (durationSec < 2 || durationSec > 15) return NextResponse.json({ error: 'duration must be 2-15 seconds' }, { status: 400 });

    // Validate shot belongs to this shot set
    const shot = db.prepare(`SELECT * FROM shots WHERE id = ? AND shotSetId = ?`).get(shotId, shotSetId) as {
      id: string; latestGeneratedImageId: string | null; sourceImageId: string;
    } | undefined;
    if (!shot) return NextResponse.json({ error: 'Shot not found in this shot set' }, { status: 404 });

    // Validate provider
    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ? AND enabled = 1`).get(providerId) as {
      id: string; name: string; type: string; baseUrlEnv: string; apiKeyEnv: string; defaultModel: string;
    } | undefined;
    if (!provider) return NextResponse.json({ error: 'Video provider not found or disabled' }, { status: 400 });
    const providerConfig = getVideoProviderConfigState(provider);
    if (!providerConfig.configured) {
      return NextResponse.json(
        { error: `视频供应商 ${provider.name} 未配置完整：${providerConfig.missing.join(', ')}` },
        { status: 400 }
      );
    }
    const model = (provider.defaultModel || '').trim();

    // Use latest generated image, fallback to source image
    const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;

    // Get project ID from shot set
    const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as {
      projectId: string;
    } | undefined;
    if (!shotSet) return NextResponse.json({ error: 'Shot set not found' }, { status: 404 });

    const videoJobId = uuidv4();
    const multiShot = normalizeVideoMultiShotForStorage(
      provider.type,
      model,
      body.multiShot,
    );
    const createResult = db.transaction(() => {
      const tailFrameValidation = validateVideoTailFrameAsset({
        db,
        tailImageId,
        projectId: shotSet.projectId,
        providerType: provider.type,
        model,
      });
      if (!tailFrameValidation.ok) return tailFrameValidation;

      // 友好展示名（D5）：创建事务内计算并持久化；物理文件名仍由队列用
      // video-<jobId>-<时间戳>.mp4 生成，两者互不影响。createdAt 用 ISO 毫秒
      // 精度写入，保证同 shot 的 (createdAt, id) 排名与持久化版次一致。
      const displayName = planVideoJobDisplayName(db, {
        shotId,
        sourceImageId,
        templateId,
        versionNumber: countVideoJobsForShot(db, shotId) + 1,
      });
      db.prepare(`
        INSERT INTO video_jobs
          (id, projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model, templateId, prompt, durationSec, multiShot, createdAt, displayName)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(videoJobId, shotSet.projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model, templateId, prompt, durationSec, multiShot, new Date().toISOString(), displayName);
      return { ok: true as const };
    })();
    if (!createResult.ok) {
      return NextResponse.json({ error: createResult.error }, { status: 400 });
    }

    // Auto-start video queue if idle
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

    return NextResponse.json({ success: true, videoJobId });
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
      ORDER BY vj.createdAt DESC
    `).all(shotSetId) as Array<Record<string, unknown> & { posterImagePath?: string | null }>;

    // 读 API 同时返回物理 filename（播放 URL 用）与 displayName（所有用户可见名称）。
    // 旧任务 displayName 为 NULL，由共享 helper 确定性派生，不回写数据库。
    const displayNames = resolveVideoJobDisplayNames(db, jobs.map((job) => String(job.id)));
    const jobsWithPosters = jobs.map(({ posterImagePath, ...job }) => ({
      ...job,
      displayName: displayNames.get(String(job.id)) ?? null,
      posterImageUrl: toStorageImageUrl(posterImagePath),
    }));

    return NextResponse.json({ jobs: jobsWithPosters });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
