import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { resolveStoragePath } from '../media-core/storage-path.ts';
import type { AuthPrincipal } from './auth/types.ts';

function managedFileAvailable(relativePath: string): boolean {
  try {
    const file = resolveStoragePath(dataRoot(), relativePath);
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export type NonVersionedResourceType = 'video_prompt_template' | 'title_preset' | 'lut' | 'bgm';

export interface PublicResourceCandidate {
  resourceType: NonVersionedResourceType;
  resourceId: string;
  typeLabel: string;
  name: string;
  preview: string;
  sourceInfo: string;
  published: boolean;
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
  // 管理员在既有项目权限边界内处理 LUT；候选自己的 visibility 决定待发布状态。
  // 尚未公开的根资源只向所有者展示，不能泄露其他员工的私人模板或音乐。
  const tableExists = (table: string) => Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
  const lutJoin = tableExists('batch_luts')
    ? 'LEFT JOIN batch_luts lut ON scope.resourceType = \'lut\' AND lut.id = scope.resourceId' : '';
  return db.prepare(`
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
  `).all(principal.userId).flatMap((value) => {
    const row = value as Record<string, unknown>;
    const resourceType = String(row.resourceType) as NonVersionedResourceType;
    const base = {
      resourceType,
      resourceId: String(row.resourceId),
      published: row.visibility === 'public',
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
}
