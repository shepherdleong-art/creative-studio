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

/**
 * 生成前检查要求公式用到的素材都分析过画面。这些测试只关心后续环节，
 * 用一段编造的画面分析把素材标记成「已分析」，不去调用任何模型。
 * 不传 batchId 时补上这个任务下所有批次已登记的素材。
 */
export async function seedFormulaMaterialAnalysis(options: { db: Database.Database }, projectId: string, batchId?: string): Promise<void> {
  const { saveFormulaMaterialAnalysis } = await import('../lib/live-mixcut/formula/material-analysis.ts');
  const rows = options.db.prepare(`SELECT DISTINCT f.contentFingerprint FROM live_mixcut_formula_asset_bindings f
    JOIN live_mixcut_formula_collections c ON c.id = f.collectionId
    WHERE c.projectId = ?${batchId ? ' AND c.batchId = ?' : ''}`)
    .all(...(batchId ? [projectId, batchId] : [projectId])) as Array<{ contentFingerprint: string }>;
  const analysis = {
    summary: '测试素材画面', sellingPoints: [], semanticTags: [], qualityIssues: [], coverFrameTimesUs: [],
    usableRanges: [{ startUs: 0, endUs: 1_000_000, qualityScore: 1 }],
    scenes: [{ startUs: 0, endUs: 1_000_000, description: '测试素材画面', labels: [], qualityScore: 1 }],
  };
  for (const row of rows) {
    saveFormulaMaterialAnalysis(options.db, projectId, { contentFingerprint: row.contentFingerprint, analysis,
      provider: { id: 'fixture', name: '测试画面模型', model: 'fixture-vision' } });
  }
}
