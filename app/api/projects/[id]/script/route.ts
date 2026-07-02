import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  generateScript,
  analyzeSellingPoints,
  getAvailableProviders,
} from '@/lib/script-providers';
import type {
  AnalysisInput,
  ScriptInput,
  ScriptOutput,
  SelectedSellingPoint,
  ShotContext,
  SellingPointMapEntry,
  ScriptShot,
} from '@/lib/script-providers';
import { v4 as uuidv4 } from 'uuid';

// ── POST: analyze | generate ──

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const db = getDb();

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = (body.action as string) || 'generate';

    if (action === 'analyze') {
      return handleAnalyze(projectId, project, body);
    }

    return handleGenerate(projectId, project, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── GET: drafts + analysis, or models ──

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: projectId } = await params;
    const action = request.nextUrl.searchParams.get('action');

    if (action === 'models') {
      const providers = getAvailableProviders();
      return NextResponse.json({ providers });
    }

    const db = getDb();

    const drafts = db.prepare(`
      SELECT id, provider, model, inputSnapshot, outputJson, createdAt
      FROM script_drafts
      WHERE projectId = ?
      ORDER BY createdAt DESC
      LIMIT 10
    `).all(projectId);

    // Load saved analysis from project
    const project = db.prepare(`SELECT sellingPointAnalysisJson FROM projects WHERE id = ?`).get(projectId) as { sellingPointAnalysisJson: string } | undefined;
    let analysis = null;
    if (project?.sellingPointAnalysisJson) {
      try {
        analysis = JSON.parse(project.sellingPointAnalysisJson);
      } catch { /* ignore corrupt data */ }
    }

    return NextResponse.json({ drafts, analysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── Action: Analyze Selling Points ──

async function handleAnalyze(
  projectId: string,
  project: Record<string, unknown>,
  body: Record<string, unknown>
) {
  const db = getDb();

  const sellingPoints: string[] = Array.isArray(body.sellingPoints)
    ? (body.sellingPoints as string[]).filter(Boolean)
    : [];
  const targetAudience = (body.targetAudience as string) || (project.targetAudience as string) || '';
  const platform = (body.platform as string) || (project.scriptPlatform as string) || '通用';
  const providerId = (body.providerId as string) || 'gemini';

  if (sellingPoints.length === 0) {
    return NextResponse.json({ error: '请至少输入一条卖点' }, { status: 400 });
  }

  const input: AnalysisInput = { sellingPoints, targetAudience, platform };
  const result = await analyzeSellingPoints(input, providerId);

  // Persist analysis to DB
  const analysisJson = JSON.stringify({
    ...result,
    sellingPoints,
    targetAudience,
    platform,
    providerId,
    analyzedAt: new Date().toISOString(),
  });

  db.prepare(`UPDATE projects SET sellingPointAnalysisJson = ? WHERE id = ?`).run(analysisJson, projectId);

  return NextResponse.json({ analysis: result });
}

// ── Action: Generate Script ──

async function handleGenerate(
  projectId: string,
  project: Record<string, unknown>,
  body: Record<string, unknown>
) {
  const db = getDb();

  // Require shotSetId
  const shotSetId = body.shotSetId as string | undefined;
  if (!shotSetId) {
    return NextResponse.json({ error: '请选择要生成脚本的分镜组' }, { status: 400 });
  }

  // Verify shotSet belongs to this project
  const shotSet = db.prepare(
    `SELECT id, name FROM shot_sets WHERE id = ? AND projectId = ?`
  ).get(shotSetId, projectId) as { id: string; name: string } | undefined;
  if (!shotSet) {
    return NextResponse.json({ error: '分镜组不存在或不属于当前项目' }, { status: 400 });
  }

  // Load shots for this shotSet (with shotId, not just index)
  const shotRows = db.prepare(`
    SELECT s.id as shotId, s.indexNum, s.sourceImageId, s.latestGeneratedImageId,
           src.filename as sourceFilename
    FROM shots s
    JOIN shot_sets ss ON ss.id = s.shotSetId
    JOIN image_assets src ON src.id = s.sourceImageId
    WHERE ss.projectId = ? AND ss.id = ?
    ORDER BY s.indexNum
  `).all(projectId, shotSetId) as Array<{
    shotId: string;
    indexNum: number;
    sourceImageId: string;
    latestGeneratedImageId: string | null;
    sourceFilename: string;
  }>;

  if (shotRows.length === 0) {
    return NextResponse.json({ error: '所选分镜组中没有分镜' }, { status: 400 });
  }

  // Build ShotContext
  const shots: ShotContext[] = shotRows.map((r) => ({
    shotId: r.shotId,
    shotIndex: r.indexNum,
    sourceFilename: r.sourceFilename,
    description: r.sourceFilename,
  }));

  // Load scene references
  const sceneRefs = db.prepare(`
    SELECT sr.name FROM scene_references sr
    WHERE sr.projectId = ? AND sr.status = 'active'
    LIMIT 1
  `).all(projectId) as Array<{ name: string }>;

  // Load video template names
  const videoTemplates = db.prepare(`
    SELECT DISTINCT vpt.name FROM video_jobs vj
    JOIN video_prompt_templates vpt ON vpt.id = vj.templateId
    WHERE vj.projectId = ? AND vj.templateId IS NOT NULL
  `).all(projectId) as Array<{ name: string }>;

  // Parse selected selling points from body
  let selectedSellingPoints: SelectedSellingPoint[] = [];
  if (Array.isArray(body.selectedSellingPoints)) {
    selectedSellingPoints = body.selectedSellingPoints as SelectedSellingPoint[];
  } else {
    // Fallback: load from project sellingPointsJson
    try {
      const json = (project.sellingPointsJson as string) || '[]';
      selectedSellingPoints = (JSON.parse(json) as Array<{ title: string; priority?: number }>).map((s) => ({
        title: s.title,
        priority: s.priority?.toString() || 'medium',
        reason: '',
      }));
    } catch { /* ignore */ }
  }

  const templateId = (body.templateId as string) || 'scene_seeding';
  const templateName = (body.templateName as string) || '场景种草';
  const duration = (body.duration as string) || '30s';
  const providerId = (body.providerId as string) || 'gemini';
  const tone = (body.tone as string) || (project.scriptTone as string) || '种草';
  const platform = (body.platform as string) || (project.scriptPlatform as string) || '通用';

  const input: ScriptInput = {
    projectName: (project.name as string) || '',
    productName: (project.productName as string) || '',
    productCode: (project.productCode as string) || '',
    productCategory: (project.productCategory as string) || '',
    targetAudience: (project.targetAudience as string) || '',
    tone,
    platform,
    selectedSellingPoints,
    templateId,
    templateName,
    duration,
    shotSetId,
    shots,
    sceneReference: sceneRefs[0]?.name,
    videoTemplates: videoTemplates.map((t) => t.name),
  };

  const result = await generateScript(input, providerId);

  // Validate and normalize output
  const script = validateAndNormalizeScript(result.script, shotRows, shotSetId);

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
    JSON.stringify({
      projectName: project.name,
      shotSetId,
      shotSetName: shotSet.name,
      shotCount: shots.length,
      selectedSellingPoints,
      templateId,
      templateName,
      duration,
      targetAudience: project.targetAudience,
      tone,
      platform,
      providerId,
    }),
    JSON.stringify(script)
  );

  return NextResponse.json({
    draftId,
    script,
    provider: result.provider,
    model: result.model,
  });
}

// ── Output validation & normalization ──

function validateAndNormalizeScript(
  script: ScriptOutput,
  shotRows: Array<{ shotId: string; indexNum: number }>,
  fallbackShotSetId: string
): ScriptOutput {
  const validShotIds = new Set(shotRows.map((r) => r.shotId));

  // Normalize shots: ensure each has a valid shotId
  const normalizedShots: ScriptShot[] = script.shots.map((s, i) => {
    // If shotId is missing or invalid, try to match by index
    let shotId = s.shotId;
    if (!validShotIds.has(shotId)) {
      const match = shotRows[i];
      shotId = match?.shotId || shotId;
    }
    return {
      shotId,
      shotIndex: s.shotIndex || shotRows[i]?.indexNum || i + 1,
      title: normalizeShotTitle(s.title, s.shotIndex || shotRows[i]?.indexNum || i + 1),
      duration: s.duration || '',
      voiceover: s.voiceover || '',
      subtitle: s.subtitle || s.voiceover || '',
      visualIntent: s.visualIntent || '',
    };
  });

  // Ensure we have the right number of shots
  if (normalizedShots.length !== shotRows.length) {
    // If too few, pad with empty entries
    while (normalizedShots.length < shotRows.length) {
      const i = normalizedShots.length;
      normalizedShots.push({
        shotId: shotRows[i].shotId,
        shotIndex: shotRows[i].indexNum,
        title: normalizeShotTitle('', shotRows[i].indexNum),
        duration: '',
        voiceover: '',
        subtitle: '',
        visualIntent: '',
      });
    }
    // If too many, trim
    normalizedShots.length = shotRows.length;
  }

  // Normalize sellingPointMap
  const normalizedMap: SellingPointMapEntry[] = (script.sellingPointMap || [])
    .filter((m) => validShotIds.has(m.shotId))
    .map((m) => {
      const match = normalizedShots.find((s) => s.shotId === m.shotId);
      return {
        shotId: m.shotId,
        shotIndex: match?.shotIndex || m.shotIndex || 0,
        sellingPoint: m.sellingPoint || '',
      };
    });

  // Ensure fullScript
  const fullScript = script.fullScript || normalizedShots.map((s) => s.voiceover).filter(Boolean).join('\n');

  return {
    title: script.title || '未命名脚本',
    platform: script.platform || '通用',
    tone: script.tone || '种草',
    duration: script.duration || '30s',
    template: script.template || '',
    shotSetId: script.shotSetId || fallbackShotSetId,
    sellingPointMap: normalizedMap,
    shots: normalizedShots,
    fullScript,
  };
}

function normalizeShotTitle(value: string | undefined, shotIndex: number): string {
  const title = (value || '').trim();
  return title || `分镜 ${shotIndex} 文案`;
}
