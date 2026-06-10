import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { generateScript, ScriptOutput } from '@/lib/script-providers/gemini';
import { v4 as uuidv4 } from 'uuid';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();

    // Load project with full context
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // Load shots from all shot sets
    const shots = db.prepare(`
      SELECT s.indexNum, src.filename as sourceFilename
      FROM shots s
      JOIN shot_sets ss ON ss.id = s.shotSetId
      JOIN image_assets src ON src.id = s.sourceImageId
      WHERE ss.projectId = ?
      ORDER BY ss.createdAt, s.indexNum
    `).all(projectId) as Array<{ indexNum: number; sourceFilename: string }>;

    // Load scene references
    const sceneRefs = db.prepare(`
      SELECT sr.name FROM scene_references sr
      WHERE sr.projectId = ? AND sr.status = 'active'
      LIMIT 1
    `).all(projectId) as Array<{ name: string }>;

    // Load video template names used in this project
    const videoTemplates = db.prepare(`
      SELECT DISTINCT vpt.name FROM video_jobs vj
      JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
      WHERE vj.projectId = ? AND vj.templateId IS NOT NULL
    `).all(projectId) as Array<{ name: string }>;

    // Parse product brief from shot_sets category (legacy storage)
    let sellingPoints: string[] = [];
    try {
      const set = db.prepare(`SELECT category FROM shot_sets WHERE projectId = ? AND category LIKE '%sellingPoints%' LIMIT 1`).get(projectId) as { category?: string } | undefined;
      if (set?.category) {
        const brief = JSON.parse(set.category) as { sellingPoints?: Array<{ title: string }> };
        sellingPoints = (brief.sellingPoints || []).map((s: { title: string }) => s.title);
      }
    } catch { /* ignore */ }

    const result = await generateScript({
      projectName: (project.name as string) || '',
      productName: (project.productName as string) || '',
      productCode: (project.productCode as string) || '',
      productCategory: (project.productCategory as string) || '',
      targetAudience: '',
      tone: '种草',
      platform: '通用',
      sellingPoints,
      shots: shots.map((s) => ({ index: s.indexNum, description: s.sourceFilename })),
      sceneReference: sceneRefs[0]?.name,
      videoTemplates: videoTemplates.map((t) => t.name),
    });

    // Save draft
    const draftId = uuidv4();
    db.prepare(`
      INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      draftId,
      projectId,
      result.provider,
      result.model,
      JSON.stringify({ projectName: project.name, shotCount: shots.length }),
      JSON.stringify(result.script)
    );

    return NextResponse.json({ draftId, script: result.script, provider: result.provider, model: result.model });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();
    const drafts = db.prepare(`
      SELECT id, provider, model, inputSnapshot, outputJson, createdAt
      FROM script_drafts
      WHERE projectId = ?
      ORDER BY createdAt DESC
      LIMIT 10
    `).all(projectId);
    return NextResponse.json({ drafts });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
