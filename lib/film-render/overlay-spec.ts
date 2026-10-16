import { isDeepStrictEqual } from 'node:util';
import { PACKAGING_TEMPLATE_IDS, sanitizePackagingLayouts, sanitizePackagingVarsOverrides, sanitizePointCues } from '../media-core/packaging-vars.ts';
import { requireInput } from './errors.ts';
import { projectFile } from './files.ts';
import { array, numeric, object, string } from './validation.ts';

export function allowedKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  requireInput(Object.keys(value).every(key => keys.includes(key)), 'INVALID_PACKAGING', `${label} 含不支持的字段`);
}

/** Specs are already normalized: never silently discard user-authored packaging. */
export function validateOverlayComposition(input: unknown): void {
  const s = object(input, '渲染单');
  const template = object(s.template, 'template');
  requireInput((PACKAGING_TEMPLATE_IDS as readonly unknown[]).includes(template.id), 'TEMPLATE_UNSUPPORTED', '未知包装模板');
  requireInput(s.classic === undefined, 'INVALID_PACKAGING', '叠层模板不支持 classic 标注、贴纸或片尾');
  const root = string(object(s.project, 'project').root, 'project.root');
  const cover = object(s.cover, 'cover');
  allowedKeys(cover, ['image'], 'cover');
  projectFile(root, string(cover.image, 'cover.image'));
  const p = object(s.packaging, 'packaging');
  allowedKeys(p, ['enabled', 'template', 'varsOverrides', 'pointCuesMode', 'pointCues', 'layouts'], 'packaging');
  requireInput(p.enabled === true && p.template === template.id, 'INVALID_PACKAGING', '包装必须启用且与 template.id 一致');
  const vars = object(p.varsOverrides, 'packaging.varsOverrides');
  allowedKeys(vars, ['title', 'subtitle', 'point1', 'point2', 'point3'], 'varsOverrides');
  requireInput(isDeepStrictEqual(vars, sanitizePackagingVarsOverrides(vars)), 'INVALID_PACKAGING', '包装文案含非法值或超过 100 字');
  requireInput(string(vars.title, 'title').trim().length > 0 && string(vars.subtitle, 'subtitle').trim().length > 0,
    'INVALID_PACKAGING', '主副标题必须非空');
  const cues = array(p.pointCues, 'pointCues');
  requireInput(isDeepStrictEqual(cues, sanitizePointCues(cues)), 'INVALID_PACKAGING', 'pointCues 必须已清洗且含稳定 ID');
  requireInput(p.pointCuesMode === (cues.length ? 'timed' : 'none'), 'INVALID_PACKAGING', '卖点须使用显式 timed 时序，无卖点时为 none');
  const totalSec = numeric(object(s.canvas, 'canvas').frames, 'frames') / 24;
  let end = 20 / 24;
  const ids = new Set<string>();
  for (const value of cues) {
    const cue = object(value, 'pointCue');
    const id = string(cue.id, 'cue.id');
    requireInput(/^[A-Za-z0-9_-]{1,24}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id) && !ids.has(id), 'INVALID_PACKAGING', '卖点 ID 无效或重复');
    ids.add(id);
    const start = numeric(cue.startSec, 'cue.startSec', end, totalSec);
    end = numeric(cue.endSec, 'cue.endSec', start, totalSec);
    requireInput(end > start, 'INVALID_PACKAGING', '卖点时序不能为空或重叠');
  }
  const layouts = object(p.layouts, 'layouts');
  requireInput(isDeepStrictEqual(layouts, sanitizePackagingLayouts(layouts)), 'INVALID_PACKAGING', '布局清洗后有变化');
  for (const value of Object.values(layouts)) {
    const cueLayouts = object(value, 'layout').cues;
    if (cueLayouts !== undefined) requireInput(Object.keys(object(cueLayouts, 'cue layouts')).every(id => ids.has(id)), 'INVALID_PACKAGING', '布局引用了不存在的卖点 ID');
  }
}
