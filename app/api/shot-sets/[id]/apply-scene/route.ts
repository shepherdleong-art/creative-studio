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
      projectId: string; status: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number;
    } | undefined;
    if (!set) return NextResponse.json({ error: '分镜组不存在' }, { status: 404 });

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

    // ── Create one job per shot ──
    const createdJobs: string[] = [];
    db.transaction(() => {
      const insertJob = db.prepare(`
        INSERT INTO jobs (
          id, projectId, inputImageId, referenceImageIds, providerId, model,
          prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'none')
      `);

      for (const shot of shots) {
        const jobId = uuidv4();
        insertJob.run(
          jobId, set.projectId, shot.sourceImageId,
          JSON.stringify([sceneRef.imageAssetId]),
          jobProvider.providerId, jobProvider.model, promptTemplate, set.size, set.quality,
          set.maxAttempts || 2
        );
        db.prepare(`UPDATE shots SET latestJobId = ? WHERE id = ?`).run(jobId, shot.id);
        createdJobs.push(jobId);
      }
    })();

    // Update shot set status
    db.prepare(`UPDATE shot_sets SET status = 'generating', sceneReferenceId = ? WHERE id = ?`).run(sceneReferenceId, id);

    return NextResponse.json({ success: true, jobCount: createdJobs.length, jobIds: createdJobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
