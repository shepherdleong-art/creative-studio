// 兼容再导出：系统字体扫描已下沉到 media-core（同时被 final-edit 与 batch-production 消费），
// 这里只保留既有导入路径，不再保留第二份实现。
export { listSystemFonts, type SystemFontEntry } from '../media-core/system-fonts.ts';
