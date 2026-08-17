import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import { completeJson, getProviderMeta } from '@/lib/script-providers';
import { generateAndPersistScriptV3 } from '@/lib/script-generation-v3-service';
import {
  cancelScriptGeneration,
  getProjectScriptGeneration,
  isScriptGenerationShuttingDown,
  startScriptGeneration,
} from '@/lib/script-generation-manager';
import {
  handleScriptGenerationDelete,
  handleScriptGenerationGet,
  handleScriptGenerationPost,
  type ScriptGenerationRouteResponse,
} from '@/lib/script-generation-route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 脚本生成的失败此前只回给前端，服务端无迹可查；统一落项目日志。 */
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

function logScriptInfo(projectId: string, message: string): void {
  writeLog({ projectId, level: 'info', message: `[脚本生成] ${message}` });
}

function toResponse(result: ScriptGenerationRouteResponse): NextResponse {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

function buildDeps(projectId: string, project: Record<string, unknown>) {
  return {
    projectExists: () => Boolean(project),
    isShuttingDown: () => isScriptGenerationShuttingDown(),
    start: (body: Record<string, unknown>) => startScriptGeneration({
      projectId,
      generationId: String(body.generationId),
      execute: async ({ signal, onProgress }) => {
        logScriptInfo(projectId, `开始生成脚本（模型 ${(body.providerId as string) || '默认'}，任务化）`);
        try {
          const result = await generateAndPersistScriptV3({ projectId, project, body }, {
            db: getDb(),
            completeJson: (providerId, request) => completeJson({ providerId, ...request }),
            providerMeta: getProviderMeta,
            signal,
            onProgress,
          });
          if (result.status >= 400) {
            logScriptFailure(projectId, '脚本生成失败', result.body);
          } else {
            logScriptInfo(projectId, '脚本生成完成');
          }
          return result;
        } catch (error) {
          if (!(error instanceof Error && (error.name === 'AbortError' || error.message === '脚本生成已取消'))) {
            logScriptFailure(projectId, '脚本生成异常', error);
          }
          throw error;
        }
      },
    }),
    getCurrent: () => getProjectScriptGeneration(projectId),
    cancel: (generationId: string) => cancelScriptGeneration(projectId, generationId),
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const project = getDb()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(projectId) as Record<string, unknown> | undefined;
  const body = await request.json().catch(() => null) as unknown;
  return toResponse(handleScriptGenerationPost(buildDeps(projectId, project ?? {}), body));
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const project = getDb()
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(projectId) as { id: string } | undefined;
  return toResponse(handleScriptGenerationGet(buildDeps(projectId, project ?? {})));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const project = getDb()
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(projectId) as { id: string } | undefined;
  return toResponse(handleScriptGenerationDelete(
    buildDeps(projectId, project ?? {}),
    request.nextUrl.searchParams.get('generationId'),
  ));
}
