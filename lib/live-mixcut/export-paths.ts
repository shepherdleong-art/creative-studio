/**
 * 实拍混剪导出目录与版本命名的唯一出处。
 *
 * 一个任务只有一个「成片」文件夹；同一条（同一套冻结导出身份）再导出时，
 * 新版本叫 `-v2`、`-v3`，上一版连同封面挪到旁边的「旧版」。
 * 发布、清单、打开文件夹都必须从这里取路径，不要各自拼一份。
 * 本文件供服务端和前端共用，因此只能有纯字符串计算。
 */

export const LIVE_MIXCUT_EXPORT_FOLDER = '成片';
export const LIVE_MIXCUT_ARCHIVE_FOLDER = '旧版';

/** 版本号后缀的公共语法：`-v2`、`-v3`；首次导出没有后缀。 */
const VERSION_SUFFIX_SOURCE = '(?:-v(\\d+))?';

/** exportDirName 是任务级单段目录名（由服务端校验，不含路径分隔符）。 */
export function liveMixcutExportRelativeDir(exportDirName: string): string {
  return `live-mixcut/exports/${exportDirName}/${LIVE_MIXCUT_EXPORT_FOLDER}`;
}

export function liveMixcutArchiveRelativeDir(exportDirName: string): string {
  return `live-mixcut/exports/${exportDirName}/${LIVE_MIXCUT_ARCHIVE_FOLDER}`;
}

/** 「成片」里当前这一套的文件都在这个前缀下（统一 / 分隔，跨平台比对）。 */
export function liveMixcutExportPrefix(exportDirName: string): string {
  return `${liveMixcutExportRelativeDir(exportDirName)}/`;
}

/** 首次导出不带后缀；同一套导出身份再导出叫 -v2、-v3。 */
export function liveMixcutVersionName(exportKey: string, version: number): string {
  return version > 1 ? `${exportKey}-v${version}` : exportKey;
}

/** 认「成片」里的一层普通文件：在成片根下、不是子目录。 */
export function isLiveMixcutExportedFile(relativePath: string, exportDirName: string): boolean {
  const prefix = liveMixcutExportPrefix(exportDirName);
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized.startsWith(prefix)) return false;
  const remainder = normalized.slice(prefix.length);
  return !!remainder && !remainder.includes('/');
}

/** 从「成片」里的视频路径认出导出身份和版本号；不在这一层或不是视频返回 null。 */
export function parseLiveMixcutExportedVideo(relativePath: string, exportDirName: string): { key: string; version: number } | null {
  if (!isLiveMixcutExportedFile(relativePath, exportDirName)) return null;
  const prefix = liveMixcutExportPrefix(exportDirName);
  const remainder = relativePath.replaceAll('\\', '/').slice(prefix.length);
  const match = new RegExp(`^(.*?)${VERSION_SUFFIX_SOURCE}\\.mp4$`, 'u').exec(remainder);
  if (!match) return null;
  return { key: `${prefix}${match[1]}`, version: match[2] ? Number(match[2]) : 1 };
}

/** 版本匹配片段，供按文件名扫描「成片」「旧版」的实现复用同一套语法。 */
export function liveMixcutVersionSuffixPattern(): string {
  return VERSION_SUFFIX_SOURCE;
}
