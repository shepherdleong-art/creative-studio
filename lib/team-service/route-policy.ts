export const TEAM_ROUTE_CATEGORIES = ['public', 'authenticated', 'resource', 'admin', 'local_only', 'server_disabled'] as const;
export type TeamRouteCategory = typeof TEAM_ROUTE_CATEGORIES[number];
export type TeamHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface TeamRoutePolicy {
  route: string;
  method: TeamHttpMethod;
  category: TeamRouteCategory;
  csrf: boolean;
  resource?: string;
  action?: 'read' | 'write';
  allowMustChangePassword?: boolean;
}

// route+method 是唯一清单来源；分类与 resolver 由下方显式例外和保守推导生成。
const ROUTE_METHODS: Record<string, string> = {
  '/api/batch-production/assets/filename-description': 'POST',
  '/api/batch-production/assets/import': 'POST',
  '/api/batch-production/assets/[assetId]/preview': 'GET',
  '/api/batch-production/assets/[assetId]/proxies': 'POST',
  '/api/batch-production/assets/[assetId]/thumbnail': 'GET',
  '/api/batch-production/batches': 'GET POST',
  '/api/batch-production/batches/[id]/archive': 'POST',
  '/api/batch-production/batches/[id]/assets/analyze': 'POST',
  '/api/batch-production/batches/[id]/assets/[assetId]/exclusion': 'POST',
  '/api/batch-production/batches/[id]/control': 'POST',
  '/api/batch-production/batches/[id]/export-preflight': 'GET',
  '/api/batch-production/batches/[id]/exports/reveal': 'POST',
  '/api/batch-production/batches/[id]/exports': 'POST',
  '/api/batch-production/batches/[id]/outputs/review': 'POST',
  '/api/batch-production/batches/[id]/outputs/[planId]/arrangement': 'GET',
  '/api/batch-production/batches/[id]/outputs/[planId]/clips': 'POST',
  '/api/batch-production/batches/[id]/outputs/[planId]/cover': 'POST',
  '/api/batch-production/batches/[id]/outputs/[planId]/media': 'GET',
  '/api/batch-production/batches/[id]/outputs/[planId]/packaging-preview': 'GET POST',
  '/api/batch-production/batches/[id]/outputs/[planId]/reallocate': 'POST',
  '/api/batch-production/batches/[id]/proxies': 'POST',
  '/api/batch-production/batches/[id]': 'GET',
  '/api/batch-production/batches/[id]/semantic-score': 'POST',
  '/api/batch-production/batches/[id]/snapshot': 'POST',
  '/api/batch-production/batches/[id]/start': 'PUT',
  '/api/batch-production/batches/[id]/tasks': 'GET',
  '/api/batch-production/batches/[id]/workspace': 'GET',
  '/api/batch-production/bgm': 'GET POST',
  '/api/batch-production/luts': 'GET POST',
  '/api/batch-production/luts/[id]/control': 'POST',
  '/api/batch-production/luts/[id]/file': 'GET',
  '/api/batch-production/prepare': 'GET',
  '/api/batch-production/preview/[assetId]': 'GET',
  '/api/batch-production/proxies/cleanup': 'POST',
  '/api/batch-production/proxies/usage': 'GET',
  '/api/batch-production/readiness': 'GET',
  '/api/batch-production/recovery': 'GET',
  '/api/batch-production/scripts': 'DELETE POST',
  '/api/batch-production/scripts/[scriptId]/narration-config': 'PUT',
  '/api/batch-production/scripts/[scriptId]': 'DELETE PUT',
  '/api/batch-production/tasks/[taskId]/control': 'POST',
  '/api/batch-production/tasks/[taskId]/retry': 'POST',
  '/api/batch-production/tasks/[taskId]': 'GET',
  '/api/canvas/assets/[assetId]/draft': 'GET',
  '/api/canvas/assets/[assetId]': 'GET',
  '/api/canvas/exports/[exportId]': 'GET',
  '/api/canvas/models': 'GET',
  '/api/canvas': 'GET POST',
  '/api/canvas/tasks': 'GET',
  '/api/canvas/tasks/[taskId]/cancel': 'POST',
  '/api/canvas/tasks/[taskId]/download-retry': 'POST',
  '/api/canvas/tasks/[taskId]/reconcile': 'POST',
  '/api/canvas/tasks/[taskId]/resume': 'POST',
  '/api/canvas/[id]/assets': 'GET POST',
  '/api/canvas/[id]/copies': 'POST',
  '/api/canvas/[id]/exports': 'POST',
  '/api/canvas/[id]/logs': 'GET',
  '/api/canvas/[id]/plan': 'POST',
  '/api/canvas/[id]': 'GET PATCH',
  '/api/canvas/[id]/runs': 'POST',
  '/api/company-provider/health': 'GET',
  '/api/desktop/activity': 'GET',
  '/api/desktop/health': 'GET',
  '/api/desktop/import-linked': 'POST',
  '/api/desktop/relocate-linked': 'POST',
  '/api/final-edit/capabilities': 'GET',
  '/api/final-edit/title-presets': 'GET POST',
  '/api/final-edit/title-presets/[id]': 'DELETE PATCH',
  '/api/final-edit-assets/[videoJobId]/analysis': 'PATCH',
  '/api/final-edit-assets/[videoJobId]/reanalyze': 'POST',
  '/api/final-edit-bgm': 'POST',
  '/api/final-edit-bgm/[id]/file': 'GET',
  '/api/final-edit-groups/[id]/assets/[videoJobId]/reanalyze': 'POST',
  '/api/final-edit-groups/[id]/assets/[videoJobId]/thumbnail': 'GET',
  '/api/final-edit-groups/[id]/cover-candidates/[coverKey]': 'GET',
  '/api/final-edit-groups/[id]/cover-frame': 'GET',
  '/api/final-edit-groups/[id]/download': 'GET',
  '/api/final-edit-groups/[id]/duration-resolution': 'POST',
  '/api/final-edit-groups/[id]/film-content': 'GET POST',
  '/api/final-edit-groups/[id]/film-preview': 'POST',
  '/api/final-edit-groups/[id]/narration': 'GET',
  '/api/final-edit-groups/[id]/overlay-bundles/[preset]': 'POST',
  '/api/final-edit-groups/[id]/packaging-preview': 'GET',
  '/api/final-edit-groups/[id]/review-cover': 'GET',
  '/api/final-edit-groups/[id]/rework/[clipId]': 'GET POST',
  '/api/final-edit-groups/[id]': 'GET PATCH',
  '/api/final-edit-groups/[id]/use-mixcut': 'POST',
  '/api/final-edit-groups/[id]/variants': 'POST',
  '/api/final-edit-jobs/[id]/cancel': 'POST',
  '/api/final-edit-jobs/[id]/cover': 'GET',
  '/api/final-edit-jobs/[id]/publish-original': 'POST',
  '/api/final-edit-jobs/[id]/retry': 'POST',
  '/api/final-edit-jobs/[id]/reveal': 'POST',
  '/api/final-edit-jobs/[id]': 'GET',
  '/api/final-edit-jobs/[id]/video': 'GET',
  '/api/final-edit-proposals/[id]/apply': 'POST',
  '/api/final-edit-proposals/[id]': 'GET',
  '/api/final-edit-variants/[id]/packaging': 'GET POST',
  '/api/final-edit-variants/[id]/proposals': 'POST',
  '/api/final-edit-variants/[id]/render': 'POST',
  '/api/final-edit-variants/[id]': 'DELETE PATCH',
  '/api/font-favorites': 'GET POST',
  '/api/images/[...path]': 'GET',
  '/api/images/[id]': 'DELETE',
  '/api/jobs/[id]/regenerate': 'POST',
  '/api/jobs/[id]/resume-poll': 'POST',
  '/api/jobs/[id]/retry': 'POST',
  '/api/jobs/[id]': 'PATCH',
  '/api/packaging/system-fonts': 'GET',
  '/api/packaging/system-fonts/select': 'POST',
  '/api/packaging/templates/[...path]': 'GET',
  '/api/packaging/user-font': 'DELETE GET POST',
  '/api/projects': 'GET POST',
  '/api/projects/[id]/creative-package': 'GET',
  '/api/projects/[id]/download': 'GET',
  '/api/projects/[id]/export': 'GET',
  '/api/projects/[id]/final-edit/bootstrap': 'GET',
  '/api/projects/[id]/final-edit/context': 'GET',
  '/api/projects/[id]/final-edit/draft': 'POST',
  '/api/projects/[id]/final-edit/groups': 'GET POST',
  '/api/projects/[id]/final-edit/preflight': 'POST',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets': 'GET POST',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/[assetId]/media': 'GET',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/[assetId]': 'DELETE',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/[assetId]/thumbnail': 'GET',
  '/api/projects/[id]/final-edit/shot-sets/[shotSetId]/module4-assets/[videoJobId]/thumbnail': 'GET',
  '/api/projects/[id]/final-edit/start': 'POST',
  '/api/projects/[id]/free-shot-set': 'POST',
  '/api/projects/[id]/logs': 'GET',
  '/api/projects/[id]': 'DELETE GET PATCH',
  '/api/projects/[id]/run': 'GET POST',
  '/api/projects/[id]/scene-jobs': 'POST',
  '/api/projects/[id]/scene-references': 'GET POST',
  '/api/projects/[id]/script': 'GET POST',
  '/api/projects/[id]/script-generation': 'DELETE GET POST',
  '/api/projects/[id]/script-studio/distilled-points': 'GET POST',
  '/api/projects/[id]/script-studio/import-directory': 'POST',
  '/api/projects/[id]/script-studio/library/evidence': 'GET',
  '/api/projects/[id]/script-studio/library/organize': 'POST',
  '/api/projects/[id]/script-studio/library': 'GET POST',
  '/api/projects/[id]/script-studio/scripts': 'GET',
  '/api/projects/[id]/script-studio/scripts/[scriptId]/current': 'PUT',
  '/api/projects/[id]/script-studio/scripts/[scriptId]/regenerate': 'POST',
  '/api/projects/[id]/script-studio/scripts/[scriptId]/revisions': 'GET',
  '/api/projects/[id]/script-studio/scripts/[scriptId]': 'GET POST',
  '/api/projects/[id]/script-studio/source-sets': 'GET POST',
  '/api/projects/[id]/script-studio/tasks': 'GET POST',
  '/api/projects/[id]/script-studio/tasks/[taskId]/cancel': 'POST',
  '/api/projects/[id]/script-studio/tasks/[taskId]/retry': 'POST',
  '/api/projects/[id]/script-studio/tasks/[taskId]': 'GET',
  '/api/projects/[id]/script-studio/viral-template-recommend': 'POST',
  '/api/projects/[id]/shot-sets': 'GET POST',
  '/api/projects/[id]/video-reference-assets': 'POST',
  '/api/projects/[id]/video-run': 'GET POST',
  '/api/providers': 'GET POST',
  '/api/providers/script': 'GET POST',
  '/api/providers/script/[id]': 'DELETE PUT',
  '/api/providers/tts': 'GET',
  '/api/providers/tts/[id]/preview': 'POST',
  '/api/providers/tts/[id]': 'PUT',
  '/api/providers/video': 'GET POST',
  '/api/providers/video/[id]': 'DELETE PUT',
  '/api/providers/[id]/activate-only': 'POST',
  '/api/providers/[id]': 'DELETE GET PUT',
  '/api/reassembled-films/capabilities': 'GET',
  '/api/reassembled-films/import': 'POST',
  '/api/reassembled-films/productions/items/[id]': 'POST',
  '/api/reassembled-films/productions': 'GET POST',
  '/api/reassembled-films/productions/[id]': 'GET',
  '/api/reassembled-films/[id]/archive': 'POST',
  '/api/reassembled-films/[id]/cover': 'GET',
  '/api/reassembled-films/[id]/open': 'GET',
  '/api/reassembled-films/[id]/review': 'GET POST',
  '/api/scene-references/[id]': 'DELETE PATCH',
  '/api/script-studio/catalogs': 'GET',
  '/api/script-studio/catalogs/strategy/import': 'POST',
  '/api/script-studio/catalogs/template/import': 'POST',
  '/api/script-studio/catalogs/[catalogId]/current': 'PUT',
  '/api/script-studio/catalogs/[catalogId]/revisions/[revisionId]': 'GET',
  '/api/script-studio/template-assets/[assetId]': 'GET',
  '/api/script-studio/viral-templates/current': 'PUT',
  '/api/script-studio/viral-templates/entries': 'GET',
  '/api/script-studio/viral-templates/entries/[entryId]': 'PATCH',
  '/api/script-studio/viral-templates/import': 'POST',
  '/api/script-studio/viral-templates': 'GET',
  '/api/shot-sets/[id]/apply-scene': 'POST',
  '/api/shot-sets/[id]/download': 'GET',
  '/api/shot-sets/[id]': 'DELETE GET PATCH',
  '/api/shot-sets/[id]/shots': 'POST',
  '/api/shot-sets/[id]/shots/[shotId]': 'DELETE',
  '/api/shot-sets/[id]/video-jobs/batch': 'POST',
  '/api/shot-sets/[id]/video-jobs': 'GET POST',
  '/api/shutdown': 'POST',
  '/api/system-fonts': 'GET',
  '/api/team/auth/change-password': 'POST',
  '/api/team/auth/csrf': 'GET',
  '/api/team/auth/login': 'POST',
  '/api/team/auth/logout': 'POST',
  '/api/team/auth/session': 'GET',
  '/api/team/health/live': 'GET',
  '/api/team/health/ready': 'GET',
  '/api/team/files/[id]': 'GET',
  '/api/team/models': 'GET',
  '/api/team/public-resources': 'POST',
  '/api/team/users': 'GET POST',
  '/api/team/users/[id]/reset-credential': 'POST',
  '/api/team/users/[id]': 'PATCH',
  '/api/upload': 'POST',
  '/api/usage/records': 'GET',
  '/api/usage': 'GET',
  '/api/video-jobs/[id]/resume-poll': 'POST',
  '/api/video-jobs/[id]/retry': 'POST',
  '/api/video-jobs/[id]': 'GET PATCH',
  '/api/video-prompt-templates': 'GET POST',
  '/api/video-prompt-templates/[id]': 'DELETE PATCH',
  '/api/video-reference-assets/[id]': 'DELETE GET',
  '/api/videos/[...path]': 'GET',
};

const PUBLIC = new Set([
  '/api/team/auth/csrf GET', '/api/team/auth/login POST', '/api/team/auth/session GET',
  '/api/team/health/live GET', '/api/team/health/ready GET',
]);
const AUTHENTICATED = new Set([
  '/api/team/auth/change-password POST', '/api/team/auth/logout POST',
  '/api/canvas/models GET', '/api/final-edit/capabilities GET',
  '/api/system-fonts GET', '/api/packaging/system-fonts GET', '/api/team/models GET',
  '/api/team/files/[id] GET', '/api/images/[...path] GET', '/api/videos/[...path] GET',
]);
const ADMIN_PREFIXES = ['/api/providers', '/api/team/users'];
const ADMIN = new Set([
  '/api/company-provider/health GET',
  '/api/batch-production/proxies/cleanup POST', '/api/batch-production/proxies/usage GET',
  '/api/batch-production/readiness GET', '/api/batch-production/recovery GET',
  '/api/team/public-resources POST',
]);
const SERVER_DISABLED = new Set([
  '/api/packaging/templates/[...path] GET',
  '/api/packaging/system-fonts/select POST', '/api/projects/[id]/script-studio/import-directory POST',
  '/api/packaging/user-font GET', '/api/packaging/user-font POST', '/api/packaging/user-font DELETE',
  '/api/providers/tts/[id]/preview POST',
  '/api/final-edit-jobs/[id]/reveal POST', '/api/final-edit-jobs/[id]/publish-original POST',
  '/api/batch-production/batches/[id]/exports/reveal POST',
]);

function categoryFor(route: string, method: TeamHttpMethod): TeamRouteCategory {
  const key = `${route} ${method}`;
  if (PUBLIC.has(key)) return 'public';
  if (AUTHENTICATED.has(key)) return 'authenticated';
  if (route === '/api/shutdown' || route.startsWith('/api/desktop/')) return 'local_only';
  if (route.startsWith('/api/reassembled-films') || SERVER_DISABLED.has(key)) return 'server_disabled';
  if (ADMIN.has(key) || ADMIN_PREFIXES.some((prefix) => route.startsWith(prefix))) return 'admin';
  return 'resource';
}

export function inferTeamResource(route: string, method: TeamHttpMethod): string {
  const collection = method === 'POST' ? 'create' : 'collection';
  if (route === '/api/projects') return `project_${collection}`;
  if (route.startsWith('/api/projects/')) return 'project';
  if (route === '/api/canvas') return `canvas_${collection}`;
  if (route === '/api/canvas/tasks') return 'canvas_task_collection';
  if (route.startsWith('/api/canvas/tasks/')) return 'canvas_task';
  if (route.startsWith('/api/canvas/assets/')) return 'canvas_asset';
  if (route.startsWith('/api/canvas/exports/')) return 'canvas_export';
  if (route.startsWith('/api/canvas/')) return 'canvas';
  if (route.startsWith('/api/jobs/')) return 'job';
  if (route.startsWith('/api/video-jobs/')) return 'video_job';
  if (route.startsWith('/api/shot-sets/')) return 'shot_set';
  if (route.startsWith('/api/scene-references/')) return 'scene_reference';
  if (route.startsWith('/api/video-reference-assets/')) return 'video_reference_asset';
  if (route === '/api/images/[id]') return 'image';
  if (route === '/api/upload') return 'upload';
  if (route.startsWith('/api/usage')) return 'usage';
  if (route === '/api/font-favorites') return 'font_favorites';
  if (route === '/api/packaging/user-font') return 'user_font';
  if (route === '/api/batch-production/batches') return `batch_${collection}`;
  if (route.startsWith('/api/batch-production/batches/')) return 'batch';
  if (route.startsWith('/api/batch-production/tasks/')) return 'batch_task';
  if (route === '/api/batch-production/scripts') return `batch_script_${collection}`;
  if (route.startsWith('/api/batch-production/scripts/')) return 'batch_script';
  if (route.includes('/assets/[assetId]') || route.startsWith('/api/batch-production/preview/')) return 'batch_asset';
  if (route === '/api/batch-production/bgm') return `bgm_${collection}`;
  if (route === '/api/batch-production/luts') return `lut_${collection}`;
  if (route.startsWith('/api/batch-production/luts/')) return 'lut';
  if (route === '/api/batch-production/assets/import' || route === '/api/batch-production/assets/filename-description') return 'batch_asset_create';
  if (route.startsWith('/api/final-edit-groups/')) return 'final_group';
  if (route.startsWith('/api/final-edit-jobs/')) return 'final_job';
  if (route.startsWith('/api/final-edit-variants/')) return 'final_variant';
  if (route.startsWith('/api/final-edit-proposals/')) return 'final_proposal';
  if (route.startsWith('/api/final-edit-assets/')) return 'video_job';
  if (route === '/api/final-edit-bgm') return 'bgm_create';
  if (route.startsWith('/api/final-edit-bgm/')) return 'bgm';
  if (route === '/api/final-edit/title-presets') return `title_preset_${collection}`;
  if (route.startsWith('/api/final-edit/title-presets/')) return 'title_preset';
  if (route === '/api/video-prompt-templates') return `video_prompt_template_${collection}`;
  if (route.startsWith('/api/video-prompt-templates/')) return 'video_prompt_template';
  if (route === '/api/script-studio/template-assets/[assetId]') return 'script_template_asset';
  if (route.includes('/catalogs/[catalogId]')) return 'script_catalog';
  if (route === '/api/script-studio/catalogs') return 'script_catalog_collection';
  if (route.includes('/viral-templates/entries/[entryId]')) return 'viral_template_entry';
  if (route.startsWith('/api/script-studio/viral-templates')) return 'viral_template_collection';
  return 'scoped_operation';
}

export const TEAM_ROUTE_POLICIES: TeamRoutePolicy[] = Object.entries(ROUTE_METHODS).flatMap(([route, methods]) =>
  methods.split(' ').map((method) => {
    const httpMethod = method as TeamHttpMethod;
    const category = categoryFor(route, httpMethod);
    const key = `${route} ${method}`;
    return {
      route,
      method: httpMethod,
      category,
      csrf: !['GET', 'HEAD', 'OPTIONS'].includes(httpMethod),
      ...(category === 'resource' ? {
        resource: inferTeamResource(route, httpMethod),
        action: ['GET', 'HEAD', 'OPTIONS'].includes(httpMethod) ? 'read' as const : 'write' as const,
      } : {}),
      ...(key === '/api/team/auth/change-password POST' || key === '/api/team/auth/logout POST'
        ? { allowMustChangePassword: true } : {}),
    };
  }),
);

export function teamRoutePolicy(route: string, method: string): TeamRoutePolicy {
  const policy = TEAM_ROUTE_POLICIES.find((entry) => entry.route === route && entry.method === method);
  if (!policy) throw new Error(`未分类的团队路由: ${route} ${method}`);
  return policy;
}
