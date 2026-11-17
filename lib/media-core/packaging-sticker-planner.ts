import type { PackagingTemplateId } from './packaging-vars.ts';
import {
  STICKER_AUTO_MIN_BODY_FRAMES,
  STICKER_DEFAULT_DURATION_FRAMES,
  STICKER_INTRO_FRAMES,
  STICKER_MIN_DURATION_FRAMES,
  STICKER_STYLE_BY_TEMPLATE,
  PackagingStickerError,
  type PackagingStickerInstance,
  type StickerAnimation,
  type StickerStyle,
} from './packaging-stickers.ts';

export type PackagingStickerPlanningAsset = {
  style: StickerStyle;
  category: 'opening' | 'explain' | 'ending' | 'gesture' | 'annotation' | 'special';
  id: string;
};

export type PackagingStickerAutoSlot = {
  name: 'opening-left' | 'opening-right' | 'explain-left' | 'gesture-right' | 'ending-left' | 'ending-right';
  centerXPct: number;
  centerYPct: number;
  visualWidthPct: number;
  rotationDeg: number;
};

/** 六槽位顺序固定：开头 2 张、中段讲解 + 手势、结尾 2 张。 */
export const PACKAGING_STICKER_AUTO_SLOTS: Record<PackagingTemplateId, readonly PackagingStickerAutoSlot[]> = {
  'overlay-poster': [
    { name: 'opening-left', centerXPct: 22, centerYPct: 22, visualWidthPct: 28, rotationDeg: -4 },
    { name: 'opening-right', centerXPct: 78, centerYPct: 25, visualWidthPct: 26, rotationDeg: 3 },
    { name: 'explain-left', centerXPct: 22, centerYPct: 51, visualWidthPct: 25, rotationDeg: -2 },
    { name: 'gesture-right', centerXPct: 80, centerYPct: 58, visualWidthPct: 22, rotationDeg: 4 },
    { name: 'ending-left', centerXPct: 25, centerYPct: 31, visualWidthPct: 26, rotationDeg: -3 },
    { name: 'ending-right', centerXPct: 75, centerYPct: 56, visualWidthPct: 26, rotationDeg: 3 },
  ],
  'overlay-journal': [
    { name: 'opening-left', centerXPct: 21, centerYPct: 22, visualWidthPct: 25, rotationDeg: -5 },
    { name: 'opening-right', centerXPct: 79, centerYPct: 29, visualWidthPct: 24, rotationDeg: 4 },
    { name: 'explain-left', centerXPct: 23, centerYPct: 51, visualWidthPct: 24, rotationDeg: -3 },
    { name: 'gesture-right', centerXPct: 79, centerYPct: 59, visualWidthPct: 21, rotationDeg: 5 },
    { name: 'ending-left', centerXPct: 23, centerYPct: 32, visualWidthPct: 24, rotationDeg: -4 },
    { name: 'ending-right', centerXPct: 77, centerYPct: 55, visualWidthPct: 24, rotationDeg: 3 },
  ],
  'overlay-minimal': [
    { name: 'opening-left', centerXPct: 23, centerYPct: 22, visualWidthPct: 25, rotationDeg: 0 },
    { name: 'opening-right', centerXPct: 77, centerYPct: 27, visualWidthPct: 24, rotationDeg: 0 },
    { name: 'explain-left', centerXPct: 23, centerYPct: 49, visualWidthPct: 23, rotationDeg: 0 },
    { name: 'gesture-right', centerXPct: 79, centerYPct: 57, visualWidthPct: 21, rotationDeg: 0 },
    { name: 'ending-left', centerXPct: 24, centerYPct: 31, visualWidthPct: 24, rotationDeg: 0 },
    { name: 'ending-right', centerXPct: 76, centerYPct: 54, visualWidthPct: 24, rotationDeg: 0 },
  ],
  'overlay-variety': [
    { name: 'opening-left', centerXPct: 22, centerYPct: 23, visualWidthPct: 28, rotationDeg: -5 },
    { name: 'opening-right', centerXPct: 78, centerYPct: 27, visualWidthPct: 27, rotationDeg: 4 },
    { name: 'explain-left', centerXPct: 22, centerYPct: 52, visualWidthPct: 26, rotationDeg: -3 },
    { name: 'gesture-right', centerXPct: 80, centerYPct: 59, visualWidthPct: 23, rotationDeg: 5 },
    { name: 'ending-left', centerXPct: 25, centerYPct: 32, visualWidthPct: 27, rotationDeg: -4 },
    { name: 'ending-right', centerXPct: 75, centerYPct: 56, visualWidthPct: 27, rotationDeg: 4 },
  ],
};

function drawIds(assets: PackagingStickerPlanningAsset[], style: StickerStyle, category: PackagingStickerPlanningAsset['category'], count: number, random: () => number): string[] {
  const pool = [...new Set(assets.filter((asset) => asset.style === style && asset.category === category).map((asset) => asset.id))];
  if (pool.length < count) throw new PackagingStickerError('sticker_auto_pool_invalid', `当前模板的 ${category} 贴纸不足 ${count} 张，无法自动布置`);
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const randomIndex = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    result.push(pool.splice(randomIndex, 1)[0]);
  }
  return result;
}

export function planPackagingStickerAutoLayout(input: {
  bodyFrames: number;
  template: PackagingTemplateId;
  assets: PackagingStickerPlanningAsset[];
  animation: StickerAnimation;
  autoGroupId: string;
  random: () => number;
  createId: (slotIndex: number) => string;
}): PackagingStickerInstance[] | null {
  if (!Number.isSafeInteger(input.bodyFrames) || input.bodyFrames < STICKER_AUTO_MIN_BODY_FRAMES) return null;
  const style = STICKER_STYLE_BY_TEMPLATE[input.template];
  const assetIds = [
    ...drawIds(input.assets, style, 'opening', 2, input.random),
    ...drawIds(input.assets, style, 'explain', 1, input.random),
    ...drawIds(input.assets, style, 'gesture', 1, input.random),
    ...drawIds(input.assets, style, 'ending', 2, input.random),
  ];
  const slots = PACKAGING_STICKER_AUTO_SLOTS[input.template];
  return slots.map((slot, slotIndex) => {
    const stageIndex = Math.floor(slotIndex / 2);
    const stageStart = STICKER_INTRO_FRAMES + Math.round(stageIndex * input.bodyFrames / 3);
    const stageEnd = STICKER_INTRO_FRAMES + Math.round((stageIndex + 1) * input.bodyFrames / 3);
    const stageFrames = stageEnd - stageStart;
    const durationFrames = Math.min(STICKER_DEFAULT_DURATION_FRAMES, Math.max(STICKER_MIN_DURATION_FRAMES, Math.round(stageFrames * 0.4)));
    const centerRatio = slotIndex % 2 === 0 ? 0.25 : 0.75;
    const centerFrame = stageStart + Math.round(stageFrames * centerRatio);
    const unclampedStart = centerFrame - Math.floor(durationFrames / 2);
    const startFrame = Math.min(stageEnd - durationFrames, Math.max(stageStart, unclampedStart));
    return {
      id: input.createId(slotIndex),
      assetId: assetIds[slotIndex],
      styleMode: 'follow-template',
      fixedStyle: null,
      startFrame,
      endFrame: startFrame + durationFrames,
      centerXPct: slot.centerXPct,
      centerYPct: slot.centerYPct,
      visualWidthPct: slot.visualWidthPct,
      rotationDeg: slot.rotationDeg,
      trackIndex: 0,
      animation: input.animation,
      origin: { kind: 'auto', autoGroupId: input.autoGroupId, autoEdited: false },
    };
  });
}

/** 换一组只替换自动实例；手动实例及复制后已转为手动的实例原样保留。 */
export function replaceAutomaticPackagingStickers(stickers: PackagingStickerInstance[], replacement: PackagingStickerInstance[]): PackagingStickerInstance[] {
  return [...stickers.filter((sticker) => sticker.origin.kind !== 'auto'), ...replacement];
}
