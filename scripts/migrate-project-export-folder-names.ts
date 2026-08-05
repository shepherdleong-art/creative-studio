/**
 * 存量迁移：把 `storage/projects/<项目UUID>/成片/` 改为可读的 `<项目名-短ID>/成片/`。
 *
 * 背景：成片导出目录从按项目 UUID 命名改为按 `项目名-短ID` 命名
 * （见 lib/project-export-folder.ts）。新导出自动使用新目录；本脚本处理
 * 改动之前已经导出的旧目录：
 *   1. 先用 SQLite Online Backup 备份数据库到 data/backups/；
 *   2. 把 storage/projects/<UUID>/ 整个文件夹改名（目标已存在则合并，
 *      同名文件大小一致跳过、不一致则报错留待人工处理）；
 *   3. 在一个事务里改写给数据库里记录这些文件位置的字段：
 *      - project_artifacts.relativePath（单条模式正式产物）
 *      - batch_artifacts.relativePath（批量模式正式产物）
 *      - final_edit_jobs.outputJson（成片下载/打开文件夹读取的发布路径）
 *      路径分隔符三种形态（单反斜杠、JSON 内双反斜杠、正斜杠）都会替换。
 *
 * 重复执行是幂等的：目录不存在且数据库无引用时自动跳过。
 * 运行：node scripts/migrate-project-export-folder-names.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataRoot } from '../lib/data-root.ts';
import { projectExportFolderSegment } from '../lib/project-export-folder.ts';

const root = dataRoot();
const dbPath = path.join(root, 'data', 'workbench.db');
const storageRoot = path.join(root, 'storage');
const projectsRoot = path.join(storageRoot, 'projects');

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
}

/** 递归把 srcDir 内容并入 destDir；同名文件大小一致则跳过，不一致抛错。 */
function mergeDirectory(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (fs.existsSync(dest)) mergeDirectory(src, dest);
      else fs.renameSync(src, dest);
      continue;
    }
    if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
      continue;
    }
    const srcSize = fs.statSync(src).size;
    const destSize = fs.statSync(dest).size;
    if (srcSize === destSize) {
      fs.rmSync(src, { force: true });
      continue;
    }
    throw new Error(`合并冲突:${src} 与 ${dest} 大小不一致,请人工处理后再重跑`);
  }
}

/** 替换文本里所有指向旧目录段的形态（JSON 双反斜杠 / 单反斜杠 / 正斜杠）。 */
function rewriteProjectSegment(text: string, oldSegment: string, newSegment: string): string {
  let result = text;
  // 先替换 JSON 转义形态（两个字符的反斜杠），再替换单分隔符形态
  const variants: Array<[string, string]> = [
    [`projects\\\\${oldSegment}`, `projects\\\\${newSegment}`],
    [`projects\\${oldSegment}`, `projects\\${newSegment}`],
    [`projects/${oldSegment}`, `projects/${newSegment}`],
  ];
  for (const [from, to] of variants) {
    result = result.split(from).join(to);
  }
  return result;
}

async function main(): Promise<void> {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在:${dbPath}`);
  const db = new Database(dbPath);
  try {
    const backupDir = path.join(root, 'data', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `workbench-pre-export-folder-rename-${new Date().toISOString().replace(/[:.]/g, '')}.db`);
    await db.backup(backupPath);
    console.log(`数据库已备份:${backupPath}`);

    const projects = db.prepare(`SELECT id, name FROM projects`).all() as Array<{ id: string; name: string | null }>;
    const projectIds = new Set(projects.map((project) => project.id));

    // 报告不属于任何项目的孤儿目录,不自动处理
    if (fs.existsSync(projectsRoot)) {
      for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && !projectIds.has(entry.name)) {
          const stillUuid = projects.some((project) => projectExportFolderSegment(project) === entry.name);
          if (!stillUuid) console.log(`跳过未识别的目录(非任何项目的旧导出目录):${entry.name}`);
        }
      }
    }

    let movedCount = 0;
    let dbRowCount = 0;
    for (const project of projects) {
      const newSegment = projectExportFolderSegment(project);
      if (newSegment === project.id) continue;
      const oldDir = path.join(projectsRoot, project.id);
      const newDir = path.join(projectsRoot, newSegment);
      const oldDirExists = fs.existsSync(oldDir);
      if (oldDirExists) {
        // 逐个子项搬移而不是整体 rename:Windows 上目录本身被占用(资源管理器、
        // 索引器等持有句柄)时整体改名会 EPERM,但搬出子项不受这个锁影响。
        fs.mkdirSync(newDir, { recursive: true });
        mergeDirectory(oldDir, newDir);
        try {
          fs.rmdirSync(oldDir);
          console.log(`目录改名:${project.id} -> ${newSegment}`);
        } catch {
          console.log(`目录内容已搬到 ${newSegment};旧空目录 ${project.id} 当前被系统占用无法删除,重启后可手动删除`);
        }
        movedCount += 1;
      }

      // 数据库路径改写(事务内):即使目录已不存在,记录里的路径也一并修正
      const rewrite = db.transaction(() => {
        let changed = 0;
        const textColumns: Array<{ table: string; column: string }> = [];
        if (tableExists(db, 'project_artifacts')) textColumns.push({ table: 'project_artifacts', column: 'relativePath' });
        if (tableExists(db, 'batch_artifacts')) textColumns.push({ table: 'batch_artifacts', column: 'relativePath' });
        if (tableExists(db, 'final_edit_jobs')) textColumns.push({ table: 'final_edit_jobs', column: 'outputJson' });
        for (const { table, column } of textColumns) {
          const rows = db.prepare(
            `SELECT rowid, ${column} AS value FROM ${table} WHERE ${column} LIKE '%' || ? || '%'`,
          ).all(project.id) as Array<{ rowid: number; value: string | null }>;
          const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
          for (const row of rows) {
            if (!row.value) continue;
            const rewritten = rewriteProjectSegment(row.value, project.id, newSegment);
            if (rewritten !== row.value) {
              update.run(rewritten, row.rowid);
              changed += 1;
            }
          }
        }
        return changed;
      });
      dbRowCount += rewrite();
    }

    console.log(`完成:${movedCount} 个目录改名,${dbRowCount} 条数据库记录路径已更新。`);
    if (movedCount === 0 && dbRowCount === 0) console.log('没有需要迁移的内容。');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error('迁移失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
