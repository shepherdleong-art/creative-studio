import fsp from 'node:fs/promises';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { coverFramingGeometry } from '../final-edit/cover-framing.ts';
import { defaultTextStyle, normalizeTextStyle } from '../final-edit/domain.ts';
import { cleanFraming } from '../final-edit/title-presets.ts';
import { textStyleToSvgElements } from '../final-edit/title-svg.ts';
import type { CoverFraming, OutputPresetId, TextStyle } from '../final-edit/types.ts';

/** 批量输出比例键(冒号/双写两种写法) → 标题预设 stylesByPreset 键。 */
export const BATCH_PRESET_TO_COVER_PRESET_ID: Readonly<Record<string, OutputPresetId>> = {
  '3:4': '3x4',
  '3x4': '3x4',
  '9:16': '9x16',
  '9x16': '9x16',
  '16:9': '16x9',
  '16x9': '16x9',
};

// SVG 文本构造搬到 lib/final-edit/title-svg.ts(纯字符串、无 Node 依赖),
// 让封面预览组件也能 import 同一份实现;这里原样再导出,保持既有引用不变。
export { escapeXml, textStyleToSvgElements } from '../final-edit/title-svg.ts';

export type BatchCoverTitleMode = 'none' | 'preset' | 'custom';

export interface BatchCoverTitleSettings {
  mode: BatchCoverTitleMode;
  presetId: string | null;
  styles: { primary: TextStyle; secondary: TextStyle } | null;
  framing: CoverFraming | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 从版本 defaultsJson 解析冻结的封面标题设置。读取端必须容忍字段完全缺失
 * (写入端是 UI,可能还没写过封面字段):任何字段缺失/非法都安全回落,不抛错。
 * 样式由 UI 按当前画幅解析后整体写入;个别字段缺失时按 1080 宽画布补默认
 * (该宽度只影响 boxWidthPx 的兜底推导)。
 */
export function resolveBatchCoverTitleSettings(defaults: unknown): BatchCoverTitleSettings {
  const root = asRecord(defaults);
  if (!root) return { mode: 'none', presetId: null, styles: null, framing: null };
  const mode: BatchCoverTitleMode = root.coverTitleMode === 'preset' || root.coverTitleMode === 'custom'
    ? root.coverTitleMode
    : 'none';
  const presetId = typeof root.coverTitlePresetId === 'string' && root.coverTitlePresetId.trim()
    ? root.coverTitlePresetId
    : null;
  const stylesRaw = asRecord(root.coverTitleStyles);
  const styles = stylesRaw ? {
    primary: normalizeTextStyle(stylesRaw.primary, defaultTextStyle('coverPrimary', 1080)),
    secondary: normalizeTextStyle(stylesRaw.secondary, defaultTextStyle('coverSecondary', 1080)),
  } : null;
  const framing = root.coverTitleFraming == null ? null : cleanFraming(root.coverTitleFraming);
  return { mode, presetId, styles, framing };
}

/**
 * 把主/副标题按冻结样式合成到封面底图上,输出 JPEG (quality 92,与单条一致)。
 * framing 非空且 scale>1 或 offset 非 0 时先按 cover-framing 几何对底图
 * resize+extract;否则底图按 cover 语义规整到输出尺寸(防止抽帧产物尺寸抖动)。
 */
export async function composeBatchCoverTitle(input: {
  coverImage: Buffer;
  primary: string;
  secondary: string;
  styles: { primary: TextStyle; secondary: TextStyle };
  framing: CoverFraming | null;
  outputSize: { width: number; height: number };
}): Promise<Buffer> {
  const { width, height } = input.outputSize;
  const source = sharp(input.coverImage).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('batch-cover-title: 封面底图尺寸无效');
  const framing = input.framing;
  let base = source;
  if (framing && (framing.scale > 1 || framing.offsetX !== 0 || framing.offsetY !== 0)) {
    const geometry = coverFramingGeometry({
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      outputWidth: width,
      outputHeight: height,
      framing,
    });
    base = base
      .resize(geometry.resizedWidth, geometry.resizedHeight, { fit: 'fill' })
      .extract({ left: geometry.left, top: geometry.top, width, height });
  } else {
    base = base.resize(width, height, { fit: 'cover' });
  }
  const overlays: sharp.OverlayOptions[] = [];
  for (const layer of [
    { text: input.primary, style: input.styles.primary },
    { text: input.secondary, style: input.styles.secondary },
  ]) {
    if (!layer.text.trim()) continue;
    const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${textStyleToSvgElements(layer.style, layer.text, input.outputSize)}</svg>`;
    overlays.push({ input: await sharp(Buffer.from(svg)).png().toBuffer() });
  }
  return (overlays.length > 0 ? base.composite(overlays) : base).jpeg({ quality: 92 }).toBuffer();
}

export interface FrozenBatchCoverTitleConfig {
  primary: string;
  secondary: string;
  styles: { primary: TextStyle; secondary: TextStyle };
  framing: CoverFraming | null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

/**
 * 读冻结封面配置:planId → batch_output_plans.scriptSnapshotId →
 * batch_script_snapshots.coverTitleJson,加上 batchVersionId →
 * batch_production_versions.defaultsJson 的封面设置。mode 'none'、样式缺失或
 * 主标题为空时返回 null(不合成),任何 JSON 损坏也安全回落 null。
 */
export function loadFrozenCoverTitleConfig(db: Database.Database, planId: string): FrozenBatchCoverTitleConfig | null {
  const row = db.prepare(`
    SELECT s.coverTitleJson AS coverTitleJson, v.defaultsJson AS defaultsJson
    FROM batch_output_plans p
    JOIN batch_script_snapshots s ON s.id = p.scriptSnapshotId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    WHERE p.id = ?
  `).get(planId) as { coverTitleJson: string; defaultsJson: string } | undefined;
  if (!row) return null;
  const settings = resolveBatchCoverTitleSettings(parseJsonObject(row.defaultsJson));
  if (settings.mode === 'none' || !settings.styles) return null;
  const coverTitle = parseJsonObject(row.coverTitleJson);
  const primary = typeof coverTitle?.primary === 'string' ? coverTitle.primary.trim() : '';
  if (!primary) return null;
  const secondary = typeof coverTitle?.secondary === 'string' ? coverTitle.secondary : '';
  return { primary, secondary, styles: settings.styles, framing: settings.framing };
}

/**
 * 渲染接线点:plan 有冻结封面标题设置时,把主/副标题就地合成进封面文件
 * (覆盖传入的临时文件路径);无设置或无标题时不做任何事。返回是否发生合成。
 */
export async function applyFrozenCoverTitleToFile(
  db: Database.Database,
  planId: string,
  coverFilePath: string,
  outputSize: { width: number; height: number },
): Promise<boolean> {
  const config = loadFrozenCoverTitleConfig(db, planId);
  if (!config) return false;
  const composed = await composeBatchCoverTitle({
    coverImage: await fsp.readFile(coverFilePath),
    primary: config.primary,
    secondary: config.secondary,
    styles: config.styles,
    framing: config.framing,
    outputSize,
  });
  await fsp.writeFile(coverFilePath, composed);
  return true;
}
