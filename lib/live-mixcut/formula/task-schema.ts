import type Database from 'better-sqlite3';

// 固定复制 v25 的三个表结构，只扩展任务类型；不在运行时推导或修改历史迁移。
export const FORMULA_TASK_TABLES_SQL = `
      CREATE TABLE live_mixcut_tasks_formula_v9 (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT,
        workType TEXT NOT NULL CHECK(workType IN ('asset_prepare', 'render', 'proxy_generate', 'narration', 'semantic_score', 'formula_stage')),
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        requestKey TEXT,
        expectedState TEXT NOT NULL DEFAULT 'running' CHECK(expectedState IN ('running', 'paused', 'stopped')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        attemptCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE
      );
      INSERT INTO live_mixcut_tasks_formula_v9
        (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
      SELECT id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt
      FROM live_mixcut_tasks;

      CREATE TABLE live_mixcut_task_attempts_formula_v9 (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        attemptNumber INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        resultJson TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        claimedBy TEXT,
        leaseExpiresAt TEXT,
        heartbeatAt TEXT,
        adapterVersion TEXT,
        remoteTaskId TEXT,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(taskId, attemptNumber),
        FOREIGN KEY(taskId) REFERENCES live_mixcut_tasks_formula_v9(id) ON DELETE CASCADE
      );
      INSERT INTO live_mixcut_task_attempts_formula_v9
        (id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, claimedBy, leaseExpiresAt, heartbeatAt, adapterVersion, remoteTaskId, startedAt, finishedAt, createdAt)
      SELECT id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, claimedBy, leaseExpiresAt, heartbeatAt, adapterVersion, remoteTaskId, startedAt, finishedAt, createdAt
      FROM live_mixcut_task_attempts;

      CREATE TABLE live_mixcut_asset_analysis_requests_formula_v9 (
        taskId TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        providerId TEXT NOT NULL,
        model TEXT NOT NULL,
        analysisMode TEXT NOT NULL DEFAULT 'content'
          CHECK(analysisMode IN ('content')),
        createdAt TEXT NOT NULL,
        -- v18 以 ALTER 追加,列序在 createdAt 之后;重建必须保持同样列序
        executionScope TEXT NOT NULL DEFAULT 'external'
          CHECK(executionScope IN ('external','company')),
        FOREIGN KEY(taskId) REFERENCES live_mixcut_tasks_formula_v9(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT
      );
      INSERT INTO live_mixcut_asset_analysis_requests_formula_v9
        (taskId, projectId, batchId, assetId, contentFingerprint, providerId, model, analysisMode, executionScope, createdAt)
      SELECT taskId, projectId, batchId, assetId, contentFingerprint, providerId, model, analysisMode, executionScope, createdAt
      FROM live_mixcut_asset_analysis_requests;

      DROP TABLE live_mixcut_asset_analysis_requests;
      DROP TABLE live_mixcut_task_attempts;
      DROP TABLE live_mixcut_tasks;
      ALTER TABLE live_mixcut_tasks_formula_v9 RENAME TO live_mixcut_tasks;
      ALTER TABLE live_mixcut_task_attempts_formula_v9 RENAME TO live_mixcut_task_attempts;
      ALTER TABLE live_mixcut_asset_analysis_requests_formula_v9 RENAME TO live_mixcut_asset_analysis_requests;

      CREATE INDEX IF NOT EXISTS idx_live_mixcut_tasks_batch
        ON live_mixcut_tasks(batchId, status, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_live_mixcut_tasks_request_key
        ON live_mixcut_tasks(requestKey) WHERE requestKey IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_live_mixcut_task_attempts_task
        ON live_mixcut_task_attempts(taskId, attemptNumber);
      CREATE INDEX IF NOT EXISTS idx_live_mixcut_asset_analysis_requests_asset
        ON live_mixcut_asset_analysis_requests(projectId, assetId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_live_mixcut_asset_analysis_requests_batch
        ON live_mixcut_asset_analysis_requests(batchId, createdAt);
`;

/** 未知扩展不能在重建时被静默丢弃；保留原库并让公式能力单独不可用。 */
export function assertFormulaTaskRebuildSafe(db: Database.Database): void {
  const columns: Record<string, string[]> = {
    live_mixcut_tasks: 'id projectId batchId workType targetKind targetId status requestKey expectedState progressJson attemptCount createdAt updatedAt'.split(' '),
    live_mixcut_task_attempts: 'id taskId attemptNumber status progressJson resultJson errorCode errorMessage claimedBy leaseExpiresAt heartbeatAt adapterVersion remoteTaskId startedAt finishedAt createdAt'.split(' '),
    live_mixcut_asset_analysis_requests: 'taskId projectId batchId assetId contentFingerprint providerId model analysisMode createdAt executionScope'.split(' '),
  };
  const indexes = new Set(['idx_live_mixcut_tasks_batch','idx_live_mixcut_tasks_request_key','idx_live_mixcut_task_attempts_task','idx_live_mixcut_asset_analysis_requests_asset','idx_live_mixcut_asset_analysis_requests_batch']);
  for (const [table, expected] of Object.entries(columns)) {
    const actual = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (JSON.stringify(actual.map(row => row.name).sort()) !== JSON.stringify([...expected].sort())) throw new Error('共享任务表含未识别字段，不能重建');
    const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE tbl_name=? AND type IN ('trigger','index') AND sql IS NOT NULL").all(table) as Array<{ type: string; name: string }>;
    if (objects.some(object => object.type === 'trigger' || !indexes.has(object.name))) throw new Error('共享任务表含未识别约束，不能重建');
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const escaped = name.replaceAll('"', '""');
    const references = db.prepare(`PRAGMA foreign_key_list("${escaped}")`).all() as Array<{ table: string }>;
    if (references.some(ref => ref.table in columns && !(ref.table === 'live_mixcut_tasks'
      && ['live_mixcut_task_attempts','live_mixcut_asset_analysis_requests'].includes(name)))) throw new Error('共享任务表存在未识别引用，不能重建');
  }
}
