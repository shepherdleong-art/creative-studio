import type Database from 'better-sqlite3';
import { sanitizeExportFilenamePart, formatShanghaiTaskDate } from './final-edit/export-identity.ts';
import { FinalEditError } from './final-edit/errors.ts';

/**
 * 导出目录名守卫:只允许文件名安全的普通字符与中文,不得为 `.` / `..`,
 * 不得含路径分隔符。与 `export-naming.ts` 的 `assertSafeProjectId` 同款,
 * 但允许 CJK(产品编码可含中文)。
 */
export function assertSafeExportDirName(exportDirName: string): void {
  if (
    !exportDirName
    || exportDirName === '.'
    || exportDirName === '..'
    || exportDirName.includes('/')
    || exportDirName.includes('\\')
    || !/^[A-Za-z0-9._\-一-龥]+$/.test(exportDirName)
  ) {
    throw new FinalEditError('unsafe_path', '导出目录名不能用于导出路径');
  }
}

function sanitizeExportDirPart(value: string): string {
  return sanitizeExportFilenamePart(value.trim()).replace(/[^A-Za-z0-9._\-一-龥]/g, '');
}

/**
 * 解析项目的成片导出目录名(`<产品编码>-<YYYYMMDD>`,编码为空时回落到
 * 项目名、再回落 projectId),幂等,首次调用时落库到 `projects.exportDirName`。
 * 已落库的名字即使产品编码后来被改了也不重算(否则老文件全成孤儿);
 * 与其他项目已占用的目录名冲突时追加 `-2`、`-3` 序号。
 */
export function resolveProjectExportDirName(db: Database.Database, projectId: string): string {
  const row = db.prepare(`SELECT exportDirName, productCode, name, createdAt FROM projects WHERE id = ?`).get(projectId) as
    | { exportDirName: string; productCode: string | null; name: string | null; createdAt: string | null }
    | undefined;
  if (!row) throw new FinalEditError('project_not_found', '项目不存在', 404);
  if (row.exportDirName.trim()) return row.exportDirName;

  const base = sanitizeExportDirPart(row.productCode || '')
    || sanitizeExportDirPart(row.name || '')
    || sanitizeExportDirPart(projectId);
  const taskDate = formatShanghaiTaskDate(row.createdAt ?? '');
  const candidateBase = taskDate ? `${base}-${taskDate}` : base;
  let candidate = candidateBase;
  for (let sequence = 2; db.prepare(`SELECT id FROM projects WHERE exportDirName = ? AND id != ?`).get(candidate, projectId); sequence += 1) {
    candidate = `${candidateBase}-${sequence}`;
  }
  assertSafeExportDirName(candidate);
  db.prepare(`UPDATE projects SET exportDirName = ? WHERE id = ?`).run(candidate, projectId);
  return candidate;
}
