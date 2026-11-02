import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { writeLog } from '@/lib/logger';
import { completeJson, getProviderMeta } from '@/lib/script-providers';
import { generateAndPersistScriptV3 } from '@/lib/script-generation-v3-service';
import {
  cancelPersistentScriptGeneration,
  cancelScriptGeneration,
  getPersistentProjectScriptGeneration,
  getProjectScriptGeneration,
  isScriptGenerationShuttingDown,
  startPersistentScriptGeneration,
  startScriptGeneration,
} from '@/lib/script-generation-manager';
import { SCRIPT_GENERATION_V3_EXECUTOR_KEY } from '@/lib/script-generation-v3-server';
import {
  handleScriptGenerationDelete,
  handleScriptGenerationGet,
  handleScriptGenerationPost,
  type ScriptGenerationRouteResponse,
} from '@/lib/script-generation-route-handler';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { requireTaskScope } from '@/lib/team-service/task-principals';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 脚本生成的失败此前只回给前端，服务端无迹可查；统一落项目日志。 */
function logScriptFailure(projectId: string, stage: string, detail: unknown): void {
  const body = detail as { message?: unknown; error?: unknown } | null;
  let message = detail instanceof Error
    ? detail.message
    : typeof body?.message === 'string'
      ? body.message
      : typeof body?.error === 'string'
        ? body.error
        : String(detail);
  // 结构校验失败时附上逐条失配原因，否则日志里只有一句笼统结论，无法定位。
  // 服务层已把 ScriptGenerationV3Error 转成 422 body，这里要同时兼容 Error 与 body 两种形态。
  const rawDetails = detail instanceof Error
    ? (detail as { details?: { validationIssues?: unknown } }).details
    : (body as { details?: { validationIssues?: unknown } } | null)?.details;
  const issues = rawDetails?.validationIssues;
  if (Array.isArray(issues) && issues.length > 0) {
    message += `｜校验明细：${issues.slice(0, 5).map(String).join('；')}`;
  }
  writeLog({ projectId, level: 'error', message: `[脚本生成] ${stage}: ${message}` });
}

function logScriptInfo(projectId: string, message: string): void {
  writeLog({ projectId, level: 'info', message: `[脚本生成] ${message}` });
}

function toResponse(result: ScriptGenerationRouteResponse): NextResponse {
  return NextResponse.json(result.body, { status: result.status, headers: result.headers });
}

function buildDeps(projectId: string, project: Record<string, unknown>) {
  const access = requireAccessContext();
  return {
    projectExists: () => Boolean(project),
    isShuttingDown: () => isScriptGenerationShuttingDown(),
    start: (body: Record<string, unknown>) => {
      if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
      const generationId = String(body.generationId);
      if (access.kind === 'team') {
        const started = startPersistentScriptGeneration({
          db: getDb(), projectId, generationId,
          actor: { userId: access.actor.userId },
          scope: { resourceType: 'project', resourceId: projectId },
          inputSnapshot: { project, body },
          executorKey: SCRIPT_GENERATION_V3_EXECUTOR_KEY,
          accept: () => access.registerTaskPrincipal({
            module: 'script_generation', taskId: generationId,
            scope: { resourceType: 'project', resourceId: projectId },
            creationSnapshot: { shotSetId: body.shotSetId, providerId: body.providerId },
          }),
        });
        if (!started.created) requireTaskScope(getDb(), 'script_generation', started.snapshot.generationId);
        return started;
      }
      return startScriptGeneration({
        projectId,
        generationId,
        execute: async ({ signal, onProgress }) => {
          logScriptInfo(projectId, `开始生成脚本（模型 ${(body.providerId as string) || '默认'}，任务化）`);
          try {
            const result = await generateAndPersistScriptV3({ projectId, project, body }, {
              db: getDb(),
              completeJson: (providerId, request) => completeJson({
                providerId,
                ...request,
                usageContext: {
                  projectId,
                  refType: 'script-generation',
                  refId: String(body.generationId),
                },
              }),
              providerMeta: getProviderMeta,
              signal,
              onProgress,
            });
            if (result.status >= 400) logScriptFailure(projectId, '脚本生成失败', result.body);
            else logScriptInfo(projectId, '脚本生成完成');
            return result;
          } catch (error) {
            if (!(error instanceof Error && (error.name === 'AbortError' || error.message === '脚本生成已取消'))) {
              logScriptFailure(projectId, '脚本生成异常', error);
            }
            throw error;
          }
        },
      });
    },
    getCurrent: () => access.kind === 'team'
      ? getPersistentProjectScriptGeneration(getDb(), projectId)
      : getProjectScriptGeneration(projectId),
    cancel: (generationId: string) => access.kind === 'team'
      ? cancelPersistentScriptGeneration(getDb(), projectId, generationId)
      : cancelScriptGeneration(projectId, generationId),
  };
}

async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const access = requireAccessContext();
  if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
  const project = getDb()
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(projectId) as Record<string, unknown> | undefined;
  const body = await request.json().catch(() => null) as unknown;
  return toResponse(handleScriptGenerationPost(buildDeps(projectId, project ?? {}), body));
}

async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const access = requireAccessContext();
  if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
  const project = getDb()
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(projectId) as { id: string } | undefined;
  return toResponse(handleScriptGenerationGet(buildDeps(projectId, project ?? {})));
}

async function __teamRouteDELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const access = requireAccessContext();
  if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
  const project = getDb()
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .get(projectId) as { id: string } | undefined;
  return toResponse(handleScriptGenerationDelete(
    buildDeps(projectId, project ?? {}),
    request.nextUrl.searchParams.get('generationId'),
  ));
}
export const POST = withTeamRoute('/api/projects/[id]/script-generation', 'POST', __teamRoutePOST);
export const GET = withTeamRoute('/api/projects/[id]/script-generation', 'GET', __teamRouteGET);
export const DELETE = withTeamRoute('/api/projects/[id]/script-generation', 'DELETE', __teamRouteDELETE);
