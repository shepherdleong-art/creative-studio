import type Database from 'better-sqlite3';
import { runWithAccessContext } from '../media-core/access-context.ts';
import { ensureBundledViralPresets } from '../script-studio/bundled-viral-presets.ts';
import type { AuthPrincipal } from './auth/types.ts';
import {
  createTeamAccessContext,
  registerInheritedScope,
  registerRootScope,
} from './resource-scopes.ts';

function hasScope(db: Database.Database, resourceType: string, resourceId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?').get(resourceType, resourceId));
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

/** 首管理员初始化时登记明确的内置公共目录；不上传或共享任何员工私人资源。 */
export async function publishBuiltinResources(db: Database.Database, principal: AuthPrincipal): Promise<void> {
  if (tableExists(db, 'video_prompt_templates')) {
    for (const row of db.prepare('SELECT id FROM video_prompt_templates WHERE isBuiltin = 1').all() as Array<{ id: string }>) {
      if (!hasScope(db, 'video_prompt_template', row.id)) {
        registerRootScope(db, { resourceType: 'video_prompt_template', resourceId: row.id, ownerUserId: principal.userId, visibility: 'public' });
      }
    }
  }
  if (tableExists(db, 'final_edit_title_presets')) {
    for (const row of db.prepare('SELECT id FROM final_edit_title_presets').all() as Array<{ id: string }>) {
      if (!hasScope(db, 'title_preset', row.id)) {
        registerRootScope(db, { resourceType: 'title_preset', resourceId: row.id, ownerUserId: principal.userId, visibility: 'public' });
      }
    }
  }
  if (tableExists(db, 'script_studio_catalogs')) {
    for (const catalog of db.prepare('SELECT id FROM script_studio_catalogs').all() as Array<{ id: string }>) {
      if (!hasScope(db, 'script_catalog', catalog.id)) {
        registerRootScope(db, { resourceType: 'script_catalog', resourceId: catalog.id, ownerUserId: principal.userId, visibility: 'public' });
      }
    }
  }
  if (tableExists(db, 'script_studio_catalog_revisions')) {
    for (const revision of db.prepare('SELECT id, catalogId FROM script_studio_catalog_revisions').all() as Array<{ id: string; catalogId: string }>) {
      if (!hasScope(db, 'script_catalog_revision', revision.id)) {
        registerInheritedScope(db, {
          resourceType: 'script_catalog_revision', resourceId: revision.id,
          parent: { resourceType: 'script_catalog', resourceId: revision.catalogId }, visibility: 'public',
        });
      }
    }
  }
  if (tableExists(db, 'script_studio_template_assets')) {
    for (const asset of db.prepare('SELECT id, revisionId FROM script_studio_template_assets').all() as Array<{ id: string; revisionId: string }>) {
      if (!hasScope(db, 'script_template_asset', asset.id)) {
        registerInheritedScope(db, {
          resourceType: 'script_template_asset', resourceId: asset.id,
          parent: { resourceType: 'script_catalog_revision', resourceId: asset.revisionId }, visibility: 'public',
        });
      }
    }
  }
  if (tableExists(db, 'script_studio_viral_tpl_libraries')) {
    for (const library of db.prepare('SELECT id FROM script_studio_viral_tpl_libraries').all() as Array<{ id: string }>) {
      if (!hasScope(db, 'viral_template_library', library.id)) {
        registerRootScope(db, { resourceType: 'viral_template_library', resourceId: library.id, ownerUserId: principal.userId, visibility: 'public' });
      }
    }
  }
  if (tableExists(db, 'script_studio_viral_tpl_revisions')) {
    for (const revision of db.prepare('SELECT id, libraryId FROM script_studio_viral_tpl_revisions').all() as Array<{ id: string; libraryId: string }>) {
      if (!hasScope(db, 'viral_template_revision', revision.id)) {
        registerInheritedScope(db, {
          resourceType: 'viral_template_revision', resourceId: revision.id,
          parent: { resourceType: 'viral_template_library', resourceId: revision.libraryId }, visibility: 'public',
        });
      }
    }
  }
  if (tableExists(db, 'script_studio_viral_tpl_entries')) {
    for (const entry of db.prepare('SELECT id, revisionId FROM script_studio_viral_tpl_entries').all() as Array<{ id: string; revisionId: string }>) {
      if (!hasScope(db, 'viral_template_entry', entry.id)) {
        registerInheritedScope(db, {
          resourceType: 'viral_template_entry', resourceId: entry.id,
          parent: { resourceType: 'viral_template_revision', resourceId: entry.revisionId }, visibility: 'public',
        });
      }
    }
  }
  await runWithAccessContext(createTeamAccessContext({ db, principal }), () => ensureBundledViralPresets(db));
}
