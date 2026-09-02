// 单条混剪与批量成片共用的成片契约：24fps、开头 20 帧封面片头。
// 常量沿用 FINAL_EDIT_ 前缀，避免改动 30+ 处既有引用；语义上属于两侧共用。
export const FINAL_EDIT_FPS = 24 as const;
export const FINAL_EDIT_INTRO_FRAMES = 20 as const;
export const FINAL_EDIT_INTRO_DURATION_US = 833_333;

/**
 * 素材可用的最大出点帧（含）。生成与校验必须共用这一个定义——之前 audio-first
 * 生成用 Math.ceil、编辑期校验用 Math.floor，恒差一帧，贴死边界的 clip 从生成
 * 那一刻起就永久不可编辑（素材删除/替换全部被拒）。
 * 统一到 floor：floor 是素材真实存在的最后一个完整帧，放宽到 ceil 会让 ffmpeg
 * 在末尾取到不存在的帧。
 */
export function sourceFrameLimit(durationUs: number, fps: number = FINAL_EDIT_FPS): number {
  return Math.floor(Math.max(0, durationUs) * fps / 1_000_000);
}
