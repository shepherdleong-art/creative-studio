import './accepted-access.ts';
import type { AuthPrincipal } from './auth/types.ts';
import { TeamAuthError } from './auth/types.ts';
import { assertTrustedWriteRequest, requirePrincipal } from './auth/request.ts';
import { readRuntimeConfig } from './config.ts';
import { getDb } from '../db.ts';
import {
  createTeamAccessContext,
  requireResourceAccess,
  scopeDescendsFrom,
  ResourceAccessError,
  type TeamResourceScope,
} from './resource-scopes.ts';
import { runWithAccessContext } from '../media-core/access-context.ts';
import { teamRoutePolicy, type TeamRoutePolicy } from './route-policy.ts';

interface RouteHandlerContext {
  params?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>;
}

type RequestData = {
  params: Record<string, string | string[] | undefined>;
  query: URLSearchParams;
  body: unknown;
};

const ID_RESOURCES: Record<string, string> = {
  projectId: 'project', canvasId: 'canvas', sourceCanvasId: 'canvas', shotSetId: 'shot_set', shotId: 'shot',
  imageId: 'image', inputImageId: 'image', sourceImageId: 'image', sceneSeedImageId: 'image',
  tailFrameImageId: 'image', tailImageId: 'image', jobId: 'job', sourceJobId: 'job', videoJobId: 'video_job', batchId: 'batch',
  planId: 'batch_plan', batchVersionId: 'batch_version', ownerBatchVersionId: 'batch_version',
  outputVersionId: 'batch_output_version', currentVersionId: 'batch_output_version', versionId: 'batch_version',
  scriptId: 'project_script', scriptDraftId: 'script_draft', taskId: 'task', assetId: 'asset', imageAssetId: 'image',
  analysisId: 'batch_analysis', sourceSetId: 'script_source_set', libraryRevisionId: 'script_library_revision',
  sceneReferenceId: 'scene_reference', draftGroupId: 'final_group', coverTitlePresetId: 'title_preset', presetId: 'title_preset',
  upstreamTaskId: 'task', sourceTaskId: 'task', draftAssetId: 'asset', resolvedAssetId: 'asset', currentAssetId: 'asset',
  bgmId: 'bgm', bgmTrackId: 'bgm', trackId: 'bgm', lutId: 'lut', templateId: 'video_prompt_template',
  catalogId: 'script_catalog', revisionId: 'script_catalog_revision', entryId: 'viral_template_entry', artifactId: 'project_artifact',
  groupId: 'final_group', variantId: 'final_variant', proposalId: 'final_proposal',
};

const ARRAY_ID_RESOURCES: Record<string, string> = {
  projectIds: 'project', canvasIds: 'canvas', shotSetIds: 'shot_set', shotIds: 'shot',
  imageIds: 'image', shotImageIds: 'image', referenceImageIds: 'image', sourceImageIds: 'image',
  jobIds: 'job', videoJobIds: 'video_job', batchIds: 'batch', planIds: 'batch_plan',
  scriptIds: 'project_script', taskIds: 'task', assetIds: 'asset', bgmIds: 'bgm', lutIds: 'lut',
  referenceAssetIds: 'video_reference_asset', entryIds: 'viral_template_entry', resultAssetIds: 'asset',
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function contextualResource(route: string, key: string, inferred: string): string {
  if (route.startsWith('/api/canvas')) {
    if (['jobId', 'taskId', 'sourceTaskId', 'upstreamTaskId'].includes(key)) return 'canvas_task';
    if (['assetId', 'draftAssetId', 'resolvedAssetId', 'resultAssetIds'].includes(key)) return 'canvas_asset';
  }
  if (route.startsWith('/api/batch-production')) {
    if (['taskId', 'sourceTaskId', 'upstreamTaskId'].includes(key)) return 'batch_task';
    if (['assetId', 'draftAssetId', 'resolvedAssetId'].includes(key)) return 'batch_asset';
    if (key === 'artifactId') return 'batch_artifact';
    if (['versionId', 'currentVersionId'].includes(key)) return 'batch_output_version';
    if (key === 'scriptId') return 'batch_script';
  }
  if (route.startsWith('/api/script-studio/viral-templates') && key === 'revisionId') return 'viral_template_revision';
  if (route.startsWith('/api/projects/') && route.includes('/script-studio/') && key === 'revisionId') {
    return route.includes('/scripts/') ? 'project_script_revision' : 'script_library_revision';
  }
  if (route.includes('/script-studio/')) {
    if (key === 'taskId') return 'script_studio_task';
    if (key === 'scriptId') return 'project_script';
    if (route.startsWith('/api/script-studio/template-assets') && key === 'assetId') return 'script_template_asset';
  }
  if (route.includes('/final-edit') && key === 'taskId') return 'final_job';
  if (route.includes('/final-edit/shot-sets/') && key === 'assetId') return 'final_external_asset';
  if (route.startsWith('/api/projects/') && key === 'assetId') return 'image';
  return inferred;
}

function addReference(
  references: Array<{ resourceType: string; resourceId: string }>,
  route: string,
  key: string,
  resourceType: string,
  value: unknown,
) {
  // 脚本领域的 templateId 是内置文案模板标识，不是视频提示词模板资源。
  if (key === 'templateId' && (route.startsWith('/api/projects/[id]/script') || route.startsWith('/api/script-studio/'))) return;
  const resolved = contextualResource(route, key, resourceType);
  if (typeof value === 'string' && value.trim()) references.push({ resourceType: resolved, resourceId: value });
  if (Array.isArray(value)) {
    for (const item of value) addReference(references, route, key, resolved, item);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) addReference(references, route, key, resolved, item);
  }
}

function scanReferences(route: string, value: unknown, references: Array<{ resourceType: string; resourceId: string }>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scanReferences(route, item, references);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const direct = ID_RESOURCES[key];
    const plural = ARRAY_ID_RESOURCES[key];
    if (direct) addReference(references, route, key, direct, item);
    else if (plural) addReference(references, route, key, plural, item);
    else if (item && typeof item === 'object') scanReferences(route, item, references);
  }
}

async function requestData(request: Request, route: string, context?: RouteHandlerContext): Promise<RequestData> {
  let params: RequestData['params'] = {};
  if (context?.params) params = await context.params;
  const query = new URL(request.url).searchParams;
  let body: unknown = null;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    try {
      const contentType = request.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) body = await request.clone().json();
      else if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
        const form = await request.clone().formData();
        const record: Record<string, unknown> = {};
        for (const key of new Set(form.keys())) {
          const values = form.getAll(key).filter((value) => typeof value === 'string');
          record[key] = values.length > 1 ? values : values[0];
        }
        body = record;
      }
    } catch {
      // 原 handler 仍负责输入格式错误；授权只处理能够安全解析的引用。
    }
  }
  const references: Array<{ resourceType: string; resourceId: string }> = [];
  for (const [key, raw] of Object.entries(params)) {
    const value = single(raw);
    if (!value) continue;
    const direct = ID_RESOURCES[key];
    if (direct) addReference(references, route, key, direct, value);
  }
  for (const [key, value] of query.entries()) scanReferences(route, { [key]: value }, references);
  scanReferences(route, body, references);
  return { params, query, body };
}

function primaryReference(policy: TeamRoutePolicy, data: RequestData): { resourceType: string; resourceId: string } | null {
  const resource = policy.resource!;
  if (resource.endsWith('_collection') || resource.endsWith('_create')
    || ['upload', 'usage', 'font_favorites', 'user_font', 'scoped_operation', 'batch_asset_create'].includes(resource)) {
    return null;
  }
  const parameterByResource: Record<string, string> = {
    project: 'id', canvas: 'id', job: 'id', video_job: 'id', shot_set: 'id', scene_reference: 'id',
    video_reference_asset: 'id', image: 'id', batch: 'id', batch_task: 'taskId', batch_script: 'scriptId',
    batch_asset: 'assetId', canvas_task: 'taskId', canvas_asset: 'assetId', canvas_export: 'exportId',
    final_group: 'id', final_job: 'id', final_variant: 'id', final_proposal: 'id',
    bgm: 'id', lut: 'id', title_preset: 'id', video_prompt_template: 'id',
    script_template_asset: 'assetId', script_catalog: 'catalogId', viral_template_entry: 'entryId',
  };
  const parameter = parameterByResource[resource];
  const id = parameter ? single(data.params[parameter]) : undefined;
  return id ? { resourceType: resource, resourceId: id } : null;
}

const PRIMARY_CHILDREN: Record<string, Set<string>> = {
  batch: new Set(['batch_version', 'batch_plan', 'batch_output_version', 'batch_artifact', 'batch_task']),
  batch_plan: new Set(['batch_output_version', 'batch_artifact']),
  shot_set: new Set(['shot', 'final_group', 'final_external_asset']),
  final_group: new Set(['final_variant', 'final_proposal']),
  final_variant: new Set(['final_proposal']),
  project_script: new Set(['project_script_revision']),
  script_catalog: new Set(['script_catalog_revision', 'script_template_asset']),
  viral_template_library: new Set(['viral_template_revision', 'viral_template_entry']),
};

function assertSameAuthorizedRoot(
  db: ReturnType<typeof getDb>,
  policy: TeamRoutePolicy,
  primary: { resourceType: string; resourceId: string } | null,
  scopes: TeamResourceScope[],
): void {
  if (policy.resource === 'project_create' || policy.resource === 'upload') return;
  const roots = new Set(scopes
    .filter((scope) => ['project', 'canvas'].includes(scope.rootType))
    .map((scope) => `${scope.rootType}:${scope.rootId}`));
  if (roots.size > 1) {
    throw new ResourceAccessError('resource_forbidden', '请求引用了不同归属根的资源。', 403);
  }
  if (!primary) return;
  const primaryScope = scopes.find((scope) => scope.resourceType === primary.resourceType && scope.resourceId === primary.resourceId);
  if (!primaryScope) return;
  const children = PRIMARY_CHILDREN[primary.resourceType];
  if (children) {
    for (const scope of scopes) {
      if (scope === primaryScope || !children.has(scope.resourceType)) continue;
      if (!scopeDescendsFrom(db, scope, primaryScope)) {
        throw new ResourceAccessError('resource_forbidden', '请求引用了不属于当前父资源的记录。', 403);
      }
    }
  }
  if (primary.resourceType === 'shot_set' || primary.resourceType === 'final_group') {
    const shotSetId = primary.resourceType === 'shot_set' ? primary.resourceId
      : (db.prepare('SELECT shotSetId FROM final_edit_groups WHERE id = ?').get(primary.resourceId) as { shotSetId?: string } | undefined)?.shotSetId;
    for (const scope of scopes.filter((scope) => scope.resourceType === 'video_job')) {
      const row = db.prepare('SELECT shotSetId FROM video_jobs WHERE id = ?').get(scope.resourceId) as { shotSetId?: string | null } | undefined;
      if (!shotSetId || row?.shotSetId !== shotSetId) {
        throw new ResourceAccessError('resource_forbidden', '视频素材不属于当前分镜组。', 403);
      }
    }
  }
}

async function authorizeResource(
  request: Request,
  context: RouteHandlerContext | undefined,
  policy: TeamRoutePolicy,
  principal: AuthPrincipal,
): Promise<void> {
  const db = getDb();
  const data = await requestData(request, policy.route, context);
  const references: Array<{ resourceType: string; resourceId: string }> = [];
  const primary = primaryReference(policy, data);
  if (primary) references.push(primary);
  const scanned: Array<{ resourceType: string; resourceId: string }> = [];
  for (const [key, raw] of Object.entries(data.params)) {
    const value = single(raw);
    const resourceType = ID_RESOURCES[key];
    if (value && resourceType) addReference(scanned, policy.route, key, resourceType, value);
  }
  for (const [key, value] of data.query.entries()) scanReferences(policy.route, { [key]: value }, scanned);
  scanReferences(policy.route, data.body, scanned);
  references.push(...scanned);

  if (policy.resource === 'upload') {
    const projectId = data.body && typeof data.body === 'object'
      ? (data.body as Record<string, unknown>).projectId : null;
    if (typeof projectId === 'string' && projectId) references.push({ resourceType: 'project', resourceId: projectId });
  }
  const unique = [...new Map(references.map((reference) => [`${reference.resourceType}:${reference.resourceId}`, reference])).values()];
  const scopes = unique.map((reference) => requireResourceAccess(
    db, principal, reference.resourceType, reference.resourceId,
    primary && reference.resourceType === primary.resourceType && reference.resourceId === primary.resourceId
      ? policy.action! : 'read',
  ));
  assertSameAuthorizedRoot(db, policy, primary, scopes);
}

function authorizationError(error: unknown): Response {
  if (error instanceof TeamAuthError || error instanceof ResourceAccessError) {
    return Response.json({ error: error.code, message: error.message }, {
      status: error.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return Response.json({ error: 'authorization_failed', message: '资源授权不可用，已拒绝执行。' }, {
    status: 500,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function withTeamRoute<T>(route: string, method: string, handler: T): T & ((...args: unknown[]) => Promise<Response>) {
  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    const config = readRuntimeConfig();
    if (config.mode === 'local') {
      return (handler as (...handlerArgs: unknown[]) => unknown)(...args);
    }
    const policy = teamRoutePolicy(route, method);
    if (policy.category === 'server_disabled' || policy.category === 'local_only') {
      return Response.json({ error: 'not_found', message: '入口不存在。' }, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const request = args[0] as Request | undefined;
    let context = null as ReturnType<typeof createTeamAccessContext> | null;
    try {
      if (policy.csrf) {
        if (!request) throw new TeamAuthError('csrf_invalid', 'CSRF 校验失败。', 403);
        assertTrustedWriteRequest(request);
      }
      if (policy.category !== 'public') {
        if (!request) throw new TeamAuthError('session_invalid', '请先登录。', 401);
        const principal = requirePrincipal(request, {
          admin: policy.category === 'admin',
          allowMustChangePassword: policy.allowMustChangePassword,
        });
        context = createTeamAccessContext({ db: getDb(), principal });
        if (policy.category === 'resource') {
          await authorizeResource(request, args[1] as RouteHandlerContext | undefined, policy, principal);
        }
      }
    } catch (error) {
      return authorizationError(error);
    }
    const invoke = () => (handler as (...handlerArgs: unknown[]) => unknown)(...args);
    const response = await (context ? runWithAccessContext(context, invoke) : invoke()) as Response;
    if (response instanceof Response) response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  return wrapped as T & ((...args: unknown[]) => Promise<Response>);
}
