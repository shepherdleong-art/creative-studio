import type Database from 'better-sqlite3';
import type { AuthPrincipal } from './auth/types.ts';
import { registerTaskPrincipal } from './task-principals.ts';
import type { AccessActor } from '../media-core/access-context.ts';
import {
  type ResourceAccessAction,
  type ResourceAccessContext,
  type ResourceRef,
  type RootScopeRegistration,
  type InheritedScopeRegistration,
  type TaskPrincipalRegistration,
} from '../media-core/access-context.ts';

export type ResourceVisibility = 'private' | 'public';

export interface TeamResourceScope extends ResourceRef {
  ownerUserId: string;
  visibility: ResourceVisibility;
  parentType: string | null;
  parentId: string | null;
  rootType: string;
  rootId: string;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ResourceAccessError extends Error {
  readonly code: 'resource_not_found' | 'resource_forbidden' | 'scope_missing' | 'scope_inconsistent';
  readonly status: number;

  constructor(
    code: 'resource_not_found' | 'resource_forbidden' | 'scope_missing' | 'scope_inconsistent',
    message: string,
    status = code === 'resource_forbidden' ? 403 : 404,
  ) {
    super(message);
    this.name = 'ResourceAccessError';
    this.code = code;
    this.status = status;
  }
}

interface ResourceRelation {
  table: string;
  select: string;
  parentType: (row: Record<string, unknown>) => string | null;
  parentId: (row: Record<string, unknown>) => string | null;
  projectId?: (row: Record<string, unknown>) => string | null;
}

const ROOT_RELATIONS: Record<string, { table: string }> = {
  project: { table: 'projects' },
  canvas: { table: 'creative_canvases' },
  video_prompt_template: { table: 'video_prompt_templates' },
  bgm: { table: 'final_edit_bgm_tracks' },
  title_preset: { table: 'final_edit_title_presets' },
  script_catalog: { table: 'script_studio_catalogs' },
  viral_template_library: { table: 'script_studio_viral_tpl_libraries' },
};

const RESOURCE_RELATIONS: Record<string, ResourceRelation> = {
  image: {
    table: 'image_assets', select: 'projectId',
    parentType: (row) => row.projectId ? 'project' : null,
    parentId: (row) => row.projectId ? String(row.projectId) : null,
  },
  job: {
    table: 'jobs', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  video_job: {
    table: 'video_jobs', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  shot_set: {
    table: 'shot_sets', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  shot: {
    table: 'shots', select: 'shotSetId',
    parentType: () => 'shot_set', parentId: (row) => String(row.shotSetId),
  },
  scene_reference: {
    table: 'scene_references', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  video_reference_asset: {
    table: 'video_reference_assets', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  canvas_asset: {
    table: 'creative_canvas_assets', select: 'canvasId',
    parentType: () => 'canvas', parentId: (row) => String(row.canvasId),
  },
  canvas_run: {
    table: 'creative_canvas_runs', select: 'canvasId',
    parentType: () => 'canvas', parentId: (row) => String(row.canvasId),
  },
  canvas_task: {
    table: 'creative_canvas_tasks', select: 'canvasId',
    parentType: () => 'canvas', parentId: (row) => String(row.canvasId),
  },
  canvas_export: {
    table: 'creative_canvas_exports', select: 'canvasId',
    parentType: () => 'canvas', parentId: (row) => String(row.canvasId),
  },
  batch: {
    table: 'batch_productions', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  batch_asset: {
    table: 'batch_assets', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  batch_script: {
    table: 'batch_scripts', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  batch_version: {
    table: 'batch_production_versions', select: 'batchId',
    parentType: () => 'batch', parentId: (row) => String(row.batchId),
  },
  batch_plan: {
    table: 'batch_output_plans', select: 'batchVersionId',
    parentType: () => 'batch_version', parentId: (row) => String(row.batchVersionId),
  },
  batch_output_version: {
    table: 'batch_output_versions', select: 'planId',
    parentType: () => 'batch_plan', parentId: (row) => String(row.planId),
  },
  batch_artifact: {
    table: 'batch_artifacts', select: 'outputPlanId, projectId',
    parentType: () => 'batch_plan', parentId: (row) => String(row.outputPlanId),
    projectId: (row) => String(row.projectId),
  },
  batch_task: {
    table: 'batch_tasks', select: 'projectId, batchId',
    parentType: (row) => row.batchId ? 'batch' : 'project',
    parentId: (row) => String(row.batchId || row.projectId),
    projectId: (row) => String(row.projectId),
  },
  lut: {
    table: 'batch_luts', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  batch_analysis: {
    table: 'batch_asset_analysis', select: 'assetId',
    parentType: () => 'batch_asset', parentId: (row) => String(row.assetId),
  },
  final_group: {
    table: 'final_edit_groups', select: 'projectId, shotSetId',
    parentType: () => 'shot_set', parentId: (row) => String(row.shotSetId),
    projectId: (row) => String(row.projectId),
  },
  final_variant: {
    table: 'final_edit_variants', select: 'groupId',
    parentType: () => 'final_group', parentId: (row) => String(row.groupId),
  },
  final_job: {
    table: 'final_edit_jobs', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  final_proposal: {
    table: 'final_edit_proposals', select: 'variantId',
    parentType: () => 'final_variant', parentId: (row) => String(row.variantId),
  },
  final_external_asset: {
    table: 'final_edit_external_assets', select: 'projectId, shotSetId',
    parentType: () => 'shot_set', parentId: (row) => String(row.shotSetId),
    projectId: (row) => String(row.projectId),
  },
  script_draft: {
    table: 'script_drafts', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  project_artifact: {
    table: 'project_artifacts', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  script_studio_task: {
    table: 'script_studio_tasks', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  project_script: {
    table: 'project_scripts', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  script_source_set: {
    table: 'script_studio_source_sets', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  script_library: {
    table: 'script_studio_libraries', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  script_distilled_point: {
    table: 'script_studio_distilled_points', select: 'projectId',
    parentType: () => 'project', parentId: (row) => String(row.projectId),
  },
  script_library_revision: {
    table: 'script_studio_library_revisions', select: 'libraryId',
    parentType: () => 'script_library', parentId: (row) => String(row.libraryId),
  },
  project_script_revision: {
    table: 'project_script_revisions', select: 'scriptId',
    parentType: () => 'project_script', parentId: (row) => String(row.scriptId),
  },
  script_catalog_revision: {
    table: 'script_studio_catalog_revisions', select: 'catalogId',
    parentType: () => 'script_catalog', parentId: (row) => String(row.catalogId),
  },
  script_template_asset: {
    table: 'script_studio_template_assets', select: 'revisionId',
    parentType: () => 'script_catalog_revision', parentId: (row) => String(row.revisionId),
  },
  viral_template_revision: {
    table: 'script_studio_viral_tpl_revisions', select: 'libraryId',
    parentType: () => 'viral_template_library', parentId: (row) => String(row.libraryId),
  },
  viral_template_entry: {
    table: 'script_studio_viral_tpl_entries', select: 'revisionId',
    parentType: () => 'viral_template_revision', parentId: (row) => String(row.revisionId),
  },
};

function now(): string {
  return new Date().toISOString();
}

function readScope(db: Database.Database, resourceType: string, resourceId: string): TeamResourceScope | undefined {
  return db.prepare(`
    SELECT * FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?
  `).get(resourceType, resourceId) as TeamResourceScope | undefined;
}

function readActualParent(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
): { parentType: string | null; parentId: string | null; rootType?: string; projectId?: string | null } | null | undefined {
  const root = ROOT_RELATIONS[resourceType];
  if (root) {
    const row = db.prepare(`SELECT id FROM ${root.table} WHERE id = ?`).get(resourceId);
    return row ? { parentType: null, parentId: null, rootType: resourceType } : null;
  }
  const relation = RESOURCE_RELATIONS[resourceType];
  if (!relation) return undefined;
  const row = db.prepare(`SELECT ${relation.select} FROM ${relation.table} WHERE id = ?`).get(resourceId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    parentType: relation.parentType(row),
    parentId: relation.parentId(row),
    projectId: relation.projectId?.(row),
  };
}

export function assertScopeConsistency(
  db: Database.Database,
  resourceType: string,
  resourceId: string,
): TeamResourceScope {
  const scope = readScope(db, resourceType, resourceId);
  if (!scope) throw new ResourceAccessError('scope_missing', '资源缺少归属登记。');
  const actual = readActualParent(db, resourceType, resourceId);
  if (actual === null) throw new ResourceAccessError('scope_inconsistent', '资源归属与真实实体不一致。');
  if (!actual) return scope;
  if (scope.parentType !== actual.parentType || scope.parentId !== actual.parentId) {
    throw new ResourceAccessError('scope_inconsistent', '资源父级归属不一致。');
  }
  if (actual.rootType && (scope.rootType !== actual.rootType || scope.rootId !== resourceId)) {
    throw new ResourceAccessError('scope_inconsistent', '资源根归属不一致。');
  }
  if (actual.projectId !== undefined && (scope.rootType !== 'project' || scope.rootId !== actual.projectId)) {
    throw new ResourceAccessError('scope_inconsistent', '资源项目归属不一致。');
  }
  if (scope.parentType && scope.parentId) {
    const parent = readScope(db, scope.parentType, scope.parentId);
    if (!parent || parent.rootType !== scope.rootType || parent.rootId !== scope.rootId
      || parent.ownerUserId !== scope.ownerUserId) {
      throw new ResourceAccessError('scope_inconsistent', '资源继承链不一致。');
    }
  }
  return scope;
}

function assertEntityCanRegister(db: Database.Database, input: ResourceRef, parent: ResourceRef | null): void {
  const actual = readActualParent(db, input.resourceType, input.resourceId);
  if (actual === null) throw new ResourceAccessError('resource_not_found', '资源实体不存在。');
  if (!actual) return;
  if (actual.parentType !== parent?.resourceType || actual.parentId !== parent?.resourceId) {
    if (!parent && actual.parentType === null && actual.parentId === null) return;
    throw new ResourceAccessError('scope_inconsistent', '登记父级与真实资源关系不一致。');
  }
}

export function registerRootScope(
  db: Database.Database,
  input: RootScopeRegistration,
): TeamResourceScope {
  if (!input.resourceType.trim() || !input.resourceId.trim() || !input.ownerUserId.trim()) {
    throw new ResourceAccessError('scope_inconsistent', '根资源归属字段不完整。');
  }
  assertEntityCanRegister(db, input, null);
  const at = now();
  db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility,
      parentType, parentId, rootType, rootId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
  `).run(
    input.resourceType, input.resourceId, input.ownerUserId, input.visibility ?? 'private',
    input.resourceType, input.resourceId, at, at,
  );
  return readScope(db, input.resourceType, input.resourceId)!;
}

export function registerInheritedScope(
  db: Database.Database,
  input: InheritedScopeRegistration & { ownerUserId?: string; visibility?: ResourceVisibility },
): TeamResourceScope {
  const parent = assertScopeConsistency(db, input.parent.resourceType, input.parent.resourceId);
  if (parent.deletedAt) throw new ResourceAccessError('resource_not_found', '父资源不可用。');
  const existing = readScope(db, input.resourceType, input.resourceId);
  if (existing) {
    const consistent = assertScopeConsistency(db, input.resourceType, input.resourceId);
    if (consistent.parentType !== input.parent.resourceType || consistent.parentId !== input.parent.resourceId) {
      throw new ResourceAccessError('scope_inconsistent', '继承资源父级不可改写。');
    }
    return consistent;
  }
  assertEntityCanRegister(db, input, input.parent);
  const ownerUserId = input.ownerUserId ?? parent.ownerUserId;
  if (ownerUserId !== parent.ownerUserId) {
    throw new ResourceAccessError('scope_inconsistent', '继承资源所有者必须与根资源一致。');
  }
  const at = now();
  db.prepare(`
    INSERT INTO team_resource_scopes (
      resourceType, resourceId, ownerUserId, visibility,
      parentType, parentId, rootType, rootId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.resourceType, input.resourceId, ownerUserId, input.visibility ?? 'private',
    input.parent.resourceType, input.parent.resourceId, parent.rootType, parent.rootId, at, at,
  );
  return readScope(db, input.resourceType, input.resourceId)!;
}

export function bindImageScopeToProject(
  db: Database.Database,
  imageId: string,
  projectId: string,
  ownerUserId: string,
): void {
  const imageScope = readScope(db, 'image', imageId);
  if (!imageScope) throw new ResourceAccessError('scope_missing', '素材缺少归属登记。');
  const projectScope = assertScopeConsistency(db, 'project', projectId);
  if (imageScope.ownerUserId !== ownerUserId || projectScope.ownerUserId !== ownerUserId) {
    throw new ResourceAccessError('resource_forbidden', '未绑定素材只能由所属用户认领。', 403);
  }
  if (imageScope.parentId && (imageScope.parentType !== 'project' || imageScope.parentId !== projectId)) {
    throw new ResourceAccessError('resource_forbidden', '素材已属于其他项目。', 403);
  }
  db.prepare(`
    UPDATE team_resource_scopes
    SET parentType = 'project', parentId = ?, rootType = 'project', rootId = ?, updatedAt = ?
    WHERE resourceType = 'image' AND resourceId = ?
  `).run(projectId, projectId, now(), imageId);
  assertScopeConsistency(db, 'image', imageId);
}

export function scopeDescendsFrom(
  db: Database.Database,
  scope: TeamResourceScope,
  ancestor: TeamResourceScope,
): boolean {
  let current: TeamResourceScope | undefined = scope;
  const seen = new Set<string>();
  while (current) {
    const key = `${current.resourceType}:${current.resourceId}`;
    if (key === `${ancestor.resourceType}:${ancestor.resourceId}`) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!current.parentType || !current.parentId) return false;
    current = readScope(db, current.parentType, current.parentId);
  }
  return false;
}

export function requireResourceAccess(
  db: Database.Database,
  principal: AuthPrincipal,
  resourceType: string,
  resourceId: string,
  action: ResourceAccessAction,
): TeamResourceScope {
  let scope: TeamResourceScope;
  try {
    scope = assertScopeConsistency(db, resourceType, resourceId);
  } catch (error) {
    if (error instanceof ResourceAccessError && error.code === 'scope_missing') {
      throw new ResourceAccessError('resource_not_found', '资源不存在或不可用。');
    }
    throw error;
  }
  if (scope.deletedAt) throw new ResourceAccessError('resource_not_found', '资源不存在或不可用。');
  if (principal.role === 'admin' || scope.ownerUserId === principal.userId) return scope;
  if (action === 'read' && scope.visibility === 'public') return scope;
  throw new ResourceAccessError('resource_forbidden', '无权访问此资源。', 403);
}

export function requireProjectAccess(
  db: Database.Database,
  principal: AuthPrincipal,
  projectId: string,
  action: ResourceAccessAction,
): TeamResourceScope {
  return requireResourceAccess(db, principal, 'project', projectId, action);
}

export function requireCanvasAccess(
  db: Database.Database,
  principal: AuthPrincipal,
  canvasId: string,
  action: ResourceAccessAction,
): TeamResourceScope {
  return requireResourceAccess(db, principal, 'canvas', canvasId, action);
}

export function createTeamAccessContext(options: {
  db: Database.Database;
  principal: AuthPrincipal;
}): ResourceAccessContext {
  const { db, principal } = options;
  return {
    kind: 'team',
    actor: { userId: principal.userId, role: principal.role },
    assertAccess(resourceType, resourceId, action) {
      requireResourceAccess(db, principal, resourceType, resourceId, action);
    },
    resolveOwner(requestedOwnerUserId) {
      return resolveOwnerUserId(principal, requestedOwnerUserId);
    },
    registerRootScope(input) {
      registerRootScope(db, input);
    },
    registerInheritedScope(input) {
      registerInheritedScope(db, input);
    },
    registerTaskPrincipal(input: TaskPrincipalRegistration) {
      registerTaskPrincipal(db, { ...input, actorUserId: input.actorUserId ?? principal.userId });
    },
  };
}

export function resolveOwnerUserId(principal: AccessActor, requestedOwnerUserId?: unknown): string {
  if (requestedOwnerUserId === undefined || requestedOwnerUserId === null || requestedOwnerUserId === '') {
    return principal.userId;
  }
  if (principal.role !== 'admin' || typeof requestedOwnerUserId !== 'string' || !requestedOwnerUserId.trim()) {
    throw new ResourceAccessError('resource_forbidden', '只有管理员可以指定其他资源所有者。', 403);
  }
  return requestedOwnerUserId;
}
