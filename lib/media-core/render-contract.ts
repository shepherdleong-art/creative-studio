// 单条混剪与批量成片共用的成片契约：24fps、开头 20 帧封面片头。
// 常量沿用 FINAL_EDIT_ 前缀，避免改动 30+ 处既有引用；语义上属于两侧共用。
export const FINAL_EDIT_FPS = 24 as const;
export const FINAL_EDIT_INTRO_FRAMES = 20 as const;
export const FINAL_EDIT_INTRO_DURATION_US = 833_333;
