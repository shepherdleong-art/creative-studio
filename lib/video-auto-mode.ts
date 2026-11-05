/**
 * 公司 MiniMax H3 / Wan 3.0 的**自动模式**合同（规格 §6）。
 *
 * 这两个模型的主工作台任务不再有模式开关，模式由「模型 + 草稿里的尾帧状态」唯一决定：
 *
 * | 草稿状态 | 生成模式 |
 * | --- | --- |
 * | 首图有效、没有尾图 | reference-to-video（当前冻结首图作唯一 Reference） |
 * | 尾图上传中/删除中/失败 | 阻止提交，**不**退回单图 |
 * | 首图与尾图均有效 | image-to-video（FileInfos Usage=FirstFrame/LastFrame） |
 *
 * 本模块必须是**浏览器安全**的纯函数：前端提交与服务端创建共用这一份规则，
 * 服务端不能只信前端传来的 `generationMode`。
 */
export type VideoGenerationModeValue = 'image-to-video' | 'reference-to-video';

/**
 * 三态尾帧草稿状态。
 * `pending` 覆盖上传中/删除中/失败三种不可提交状态（四行状态表的第二行）。
 */
export type VideoTailFrameDraftState = 'none' | 'ready' | 'pending';

export const VIDEO_AUTO_MODE_PROVIDER_TYPE = 'openai-video' as const;

/** 精确模型 allowlist；不许放宽成前缀匹配（与尾帧 allowlist 同一纪律）。 */
export const VIDEO_AUTO_MODE_MODELS = ['minimax-h3', 'wan-3.0'] as const;

/** 是否自动模式目标：仅 `openai-video` + 精确模型。 */
export function isVideoAutoModeTarget(providerType: unknown, model: unknown): boolean {
  return providerType === VIDEO_AUTO_MODE_PROVIDER_TYPE
    && typeof model === 'string'
    && (VIDEO_AUTO_MODE_MODELS as readonly string[]).includes(model);
}

/**
 * 把字段化的上传状态折叠成三态草稿状态。
 * 失败也算 pending：绝不能因为 tailImageId 暂时为空就当成「没有尾帧」。
 */
export function videoTailFrameDraftState(input: {
  tailImageId?: string | null;
  uploadState?: 'idle' | 'uploading' | 'failed' | 'deleting' | null;
}): VideoTailFrameDraftState {
  const uploadState = input.uploadState ?? 'idle';
  if (uploadState === 'uploading' || uploadState === 'deleting' || uploadState === 'failed') return 'pending';
  return input.tailImageId ? 'ready' : 'none';
}

export interface VideoGenerationModeDecision {
  /** 是否命中自动模式（H3/Wan）。 */
  automatic: boolean;
  generationMode: VideoGenerationModeValue;
  /** 草稿不可提交：尾帧上传中/删除中/失败。 */
  blocked: boolean;
}

/**
 * 单条决策。前端逐行调用、服务端逐条调用，批量里天然按行独立分流。
 *
 * `explicitMode` 只对非自动模式模型生效；自动模式模型永远忽略它，
 * 这就是「服务端不能只信前端 generationMode」的落点。
 */
export function decideVideoGenerationMode(input: {
  providerType?: string | null;
  model?: string | null;
  tailFrameState?: VideoTailFrameDraftState | null;
  explicitMode?: VideoGenerationModeValue | null;
}): VideoGenerationModeDecision {
  const explicitMode: VideoGenerationModeValue =
    input.explicitMode === 'reference-to-video' ? 'reference-to-video' : 'image-to-video';
  if (!isVideoAutoModeTarget(input.providerType, input.model)) {
    return { automatic: false, generationMode: explicitMode, blocked: false };
  }
  const tailFrameState = input.tailFrameState ?? 'none';
  if (tailFrameState === 'pending') {
    // 第二行状态：保留操作状态并阻止提交。这里返回 image-to-video 只是为了
    // 让行级校验落到「尾帧上传状态」分支给出可读提示；该行不允许进入提交。
    return { automatic: true, generationMode: 'image-to-video', blocked: true };
  }
  return {
    automatic: true,
    generationMode: tailFrameState === 'ready' ? 'image-to-video' : 'reference-to-video',
    blocked: false,
  };
}
