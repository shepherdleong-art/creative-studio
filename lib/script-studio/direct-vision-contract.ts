/** C 方案的图片坐标契约；历史卖点仍按其旧版切片坐标读取。 */
export const DIRECT_VISION_VERSION = 7;
export const DIRECT_VISION = {
  maxWidth: 1200,
  tileHeight: 4096,
  overlap: 256,
  pagePixels: 30_000_000,
  jpegQuality: 70,
  preserveMaxBytes: 6 * 1024 * 1024,
  batchImages: 50,
  concurrency: 2,
} as const;
