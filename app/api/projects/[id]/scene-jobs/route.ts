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

    const sceneSeedImageId = body.sceneSeedImageId as string;
    const scenePrompt = (body.scenePrompt as string || '').trim();
    const generationCount = Math.max(1, Math.min(9, Number(body.generationCount) || 4));

    if (!sceneSeedImageId) return NextResponse.json({ error: '缺少场景图 A' }, { status: 400 });
    if (!scenePrompt) return NextResponse.json({ error: '场景提示词不能为空' }, { status: 400 });

    // Validate project exists and is complex_product
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as {
      workflowType: string; providerId: string; model: string; size: string; quality: string; maxAttempts: number;
    } | undefined;
    if (!project) return NextResponse.json({ error: '项目不存在' }, { status: 404 });
    if (project.workflowType !== 'complex_product') return NextResponse.json({ error: '只有复杂产品项目支持场景生成' }, { status: 400 });

    const maxAttempts = Number(body.maxAttempts) || project.maxAttempts || 2;
    let jobProvider: { providerId: string; model: string };
    try {
      jobProvider = resolveImageJobProvider(db, body.providerId, {
        providerId: project.providerId,
        model: project.model,
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }

    // Validate image exists and belongs to this project or is unbound
    const img = db.prepare(`SELECT id, projectId FROM image_assets WHERE id = ?`).get(sceneSeedImageId) as { projectId: string | null } | undefined;
    if (!img) return NextResponse.json({ error: '场景图 A 不存在' }, { status: 400 });
    if (img.projectId && img.projectId !== id) return NextResponse.json({ error: '图片不属于当前项目' }, { status: 400 });

    const jobIds: string[] = [];
    db.transaction(() => {
      // Bind image to project
      db.prepare(`UPDATE image_assets SET projectId = ?, role = 'input', usage = 'scene_seed' WHERE id = ?`).run(id, sceneSeedImageId);

      // Update project scenePrompt
      db.prepare(`UPDATE projects SET scenePrompt = ? WHERE id = ?`).run(scenePrompt, id);

      // Create scene generation jobs
      const insertJob = db.prepare(`
        INSERT INTO jobs (id, projectId, inputImageId, referenceImageIds, providerId, model, prompt, size, quality, status, attempt, maxAttempts, referenceGuidanceMode)
        VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?, 'pending', 0, ?, 'none')
      `);
      for (let g = 0; g < generationCount; g++) {
        const jobId = uuidv4();
        insertJob.run(jobId, id, sceneSeedImageId, jobProvider.providerId, jobProvider.model, scenePrompt, project.size, project.quality, maxAttempts);
        jobIds.push(jobId);
      }
    })();

    return NextResponse.json({ success: true, jobCount: jobIds.length, jobIds });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
