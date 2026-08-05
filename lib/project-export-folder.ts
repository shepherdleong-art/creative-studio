/**
 * 项目成片导出目录的文件夹命名：`<项目名>-<项目ID前6位>`，例如 `PS697-08cf25`。
 * 单条（final-edit/export-naming）与批量（batch-production/batch-export）共用，
 * 保证同一项目的成片集中存放、目录可读且不同项目不会因同名而混在一个文件夹。
 * 注意：目录名按导出当时计算；项目改名后新导出落在按新名计算的目录，
 * 已导出的旧目录不跟随改名（数据库里存的是导出时的实际相对路径）。
 */

/** Windows 保留设备名不能作为文件夹名。 */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 与导出文件名相同的安全规则来源，限制长度避免触到 Windows MAX_PATH。 */
const MAX_FOLDER_NAME_LENGTH = 60;

const FILESYSTEM_UNSAFE_CHARS = '<>:"/\\|?*';

function isSafeFolderChar(char: string): boolean {
  const code = char.charCodeAt(0);
  // 去掉控制字符（0-31、127）与文件系统保留字符
  return code > 31 && code !== 127 && !FILESYSTEM_UNSAFE_CHARS.includes(char);
}

/**
 * 把项目名清洗成安全的单个文件夹名片段：去掉 `<>:"/\|?*` 与控制字符，
 * 折叠连续空白，去掉结尾的点和空格。清洗后为空（含 Windows 保留名）时返回空串，
 * 由调用方决定回退名。
 */
export function sanitizeProjectFolderName(rawName: string | null | undefined): string {
  const stripped = Array.from(rawName ?? '').filter(isSafeFolderChar).join('');
  const cleaned = stripped
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_FOLDER_NAME_LENGTH)
    .replace(/[. ]+$/, '');
  if (!cleaned || WINDOWS_RESERVED_NAMES.test(cleaned)) return '';
  return cleaned;
}

/** 项目 ID 的可读短码：去掉分隔符后取前 6 位（UUID 取前 6 个十六进制字符）。 */
export function projectShortId(projectId: string): string {
  return projectId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase() || 'unknown';
}

/** 计算 `storage/projects/` 下该项目的成片导出文件夹名。 */
export function projectExportFolderSegment(project: { id: string; name?: string | null }): string {
  const base = sanitizeProjectFolderName(project.name) || '未命名项目';
  return `${base}-${projectShortId(project.id)}`;
}
