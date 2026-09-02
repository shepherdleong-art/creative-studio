import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveImageJobProvider } from '@/lib/image-provider-selection';
import { v4 as uuidv4 } from 'uuid';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;

    const sceneReferenceId = body.sceneReferenceId as string;
    const promptTemplate = (body.prompt as string)?.trim();

    if (!sceneReferenceId) return NextResponse.json({ error: '缺少场景参考图' }, { status: 400 });
    if (!promptTemplate) return NextResponse.json({ error: '缺少提示词' }, { status: 400 });

    // Validate shot set
    const set = db.prepare(`SELECT ss.*, p.providerId, p.model, p.size, p.quality, p.maxAttempts FROM shot_sets ss JOIN projects p ON ss.projectId = p.id WHERE ss.id = ?`).get(id) as {
      projectId: string; status: string; kind?: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number;
    } | undefined;
    if (!set) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });
    // 自由素材工位没有「用场景参考图重绘分镜图」这个动作。前端已经不展示
    // 入口,这里是服务端兜底:直接打接口不能把自由工位推进 generating。
    if (set.kind === 'free') {
      return NextResponse.json({ error: '自由素材工位不支持分镜生成' }, { status: 400 });
    }

    let jobProvider: { providerId: string; model: string };
    try {
      jobProvider = resolveImageJobProvider(db, body.providerId, {
        providerId: set.providerId,
        model: set.model,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    // Validate scene reference
    const sceneRef = db.prepare(`SELECT * FROM scene_references WHERE id = ? AND projectId = ?`).get(sceneReferenceId, set.projectId) as { imageAssetId: string } | undefined;
    if (!sceneRef) return NextResponse.json({ error: '场景参考图不存在或不属于当前项目' }, { status: 400 });

    // Get shots for this set
    const shots = db.prepare(`SELECT * FROM shots WHERE shotSetId = ? ORDER BY indexNum`).all(id) as Array<{ id: string; sourceImageId: string }>;
    if (shots.length === 0) return NextResponse.json({ error: '分镜组没有分镜图' }, { status: 400 });

    // ── Create one job per shot：同一请求写同一 createdAt、按分镜顺序写 creationIndex ──
    const createdJobs: string[] = [];
    db.transaction(() => {
      const batchCreatedAt = new Date().toISOString();
      const insertJob = db.prepare(`
        INSERT INTO jobs (
          id, projectId, inputImageId, referenceImageIds, providerId, model,
          prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode, createdAt, creationIndex
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'none', ?, ?)
      `);

      shots.forEach((shot, index) => {
        const jobId = uuidv4();
        insertJob.run(
          jobId, set.projectId, shot.sourceImageId,
          JSON.stringify([sceneRef.imageAssetId]),
          jobProvider.providerId, jobProvider.model, promptTemplate, set.size, set.quality,
          set.maxAttempts || 2,
          batchCreatedAt, index
        );
        db.prepare(`UPDATE shots SET latestJobId = ? WHERE id = ?`).run(jobId, shot.id);
        createdJobs.push(jobId);
      });
    })();

    // Update shot set status
    db.prepare(`UPDATE shot_sets SET status = 'generating', sceneReferenceId = ? WHERE id = ?`).run(sceneReferenceId, id);

    return NextResponse.json({ success: true, jobCount: createdJobs.length, jobIds: createdJobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
