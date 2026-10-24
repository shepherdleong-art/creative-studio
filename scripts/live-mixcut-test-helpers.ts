import type Database from 'better-sqlite3';

/** 实拍混剪的数据都挂在 live_mixcut_projects（界面上叫"任务"）下；测试在就绪检查建表之后补上要用的任务。 */
export function seedLiveMixcutProjects(options: { db: Database.Database }, ids: string[]): void {
  // 有的测试故意让就绪检查失败（比如开关关闭），这时表不存在，直接跳过。
  if (!options.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_mixcut_projects'").get()) return;
  const now = new Date().toISOString();
  const insert = options.db.prepare(`INSERT OR IGNORE INTO live_mixcut_projects
    (id, name, productName, exportDirName, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const id of ids) insert.run(id, `测试任务 ${id}`, '测试产品', `测试任务-${id}`, now, now);
}
