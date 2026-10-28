import type { PackagingTemplateId } from './packaging-vars.ts';
import {
  PACKAGING_STICKER_AUTO_SLOTS,
  type PackagingStickerAutoSlot,
  type PackagingStickerPlanningAsset,
} from './packaging-sticker-planner.ts';
import {
  STICKER_AUTO_MIN_BODY_FRAMES,
  STICKER_DEFAULT_DURATION_FRAMES,
  STICKER_INTRO_FRAMES,
  STICKER_MIN_DURATION_FRAMES,
  STICKER_STYLE_BY_TEMPLATE,
  PackagingStickerError,
  assertPackagingStickerFrames,
  type PackagingStickerInstance,
} from './packaging-stickers.ts';

export const PACKAGING_STICKER_VARIANT_ANIMATIONS = ['soft', 'bounce', 'rise', 'slide', 'zoom'] as const;

type AutomaticCategory = Extract<PackagingStickerPlanningAsset['category'], 'opening' | 'explain' | 'gesture' | 'ending'>;

export type PackagingStickerVariantTarget = {
  targetId: string;
  bodyFrames: number;
  template: PackagingTemplateId;
};

export type PackagingStickerVariantIdRequest =
  | { kind: 'sticker'; targetId: string; targetIndex: number; sourceStickerId: string }
  | { kind: 'autoGroup'; targetId: string; targetIndex: number; sourceAutoGroupId: string };

export type PackagingStickerVariantPlan = {
  targetId: string;
  stickers: PackagingStickerInstance[];
};

type AutomaticDescriptor = {
  sourceIndex: number;
  stageIndex: number;
  stageOrder: number;
  category: AutomaticCategory;
};

function isUneditedAutomatic(sticker: PackagingStickerInstance): boolean {
  return sticker.origin.kind === 'auto' && !sticker.origin.autoEdited;
}

function assertSourceBodyFrames(bodyFrames: number): void {
  if (!Number.isSafeInteger(bodyFrames) || bodyFrames <= 0) {
    throw new PackagingStickerError('sticker_body_invalid', '来源正文帧数无效，无法复制贴纸');
  }
}

function mapFrames(sticker: PackagingStickerInstance, sourceBodyFrames: number, targetBodyFrames: number): { startFrame: number; endFrame: number } {
  return {
    startFrame: STICKER_INTRO_FRAMES + Math.round((sticker.startFrame - STICKER_INTRO_FRAMES) * targetBodyFrames / sourceBodyFrames),
    endFrame: STICKER_INTRO_FRAMES + Math.round((sticker.endFrame - STICKER_INTRO_FRAMES) * targetBodyFrames / sourceBodyFrames),
  };
}

/** 提交前的目标时长预检；不读取随机源或 ID 生成器。 */
export function assertPackagingStickerVariantTarget(input: {
  sourceBodyFrames: number;
  targetBodyFrames: number;
  sourceStickers: readonly PackagingStickerInstance[];
}): void {
  assertSourceBodyFrames(input.sourceBodyFrames);
  if (!Number.isSafeInteger(input.targetBodyFrames) || input.targetBodyFrames < 0) {
    throw new PackagingStickerError('sticker_body_invalid', '目标正文帧数无效，无法复制贴纸');
  }
  if (input.sourceStickers.some(isUneditedAutomatic) && input.targetBodyFrames < STICKER_AUTO_MIN_BODY_FRAMES) {
    throw new PackagingStickerError('sticker_auto_body_too_short', `包含未编辑自动贴纸时，目标正文至少需要 ${STICKER_AUTO_MIN_BODY_FRAMES} 帧`);
  }
  for (const sticker of input.sourceStickers) {
    if (isUneditedAutomatic(sticker)) continue;
    const mapped = { ...sticker, ...mapFrames(sticker, input.sourceBodyFrames, input.targetBodyFrames) };
    assertPackagingStickerFrames([mapped], input.targetBodyFrames);
  }
}

function createCategoryLookup(assets: readonly PackagingStickerPlanningAsset[]): Map<string, AutomaticCategory> {
  const result = new Map<string, AutomaticCategory>();
  for (const asset of assets) {
    if (asset.category === 'opening' || asset.category === 'explain' || asset.category === 'gesture' || asset.category === 'ending') {
      if (!result.has(asset.id)) result.set(asset.id, asset.category);
    }
  }
  return result;
}

function sourceStageIndex(sticker: PackagingStickerInstance, sourceBodyFrames: number): number {
  const midpoint = (sticker.startFrame + sticker.endFrame) / 2;
  const firstEnd = STICKER_INTRO_FRAMES + Math.round(sourceBodyFrames / 3);
  const secondEnd = STICKER_INTRO_FRAMES + Math.round(sourceBodyFrames * 2 / 3);
  return midpoint < firstEnd ? 0 : midpoint < secondEnd ? 1 : 2;
}

function describeAutomaticStickers(
  stickers: readonly PackagingStickerInstance[],
  sourceBodyFrames: number,
  categoryByAssetId: Map<string, AutomaticCategory>,
): Map<number, AutomaticDescriptor> {
  const descriptors = new Map<number, AutomaticDescriptor>();
  for (let stageIndex = 0; stageIndex < 3; stageIndex += 1) {
    const stageItems = stickers
      .map((sticker, sourceIndex) => ({ sticker, sourceIndex }))
      .filter(({ sticker }) => isUneditedAutomatic(sticker) && sourceStageIndex(sticker, sourceBodyFrames) === stageIndex)
      .sort((left, right) => {
        const leftMidpoint = left.sticker.startFrame + left.sticker.endFrame;
        const rightMidpoint = right.sticker.startFrame + right.sticker.endFrame;
        return leftMidpoint - rightMidpoint || left.sourceIndex - right.sourceIndex;
      });
    stageItems.forEach(({ sticker, sourceIndex }, stageOrder) => {
      const category = categoryByAssetId.get(sticker.assetId);
      if (!category) {
        throw new PackagingStickerError('sticker_auto_asset_invalid', `自动贴纸「${sticker.assetId}」无法确定功能类别`);
      }
      descriptors.set(sourceIndex, { sourceIndex, stageIndex, stageOrder, category });
    });
  }
  return descriptors;
}

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.max(0, Math.floor(random() * length)));
}

function drawAsset(input: {
  assets: readonly PackagingStickerPlanningAsset[];
  style: PackagingStickerPlanningAsset['style'];
  category: AutomaticCategory;
  stageAssetIds: Set<string>;
  usage: Map<string, number>;
  random: () => number;
}): string {
  const pool = [...new Set(input.assets
    .filter((asset) => asset.style === input.style && asset.category === input.category)
    .map((asset) => asset.id))];
  if (pool.length === 0) {
    throw new PackagingStickerError('sticker_auto_pool_invalid', `目标模板缺少 ${input.category} 类别的自动贴纸素材`);
  }
  const unused = pool.filter((assetId) => !input.stageAssetIds.has(assetId));
  const stageCandidates = unused.length > 0 ? unused : pool;
  const counts = stageCandidates.map((assetId) => input.usage.get(`${input.category}/${assetId}`) ?? 0);
  const minimum = Math.min(...counts);
  const candidates = stageCandidates.filter((_, index) => counts[index] === minimum);
  const assetId = candidates[randomIndex(candidates.length, input.random)];
  input.stageAssetIds.add(assetId);
  const usageKey = `${input.category}/${assetId}`;
  input.usage.set(usageKey, (input.usage.get(usageKey) ?? 0) + 1);
  return assetId;
}

function drawSlot(
  slots: readonly PackagingStickerAutoSlot[],
  usedNames: Set<string>,
  random: () => number,
): PackagingStickerAutoSlot {
  const unused = slots.filter((slot) => !usedNames.has(slot.name));
  const candidates = unused.length > 0 ? unused : slots;
  const slot = candidates[randomIndex(candidates.length, random)];
  usedNames.add(slot.name);
  return slot;
}

function automaticFrames(bodyFrames: number, stageIndex: number, stageOrder: number): { startFrame: number; endFrame: number } {
  const stageStart = STICKER_INTRO_FRAMES + Math.round(stageIndex * bodyFrames / 3);
  const stageEnd = STICKER_INTRO_FRAMES + Math.round((stageIndex + 1) * bodyFrames / 3);
  const stageFrames = stageEnd - stageStart;
  const durationFrames = Math.min(STICKER_DEFAULT_DURATION_FRAMES, Math.max(STICKER_MIN_DURATION_FRAMES, Math.round(stageFrames * 0.4)));
  const centerRatio = stageOrder === 0 ? 0.25 : 0.75;
  const centerFrame = stageStart + Math.round(stageFrames * centerRatio);
  const unclampedStart = centerFrame - Math.floor(durationFrames / 2);
  const startFrame = Math.min(stageEnd - durationFrames, Math.max(stageStart, unclampedStart));
  return { startFrame, endFrame: startFrame + durationFrames };
}

/** 一次规划多个目标；仅生成 stickers，stickerDefaults 由复制命令按来源原样处理。 */
export function planPackagingStickerVariants(input: {
  sourceBodyFrames: number;
  sourceStickers: readonly PackagingStickerInstance[];
  targets: readonly PackagingStickerVariantTarget[];
  assets: readonly PackagingStickerPlanningAsset[];
  random: () => number;
  createId: (request: PackagingStickerVariantIdRequest) => string;
}): PackagingStickerVariantPlan[] {
  for (const target of input.targets) {
    assertPackagingStickerVariantTarget({
      sourceBodyFrames: input.sourceBodyFrames,
      targetBodyFrames: target.bodyFrames,
      sourceStickers: input.sourceStickers,
    });
  }

  const categoryByAssetId = createCategoryLookup(input.assets);
  const automatic = describeAutomaticStickers(input.sourceStickers, input.sourceBodyFrames, categoryByAssetId);
  const usage = new Map<string, number>();
  for (const sticker of input.sourceStickers) {
    const category = categoryByAssetId.get(sticker.assetId);
    if (!category) continue;
    const key = `${category}/${sticker.assetId}`;
    usage.set(key, (usage.get(key) ?? 0) + 1);
  }

  return input.targets.map((target, targetIndex) => {
    const autoGroupIds = new Map<string, string>();
    const stageAssetIds = [new Set<string>(), new Set<string>(), new Set<string>()];
    const stageSlotNames = [new Set<string>(), new Set<string>(), new Set<string>()];
    const targetSlots = PACKAGING_STICKER_AUTO_SLOTS[target.template];
    const targetStyle = STICKER_STYLE_BY_TEMPLATE[target.template];
    const autoGroupId = (sourceAutoGroupId: string): string => {
      const existing = autoGroupIds.get(sourceAutoGroupId);
      if (existing !== undefined) return existing;
      const created = input.createId({ kind: 'autoGroup', targetId: target.targetId, targetIndex, sourceAutoGroupId });
      autoGroupIds.set(sourceAutoGroupId, created);
      return created;
    };
    const copyOrigin = (sticker: PackagingStickerInstance): PackagingStickerInstance['origin'] => sticker.origin.kind === 'manual'
      ? { kind: 'manual' }
      : { kind: 'auto', autoGroupId: autoGroupId(sticker.origin.autoGroupId), autoEdited: sticker.origin.autoEdited };

    const stickers = input.sourceStickers.map((sticker, sourceIndex) => {
      const id = input.createId({ kind: 'sticker', targetId: target.targetId, targetIndex, sourceStickerId: sticker.id });
      if (!isUneditedAutomatic(sticker)) {
        return {
          ...sticker,
          id,
          ...mapFrames(sticker, input.sourceBodyFrames, target.bodyFrames),
          origin: copyOrigin(sticker),
        };
      }
      const descriptor = automatic.get(sourceIndex)!;
      const assetId = drawAsset({
        assets: input.assets,
        style: targetStyle,
        category: descriptor.category,
        stageAssetIds: stageAssetIds[descriptor.stageIndex],
        usage,
        random: input.random,
      });
      const slot = drawSlot(
        targetSlots.slice(descriptor.stageIndex * 2, descriptor.stageIndex * 2 + 2),
        stageSlotNames[descriptor.stageIndex],
        input.random,
      );
      return {
        ...sticker,
        id,
        assetId,
        styleMode: 'follow-template' as const,
        fixedStyle: null,
        ...automaticFrames(target.bodyFrames, descriptor.stageIndex, descriptor.stageOrder),
        centerXPct: slot.centerXPct,
        centerYPct: slot.centerYPct,
        animation: PACKAGING_STICKER_VARIANT_ANIMATIONS[randomIndex(PACKAGING_STICKER_VARIANT_ANIMATIONS.length, input.random)],
        origin: copyOrigin(sticker),
      };
    });
    return { targetId: target.targetId, stickers };
  });
}
