// 贴纸领域模型：与卖点 pointCues 完全独立，纯函数、无副作用。
// 时间统一为最终时间线的 24fps 整帧；片头 20 帧不允许放置贴纸。
import type { PackagingTemplateId } from './packaging-vars.ts';

export const STICKER_FPS = 24 as const;
export const STICKER_INTRO_FRAMES = 20 as const;
export const STICKER_DEFAULT_DURATION_FRAMES = 48 as const;
export const STICKER_MIN_DURATION_FRAMES = 19 as const;
export const STICKER_AUTO_MIN_BODY_FRAMES = 144 as const;
export const MAX_STICKER_INSTANCES = 128 as const;

export const STICKER_STYLES = ['show', 'comic', 'journal', 'editorial'] as const;
export type StickerStyle = typeof STICKER_STYLES[number];
export const STICKER_ANIMATIONS = ['follow-template', 'soft', 'bounce', 'rise', 'slide', 'zoom', 'none'] as const;
export type StickerAnimation = typeof STICKER_ANIMATIONS[number];
export type StickerAnimationPresetId = Exclude<StickerAnimation, 'follow-template'>;

export const STICKER_COMMON_IDS = [
  'recommend', 'good_find', 'first_sight', 'something_special', 'home_surprise', 'look_here',
  'details', 'highlight', 'key_moment', 'another_angle', 'also_here', 'now_i_see',
  'cart', 'save', 'more_details', 'take_home', 'worth_a_look', 'home_love',
  'like', 'ok', 'finger_heart', 'point_left', 'point_right', 'present',
  'arrow_right', 'arrow_left', 'oval', 'round',
] as const;

export const STICKER_STYLE_BY_TEMPLATE: Record<PackagingTemplateId, StickerStyle> = {
  'overlay-poster': 'comic',
  'overlay-journal': 'journal',
  'overlay-minimal': 'editorial',
  'overlay-variety': 'show',
};

export const STICKER_ANIMATION_BY_TEMPLATE: Record<PackagingTemplateId, StickerAnimationPresetId> = {
  'overlay-poster': 'bounce',
  'overlay-journal': 'soft',
  'overlay-minimal': 'soft',
  'overlay-variety': 'bounce',
};

export const STICKER_ANIMATION_PRESETS: Record<StickerAnimationPresetId, { name: string; enterFrames: number; exitFrames: number }> = {
  soft: { name: '柔和', enterFrames: 7, exitFrames: 6 },
  bounce: { name: 'Q 弹', enterFrames: 9, exitFrames: 6 },
  rise: { name: '上浮', enterFrames: 8, exitFrames: 6 },
  slide: { name: '滑入', enterFrames: 8, exitFrames: 6 },
  zoom: { name: '缩放', enterFrames: 8, exitFrames: 6 },
  none: { name: '无动画', enterFrames: 0, exitFrames: 0 },
};

export type PackagingStickerInstance = {
  id: string;
  assetId: string;
  styleMode: 'follow-template' | 'fixed';
  fixedStyle: StickerStyle | null;
  startFrame: number;
  endFrame: number;
  centerXPct: number;
  centerYPct: number;
  visualWidthPct: number;
  rotationDeg: number;
  trackIndex: number;
  animation: StickerAnimation;
  origin:
    | { kind: 'manual' }
    | { kind: 'auto'; autoGroupId: string; autoEdited: boolean };
};

export type PackagingStickerDefaults = {
  animation: StickerAnimation;
};

export const DEFAULT_PACKAGING_STICKER_DEFAULTS: PackagingStickerDefaults = { animation: 'follow-template' };

const COMMON_ID_SET = new Set<string>(STICKER_COMMON_IDS);
const STYLE_SET = new Set<string>(STICKER_STYLES);
const ANIMATION_SET = new Set<string>(STICKER_ANIMATIONS);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class PackagingStickerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PackagingStickerError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseAnimation(value: unknown): StickerAnimation | undefined {
  return typeof value === 'string' && ANIMATION_SET.has(value) ? value as StickerAnimation : undefined;
}

function parseStyle(value: unknown): StickerStyle | undefined {
  return typeof value === 'string' && STYLE_SET.has(value) ? value as StickerStyle : undefined;
}

function parseOrigin(value: unknown): PackagingStickerInstance['origin'] {
  if (!isRecord(value) || value.kind !== 'auto') return { kind: 'manual' };
  if (typeof value.autoGroupId !== 'string' || !SAFE_ID.test(value.autoGroupId)) return { kind: 'manual' };
  return { kind: 'auto', autoGroupId: value.autoGroupId, autoEdited: value.autoEdited === true };
}

function parseSticker(value: unknown): PackagingStickerInstance | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id)) return undefined;
  if (typeof value.assetId !== 'string' || (!COMMON_ID_SET.has(value.assetId) && value.assetId !== 'special')) return undefined;
  const styleMode = value.styleMode === 'fixed' ? 'fixed' : value.styleMode === 'follow-template' ? 'follow-template' : undefined;
  if (!styleMode) return undefined;
  const fixedStyle = value.fixedStyle === null ? null : parseStyle(value.fixedStyle);
  if (styleMode === 'fixed' && !fixedStyle) return undefined;
  if (styleMode === 'follow-template' && fixedStyle !== null) return undefined;
  if (value.assetId === 'special' && styleMode !== 'fixed') return undefined;

  const startFrame = finiteNumber(value.startFrame);
  const endFrame = finiteNumber(value.endFrame);
  const centerXPct = finiteNumber(value.centerXPct);
  const centerYPct = finiteNumber(value.centerYPct);
  const visualWidthPct = finiteNumber(value.visualWidthPct);
  const rotationDeg = finiteNumber(value.rotationDeg);
  const trackIndex = finiteNumber(value.trackIndex);
  const animation = parseAnimation(value.animation);
  if (startFrame === undefined || endFrame === undefined || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)) return undefined;
  if (startFrame < STICKER_INTRO_FRAMES || endFrame - startFrame < STICKER_MIN_DURATION_FRAMES) return undefined;
  if (centerXPct === undefined || centerXPct < 0 || centerXPct > 100 || centerYPct === undefined || centerYPct < 0 || centerYPct > 100) return undefined;
  if (visualWidthPct === undefined || visualWidthPct <= 0 || visualWidthPct > 1000) return undefined;
  if (rotationDeg === undefined || rotationDeg < -180 || rotationDeg > 180) return undefined;
  if (trackIndex === undefined || !Number.isSafeInteger(trackIndex) || trackIndex < 0 || trackIndex > 999) return undefined;
  if (!animation) return undefined;

  return {
    id: value.id,
    assetId: value.assetId,
    styleMode,
    fixedStyle: styleMode === 'fixed' ? fixedStyle! : null,
    startFrame,
    endFrame,
    centerXPct,
    centerYPct,
    visualWidthPct,
    rotationDeg,
    trackIndex,
    animation,
    origin: parseOrigin(value.origin),
  };
}

/** 读取旧包装 JSON：非法实例单独丢弃，重复实例 ID 只保留第一项。 */
export function sanitizePackagingStickers(input: unknown): PackagingStickerInstance[] {
  if (!Array.isArray(input)) return [];
  const result: PackagingStickerInstance[] = [];
  const ids = new Set<string>();
  for (const raw of input) {
    const sticker = parseSticker(raw);
    if (!sticker || ids.has(sticker.id)) continue;
    ids.add(sticker.id);
    result.push(sticker);
    if (result.length >= MAX_STICKER_INSTANCES) break;
  }
  return result;
}

export function sanitizePackagingStickerDefaults(input: unknown): PackagingStickerDefaults | undefined {
  if (!isRecord(input)) return undefined;
  return { animation: parseAnimation(input.animation) ?? DEFAULT_PACKAGING_STICKER_DEFAULTS.animation };
}

export function validatePackagingStickerDefaults(input: unknown): PackagingStickerDefaults {
  if (!isRecord(input)) throw new PackagingStickerError('sticker_defaults_invalid', '贴纸默认设置格式无效');
  const animation = parseAnimation(input.animation);
  if (!animation) throw new PackagingStickerError('sticker_defaults_invalid', '贴纸默认动效无效');
  return { animation };
}

export function assertPackagingStickerFrames(stickers: PackagingStickerInstance[], bodyFrames: number): void {
  if (!Number.isSafeInteger(bodyFrames) || bodyFrames < 0) throw new PackagingStickerError('sticker_body_invalid', '正文帧数无效，无法校验贴纸');
  const bodyEndFrame = STICKER_INTRO_FRAMES + bodyFrames;
  for (const sticker of stickers) {
    if (sticker.startFrame < STICKER_INTRO_FRAMES || sticker.endFrame > bodyEndFrame || sticker.endFrame - sticker.startFrame < STICKER_MIN_DURATION_FRAMES) {
      throw new PackagingStickerError('sticker_out_of_range', `贴纸「${sticker.assetId}」超出正文时间范围或短于 19 帧`);
    }
  }
}

/** 写入命令边界：任何非法实例都拒绝，不能静默丢字段后继续导出。 */
export function validatePackagingStickers(input: unknown, bodyFrames: number): PackagingStickerInstance[] {
  if (!Array.isArray(input)) throw new PackagingStickerError('stickers_invalid', '贴纸数据必须是数组');
  const stickers = sanitizePackagingStickers(input);
  if (stickers.length !== input.length) throw new PackagingStickerError('stickers_invalid', '贴纸数据包含非法项、重复 ID 或超过数量上限');
  assertPackagingStickerFrames(stickers, bodyFrames);
  return stickers;
}

export function resolveStickerStyle(sticker: PackagingStickerInstance, template: PackagingTemplateId): StickerStyle {
  return sticker.styleMode === 'fixed' ? sticker.fixedStyle! : STICKER_STYLE_BY_TEMPLATE[template];
}

export function resolveStickerAssetFile(sticker: PackagingStickerInstance, template: PackagingTemplateId): string {
  return `${resolveStickerStyle(sticker, template)}/${sticker.assetId}.png`;
}

export function resolveStickerAnimation(animation: StickerAnimation, template: PackagingTemplateId): StickerAnimationPresetId {
  return animation === 'follow-template' ? STICKER_ANIMATION_BY_TEMPLATE[template] : animation;
}
