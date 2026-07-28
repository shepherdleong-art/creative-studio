import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  completeJson,
  getAvailableProviders,
  getProviderMeta,
} from '@/lib/script-providers';
import type { AnalysisInput } from '@/lib/script-providers';
import {
  analyzeScriptStrategyV3,
  ScriptGenerationV3Error,
} from '@/lib/script-generation-v3';
import { generateAndPersistScriptV3 } from '@/lib/script-generation-v3-service';

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
      return await handleAnalyze(projectId, project, body);
    }

    return await handleGenerate(projectId, project, body);
  } catch (err) {
    if (err instanceof ScriptGenerationV3Error) {
      return NextResponse.json({
        error: err.code,
        message: err.message,
        details: err.details,
      }, { status: 422 });
    }
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
  const result = await analyzeScriptStrategyV3(input, {
    completeJson: (request) => completeJson({ providerId, ...request }),
  });

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
  body: Record<string, unknown>,
) {
  const result = await generateAndPersistScriptV3({ projectId, project, body }, {
    db: getDb(),
    completeJson: (providerId, request) => completeJson({ providerId, ...request }),
    providerMeta: getProviderMeta,
  });
  return NextResponse.json(result.body, { status: result.status });
}
