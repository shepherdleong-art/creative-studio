import fsp from 'node:fs/promises';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { coverFramingGeometry } from '../final-edit/cover-framing.ts';
import { defaultTextStyle, normalizeTextStyle } from '../final-edit/domain.ts';
import { cleanFraming } from '../final-edit/title-presets.ts';
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

/** SVG 文本转义。batch-renderer 的字幕图层与本模块共用这一份实现。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

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

const FONT_FALLBACK_STACK = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif';
const CJK_WIDE_CHAR = /[ᄀ-ᅟ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 单行近似行宽:CJK 按字号、拉丁按 0.55 倍字号估算。 */
function estimateSingleLineWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += CJK_WIDE_CHAR.test(char) ? fontSize : fontSize * 0.55;
  return width;
}

/**
 * TextStyle → SVG `<text>` 元素串(阴影开启时含偏移下层)。
 * 服务端单行近似:文本按 boxWidthPx 估算行宽,超限时等比缩字号到刚好放下
 * (下限 0.5 倍,缩不下就保持 0.5 倍),不做多行折行。
 */
export function textStyleToSvgElements(style: TextStyle, text: string, outputSize: { width: number; height: number }): string {
  const x = style.x * outputSize.width;
  const y = style.y * outputSize.height;
  const anchor = style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle';
  let fontSize = style.fontSizePx * (style.scale ?? 1);
  if (text && style.boxWidthPx > 0) {
    const estimated = estimateSingleLineWidth(text, fontSize);
    if (estimated > style.boxWidthPx) fontSize *= Math.max(0.5, style.boxWidthPx / estimated);
  }
  const fontFamily = `${style.fontFamily}, ${FONT_FALLBACK_STACK}`;
  const italicAttr = style.italic ? ' font-style="italic"' : '';
  const strokeAttr = style.stroke.enabled && style.stroke.widthPx > 0
    ? ` stroke="${escapeXml(style.stroke.color)}" stroke-width="${round2(style.stroke.widthPx)}" stroke-linejoin="round" paint-order="stroke fill"`
    : '';
  const escapedText = escapeXml(text);
  const textElement = (px: number, py: number, fill: string, opacityAttr: string) =>
    `<text x="${Math.round(px)}" y="${Math.round(py)}" text-anchor="${anchor}" font-family="${escapeXml(fontFamily)}" font-size="${round2(fontSize)}"${italicAttr} fill="${fill}"${opacityAttr}${strokeAttr}>${escapedText}</text>`;
  const body = textElement(x, y, escapeXml(style.color), '');
  if (!style.shadow.enabled) return body;
  // librsvg 的滤镜(模糊)支持有限,阴影用两层同内容 text 近似:下层按
  // (distancePx, angleDeg) 极坐标偏移、带透明度,忽略 blurPx;描边与正文一致,
  // 保持视觉厚度一致。
  const radians = style.shadow.angleDeg * Math.PI / 180;
  const dx = Math.cos(radians) * style.shadow.distancePx;
  const dy = Math.sin(radians) * style.shadow.distancePx;
  return textElement(x + dx, y + dy, escapeXml(style.shadow.color), ` fill-opacity="${round2(style.shadow.opacity)}"`) + body;
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
