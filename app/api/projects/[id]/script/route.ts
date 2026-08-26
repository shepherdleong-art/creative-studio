import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import {
  completeJson,
  getAvailableProviders,
} from '@/lib/script-providers';
import type { AnalysisInput } from '@/lib/script-providers';
import {
  analyzeScriptStrategyV3,
  ScriptGenerationV3Error,
} from '@/lib/script-generation-v3';

// ── POST: 只保留 analyze；生成/取消已迁移到 /script-generation（任务化接口）──

/** 脚本分析的失败此前只回给前端，服务端无迹可查；统一落项目日志。 */
function logScriptFailure(projectId: string, stage: string, detail: unknown): void {
  const body = detail as { message?: unknown; error?: unknown } | null;
  const message = detail instanceof Error
    ? detail.message
    : typeof body?.message === 'string'
      ? body.message
      : typeof body?.error === 'string'
        ? body.error
        : String(detail);
  writeLog({ projectId, level: 'error', message: `[脚本生成] ${stage}: ${message}` });
}

/** 关键节点信息日志：让分析过程在日志抽屉里可见（开始/完成、选用的模型）。 */
function logScriptInfo(projectId: string, message: string): void {
  writeLog({ projectId, level: 'info', message: `[脚本生成] ${message}` });
}

const ENDPOINT_MOVED = {
  error: 'script_generation_endpoint_moved',
  message: '脚本生成/取消接口已迁移，请刷新页面后重试',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let projectIdForLog = '';
  try {
    const { id: projectId } = await params;
    projectIdForLog = projectId;
    const db = getDb();

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = (body.action as string) || 'generate';

    if (action !== 'analyze') {
      // 旧的 generate/cancel 生命周期已整体迁移到 /script-generation；
      // 不得转发或暗中产生第二种任务生命周期。
      return NextResponse.json(ENDPOINT_MOVED, { status: 410 });
    }

    return await handleAnalyze(projectId, project, body);
  } catch (err) {
    const failure = scriptAnalysisFailure(err);
    logScriptFailure(projectIdForLog, '分析异常', failure.body);
    return NextResponse.json(failure.body, { status: failure.status });
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
      SELECT id, provider, model, inputSnapshot, outputJson, createdAt, generationDurationMs
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
  logScriptInfo(projectId, `开始分析卖点（${sellingPoints.length} 条，模型 ${providerId}，平台 ${platform}）`);
  const result = await analyzeScriptStrategyV3(input, {
    completeJson: (request) => completeJson({
      providerId,
      ...request,
      usageContext: {
        projectId,
        refType: 'script-analysis',
        refId: projectId,
      },
    }),
  });
  logScriptInfo(projectId, `卖点分析完成（模型 ${providerId}）`);

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

function scriptAnalysisFailure(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptGenerationV3Error) {
    return {
      status: 422,
      body: { error: error.code, message: error.message, details: error.details },
    };
  }
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}
