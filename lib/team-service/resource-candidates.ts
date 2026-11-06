import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { resolveStoragePath } from '../media-core/storage-path.ts';
import type { AuthPrincipal } from './auth/types.ts';
import { findTeamVersionedRoot } from '../script-studio/team-publications.ts';

function managedFileAvailable(relativePath: string): boolean {
  try {
    const file = resolveStoragePath(dataRoot(), relativePath);
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export type NonVersionedResourceType = 'video_prompt_template' | 'title_preset' | 'lut' | 'bgm';
export type VersionedResourceType = 'script_catalog_revision' | 'viral_template_revision';

export interface PublicResourceCandidate {
  resourceType: NonVersionedResourceType | VersionedResourceType;
  resourceId: string;
  typeLabel: string;
  name: string;
  preview: string;
  sourceInfo: string;
  sourceFilename: string;
  published: boolean;
  previouslyPublished: boolean;
  currentRevisionId: string | null;
  revisionNumber: number | null;
  entryCount: number | null;
  parseStatus: 'ready' | 'failed';
  settingsHref: string;
}

export const NON_VERSIONED_RESOURCE_TYPES = new Set<NonVersionedResourceType>([
  'video_prompt_template', 'title_preset', 'lut', 'bgm',
]);

/** 06 需要库、修订与条目的原子发布，不能退回旧库根可见性开关。 */
export const VERSIONED_RESOURCE_TYPES = new Set([
  'script_catalog', 'script_catalog_revision', 'script_template_asset',
  'viral_template_library', 'viral_template_revision', 'viral_template_entry',
]);

/**
 * 读取既有受管实体及同一份 scope，不复制内容。员工永不应通过此管理查询
 * 发现其他人的私人资源；调用路由和管理页都必须验证 admin。
 */
export function listPublicResourceCandidates(
  db: Database.Database,
  principal: AuthPrincipal,
): PublicResourceCandidate[] {
  if (principal.role !== 'admin') return [];
  const versioned = listVersionedCandidates(db, principal.userId);
  // 管理员在既有项目权限边界内处理 LUT；候选自己的 visibility 决定待发布状态。
  // 尚未公开的根资源只向所有者展示，不能泄露其他员工的私人模板或音乐。
  const tableExists = (table: string) => Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
  const lutJoin = tableExists('batch_luts')
    ? 'LEFT JOIN batch_luts lut ON scope.resourceType = \'lut\' AND lut.id = scope.resourceId' : '';
  const nonVersioned = db.prepare(`
    SELECT scope.resourceType, scope.resourceId, scope.visibility,
      template.name AS templateName, template.description AS templateDescription,
      template.prompt AS templatePrompt,
      preset.name AS presetName, preset.stylesByPresetJson AS presetStyles,
      ${lutJoin ? 'lut.displayName AS lutName, lut.relativePath AS lutPath, lut.status AS lutStatus,' : 'NULL AS lutName, NULL AS lutPath, NULL AS lutStatus,'}
      bgm.relativePath AS bgmPath, bgm.status AS bgmStatus
    FROM team_resource_scopes scope
    LEFT JOIN video_prompt_templates template
      ON scope.resourceType = 'video_prompt_template' AND template.id = scope.resourceId
    LEFT JOIN final_edit_title_presets preset
      ON scope.resourceType = 'title_preset' AND preset.id = scope.resourceId
    ${lutJoin}
    LEFT JOIN final_edit_bgm_tracks bgm ON scope.resourceType = 'bgm' AND bgm.id = scope.resourceId
    WHERE scope.deletedAt IS NULL
      AND (scope.ownerUserId = ? OR scope.visibility = 'public'
        OR (scope.resourceType = 'lut' AND scope.parentType = 'project'))
      AND scope.resourceType IN ('video_prompt_template', 'title_preset', 'lut', 'bgm')
    ORDER BY scope.resourceType, scope.updatedAt DESC, scope.resourceId
  `).all(principal.userId).flatMap((value): PublicResourceCandidate[] => {
    const row = value as Record<string, unknown>;
    const resourceType = String(row.resourceType) as NonVersionedResourceType;
    const base = {
      resourceType,
      resourceId: String(row.resourceId),
      published: row.visibility === 'public',
      previouslyPublished: row.visibility === 'public',
      sourceFilename: '', currentRevisionId: null, revisionNumber: null,
      entryCount: null, parseStatus: 'ready' as const,
    };
    if (resourceType === 'video_prompt_template') {
      if (typeof row.templateName !== 'string') return [];
      return [{
        ...base, typeLabel: '视频提示词模板', name: row.templateName,
        preview: String(row.templatePrompt || row.templateDescription || ''),
        sourceInfo: '视频提示词模板设置', settingsHref: '/settings?section=motion-template',
      }];
    }
    if (resourceType === 'title_preset') {
      if (typeof row.presetName !== 'string') return [];
      return [{
        ...base, typeLabel: '标题预设', name: row.presetName,
        preview: '封面标题样式预设', sourceInfo: '成片封面标题编辑器保存的预设',
        settingsHref: '/',
      }];
    }
    if (resourceType === 'lut') {
      if (typeof row.lutName !== 'string' || row.lutStatus !== 'active' || typeof row.lutPath !== 'string' || !managedFileAvailable(row.lutPath)) return [];
      return [{
        ...base, typeLabel: 'LUT', name: row.lutName,
        preview: '已验证的色彩转换，可在批量制作中选用',
        sourceInfo: String(row.lutPath || '受管 LUT 文件'), settingsHref: '/',
      }];
    }
    if (typeof row.bgmPath !== 'string' || row.bgmStatus !== 'ready' || !managedFileAvailable(`storage/${row.bgmPath}`)) return [];
    return [{
      ...base, typeLabel: 'BGM', name: row.bgmPath.split(/[\\/]/).at(-1) || row.bgmPath,
      preview: '可在公共 BGM 音乐库试听', sourceInfo: '公共 BGM 音乐库',
      settingsHref: '/team/admin/resources#public-bgm-heading',
    }];
  });
  return [...nonVersioned, ...versioned];
}

function listVersionedCandidates(db: Database.Database, adminUserId: string): PublicResourceCandidate[] {
  const catalogRows = db.prepare(`
    SELECT r.*, c.kind, c.ownerKey,
      (SELECT COUNT(*) FROM script_studio_strategy_entries e WHERE e.revisionId = r.id) AS strategyCount,
      (SELECT COUNT(*) FROM script_studio_framework_templates e WHERE e.revisionId = r.id) AS frameworkCount,
      (SELECT COUNT(*) FROM script_studio_copy_hook_templates e WHERE e.revisionId = r.id) AS copyCount,
      (SELECT COUNT(*) FROM script_studio_visual_hook_templates e WHERE e.revisionId = r.id) AS visualCount,
      (SELECT COUNT(*) FROM script_studio_template_assets a WHERE a.revisionId = r.id) AS assetCount,
      (SELECT COALESCE((SELECT e.canonicalName FROM script_studio_strategy_entries e WHERE e.revisionId = r.id ORDER BY e.normalizedModelKey LIMIT 1), '')) AS strategyPreview,
      (SELECT COALESCE((SELECT e.name FROM script_studio_framework_templates e WHERE e.revisionId = r.id ORDER BY e.sourceRow LIMIT 1), '')) AS frameworkPreview
    FROM script_studio_catalog_revisions r
    JOIN script_studio_catalogs c ON c.id = r.catalogId
    JOIN team_resource_scopes s ON s.resourceType = 'script_catalog_revision' AND s.resourceId = r.id
    WHERE (c.ownerKey = ? OR s.visibility = 'public') AND s.deletedAt IS NULL
    ORDER BY c.kind, r.revisionNumber DESC
  `).all(adminUserId) as Array<Record<string, unknown>>;
  const viralRows = db.prepare(`
    SELECT r.*, l.ownerKey,
      (SELECT COUNT(*) FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id) AS entryCount,
      (SELECT COALESCE((SELECT e.name FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id ORDER BY e.sourceRow LIMIT 1), '')) AS firstName,
      (SELECT COALESCE((SELECT e.refText FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id ORDER BY e.sourceRow LIMIT 1), '')) AS firstText
    FROM script_studio_viral_tpl_revisions r
    JOIN script_studio_viral_tpl_libraries l ON l.id = r.libraryId
    JOIN team_resource_scopes s ON s.resourceType = 'viral_template_revision' AND s.resourceId = r.id
    WHERE (l.ownerKey = ? OR s.visibility = 'public') AND s.deletedAt IS NULL
    ORDER BY r.revisionNumber DESC
  `).all(adminUserId) as Array<Record<string, unknown>>;
  const results: PublicResourceCandidate[] = [];
  for (const row of [...catalogRows, ...viralRows]) {
    const viral = typeof row.libraryId === 'string';
    const kind = viral ? 'viral' : String(row.kind) as 'strategy' | 'template';
    const team = findTeamVersionedRoot(db, kind);
    const currentRevisionId = team?.revisionId ?? null;
    const count = viral ? Number(row.entryCount) : kind === 'strategy' ? Number(row.strategyCount)
      : Number(row.frameworkCount) + Number(row.copyCount) + Number(row.visualCount);
    const preview = viral ? String(row.firstText || row.firstName)
      : kind === 'strategy' ? `${String(row.strategyPreview || '产品策略知识库')} · 型号匹配、统一名称与搜索词埋词`
        : `${String(row.frameworkPreview || '脚本模板库')} · 核心框架、文案钩子与画面钩子`;
    results.push({
      resourceType: viral ? 'viral_template_revision' : 'script_catalog_revision',
      resourceId: String(row.id),
      typeLabel: kind === 'strategy' ? '产品策略知识库' : kind === 'template' ? '脚本模板库' : '爆文模板',
      name: `${kind === 'strategy' ? '产品策略知识库' : kind === 'template' ? '脚本模板库' : '爆文模板'} v${Number(row.revisionNumber)}`,
      preview,
      sourceInfo: `源文件：${String(row.sourceFilename)} · 版本 v${Number(row.revisionNumber)} · ${count} 条`,
      sourceFilename: String(row.sourceFilename),
      published: currentRevisionId === String(row.id),
      previouslyPublished: (db.prepare(`SELECT visibility FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?`)
        .pluck().get(viral ? 'viral_template_revision' : 'script_catalog_revision', String(row.id)) as string) === 'public',
      currentRevisionId,
      revisionNumber: Number(row.revisionNumber),
      entryCount: count,
      parseStatus: count > 0 ? 'ready' : 'failed',
      settingsHref: '/settings?section=script-knowledge',
    });
  }
  return results.sort((a, b) => a.typeLabel.localeCompare(b.typeLabel, 'zh-CN') || (b.revisionNumber ?? 0) - (a.revisionNumber ?? 0));
}
