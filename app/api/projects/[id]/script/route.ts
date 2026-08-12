import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
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
import {
  cancelScriptGeneration,
  finishScriptGeneration,
  registerScriptGeneration,
} from '@/lib/script-generation-control';
import { encodeScriptGenerationStreamEvent } from '@/lib/script-generation-stream';
import type { ScriptGenerationProgress } from '@/lib/script-generation-v3';

// ── POST: analyze | generate ──

/** 脚本生成/分析的失败此前只回给前端，服务端无迹可查；统一落项目日志。 */
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

/** 关键节点信息日志：让生成过程在日志抽屉里可见（开始/完成、选用的模型）。 */
function logScriptInfo(projectId: string, message: string): void {
  writeLog({ projectId, level: 'info', message: `[脚本生成] ${message}` });
}

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

    if (action === 'cancel') {
      const generationId = typeof body.generationId === 'string' ? body.generationId : '';
      if (!generationId) return NextResponse.json({ error: '缺少生成任务 ID' }, { status: 400 });
      return NextResponse.json({ cancelled: cancelScriptGeneration(generationId, projectId) });
    }

    if (action === 'analyze') {
      return await handleAnalyze(projectId, project, body);
    }

    if (body.stream === true) {
      return handleGenerateStream(projectId, project, body, request.signal);
    }
    return await handleGenerate(projectId, project, body, request.signal);
  } catch (err) {
    const failure = scriptGenerationFailure(err);
    if (failure.status !== 499) {
      logScriptFailure(projectIdForLog, '分析/生成异常', failure.body);
    }
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
  logScriptInfo(projectId, `开始分析卖点（${sellingPoints.length} 条，模型 ${providerId}，平台 ${platform}）`);
  const result = await analyzeScriptStrategyV3(input, {
    completeJson: (request) => completeJson({ providerId, ...request }),
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

// ── Action: Generate Script ──

async function handleGenerate(
  projectId: string,
  project: Record<string, unknown>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) {
  logScriptInfo(projectId, `开始生成脚本（模型 ${(body.providerId as string) || '默认'}）`);
  const result = await generateAndPersistScriptV3({ projectId, project, body }, {
    db: getDb(),
    completeJson: (providerId, request) => completeJson({ providerId, ...request }),
    providerMeta: getProviderMeta,
    signal,
  });
  if (result.status >= 400) {
    logScriptFailure(projectId, '脚本生成失败', result.body);
  } else {
    logScriptInfo(projectId, '脚本生成完成');
  }
  return NextResponse.json(result.body, { status: result.status });
}

function scriptGenerationFailure(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ScriptGenerationV3Error) {
    return {
      status: 422,
      body: { error: error.code, message: error.message, details: error.details },
    };
  }
  if ((error instanceof Error && error.name === 'AbortError')
    || (error instanceof Error && error.message === '脚本生成已取消')) {
    return { status: 499, body: { error: 'script_generation_cancelled', message: '脚本生成已取消' } };
  }
  return {
    status: 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

function handleGenerateStream(
  projectId: string,
  project: Record<string, unknown>,
  body: Record<string, unknown>,
  requestSignal: AbortSignal,
): Response {
  const generationId = typeof body.generationId === 'string' ? body.generationId : '';
  if (!generationId) {
    return NextResponse.json({ error: '缺少生成任务 ID' }, { status: 400 });
  }

  const generationController = registerScriptGeneration(generationId, projectId);
  const abortFromDisconnect = () => generationController.abort();
  requestSignal.addEventListener('abort', abortFromDisconnect, { once: true });
  if (requestSignal.aborted) generationController.abort();

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      let streamOpen = true;
      const send = (event: Parameters<typeof encodeScriptGenerationStreamEvent>[0]) => {
        if (!streamOpen) return;
        try {
          streamController.enqueue(encodeScriptGenerationStreamEvent(event));
        } catch {
          streamOpen = false;
          generationController.abort();
        }
      };
      const onProgress = (progress: ScriptGenerationProgress) => send({ type: 'progress', progress });

      void (async () => {
        logScriptInfo(projectId, `开始生成脚本（模型 ${(body.providerId as string) || '默认'}，流式）`);
        try {
          const result = await generateAndPersistScriptV3({ projectId, project, body }, {
            db: getDb(),
            completeJson: (providerId, request) => completeJson({ providerId, ...request }),
            providerMeta: getProviderMeta,
            signal: generationController.signal,
            onProgress,
          });
          if (result.status >= 400) {
            logScriptFailure(projectId, '脚本生成失败', result.body);
          } else {
            logScriptInfo(projectId, '脚本生成完成');
          }
          send({
            type: result.status >= 400 ? 'error' : 'result',
            status: result.status,
            body: result.body,
          });
        } catch (error) {
          const failure = scriptGenerationFailure(error);
          if (failure.status !== 499) {
            logScriptFailure(projectId, '脚本生成异常', failure.body);
          }
          send({ type: 'error', status: failure.status, body: failure.body });
        } finally {
          finishScriptGeneration(generationId, generationController);
          requestSignal.removeEventListener('abort', abortFromDisconnect);
          if (streamOpen) {
            try {
              streamController.close();
            } catch { /* client disconnected */ }
          }
        }
      })();
    },
    cancel() {
      generationController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
