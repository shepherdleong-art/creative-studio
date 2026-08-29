import type Database from 'better-sqlite3';
import { defaultTextStyle, normalizeTextStyle } from '../media-core/cover-domain.ts';
import type { TextStyle } from '../media-core/cover-types.ts';

/** defaultsJson 中冻结的批量字幕样式字段。 */
export const BATCH_SUBTITLE_STYLES_KEY = 'subtitleStyles';
export const BATCH_SUBTITLE_STYLES_BY_SCRIPT_KEY = 'subtitleStylesByScript';

export interface BatchSubtitleStyleSettings {
  /** 整批基准样式；即使 defaultsJson 缺字段也始终提供安全默认值。 */
  style: TextStyle;
  /** sourceScriptId → 完整覆盖样式。坏条目会被忽略。 */
  stylesByScript: Record<string, TextStyle>;
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function outputWidthForPreset(value: unknown): number {
  const preset = typeof value === 'string' ? value : '';
  return preset === '16:9' || preset === '16x9' ? 1920 : 1080;
}

/**
 * 解析冻结字幕样式。这个 resolver 必须容忍旧版本 defaultsJson、坏 JSON
 * 以及被删除的脚本覆盖，渲染/预览都只能安全回落，不能因样式阻塞整批。
 */
export function resolveBatchSubtitleStyleSettings(
  defaults: unknown,
  outputWidth = 1080,
): BatchSubtitleStyleSettings {
  const root = asRecord(defaults);
  const fallback = defaultTextStyle('subtitle', outputWidth);
  if (!root) return { style: fallback, stylesByScript: {} };

  const style = normalizeTextStyle(root[BATCH_SUBTITLE_STYLES_KEY], fallback);
  const rawByScript = asRecord(root[BATCH_SUBTITLE_STYLES_BY_SCRIPT_KEY]);
  const stylesByScript: Record<string, TextStyle> = {};
  if (rawByScript) {
    for (const [scriptId, entry] of Object.entries(rawByScript)) {
      if (!scriptId || !asRecord(entry)) continue;
      stylesByScript[scriptId] = normalizeTextStyle(entry, style);
    }
  }
  return { style, stylesByScript };
}

export function resolveBatchSubtitleStyle(
  defaults: unknown,
  outputWidth = 1080,
  sourceScriptId?: string | null,
): TextStyle {
  const settings = resolveBatchSubtitleStyleSettings(defaults, outputWidth);
  return sourceScriptId && settings.stylesByScript[sourceScriptId]
    ? settings.stylesByScript[sourceScriptId]
    : settings.style;
}

/**
 * 解析成片 arrangement.subtitle.style 的单条覆盖。批量脚本步骤里的样式
 * 仍是冻结基准；检查成片只覆盖当前 plan，不回写整批 defaultsJson。
 */
export function resolveBatchSubtitleStyleOverride(
  frozenStyle: TextStyle,
  subtitleValue: unknown,
): TextStyle {
  const subtitle = asRecord(subtitleValue);
  return normalizeTextStyle(subtitle?.style, frozenStyle);
}

export function hasBatchSubtitleStyleOverride(subtitleValue: unknown): boolean {
  const subtitle = asRecord(subtitleValue);
  return Boolean(subtitle && Object.prototype.hasOwnProperty.call(subtitle, 'style'));
}

/** 从输出计划谱系读取冻结样式；查询失败时返回 null，由调用方走默认值。 */
export function loadFrozenSubtitleStyle(
  db: Database.Database,
  planId: string,
  outputWidth?: number,
): TextStyle | null {
  const row = db.prepare(`
    SELECT s.sourceScriptId AS sourceScriptId, v.defaultsJson AS defaultsJson
    FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    WHERE p.id = ?
  `).get(planId) as { sourceScriptId: string; defaultsJson: string } | undefined;
  if (!row) return null;
  let defaults: unknown = null;
  try {
    defaults = JSON.parse(row.defaultsJson) as unknown;
  } catch {
    defaults = null;
  }
  const root = asRecord(defaults);
  const width = outputWidth ?? outputWidthForPreset(root?.outputPreset ?? root?.preset);
  return resolveBatchSubtitleStyle(defaults, width, row.sourceScriptId);
}
