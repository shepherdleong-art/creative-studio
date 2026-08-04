import type Database from 'better-sqlite3';
import {
  BatchSchemaBackupError,
  createValidatedBatchSchemaBackup,
  type BatchSchemaBackupManifest,
  type BatchSchemaDiskSpaceProbe,
} from './backup.ts';

export interface BatchSchemaMigration {
  version: number;
  sql: string;
}

export const BATCH_SCHEMA_MIGRATIONS: ReadonlyArray<BatchSchemaMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_productions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_productions_project
        ON batch_productions(projectId, updatedAt);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_assets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('linked', 'managed')),
        locationJson TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        mediaKind TEXT NOT NULL CHECK(mediaKind IN ('video', 'image')),
        mediaJson TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'archived')),
        currentAnalysisId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, contentFingerprint),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_assets_identity
        ON batch_assets(projectId, contentFingerprint);
      CREATE INDEX IF NOT EXISTS idx_batch_assets_project
        ON batch_assets(projectId, updatedAt);

      CREATE TABLE IF NOT EXISTS batch_asset_analysis (
        id TEXT PRIMARY KEY,
        assetId TEXT NOT NULL,
        analyzerVersion TEXT NOT NULL,
        providerId TEXT NOT NULL,
        model TEXT NOT NULL,
        analysisJson TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
        errorCode TEXT,
        errorMessage TEXT,
        analyzedAt TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_analysis_asset
        ON batch_asset_analysis(assetId, createdAt);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE batch_productions ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';
      ALTER TABLE batch_productions ADD COLUMN currentVersionId TEXT;
      ALTER TABLE batch_productions ADD COLUMN progressJson TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS batch_production_versions (
        id TEXT PRIMARY KEY,
        batchId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        copyCount INTEGER NOT NULL,
        defaultsJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        UNIQUE(batchId, versionNumber),
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_production_versions_batch
        ON batch_production_versions(batchId, versionNumber);

      CREATE TABLE IF NOT EXISTS batch_asset_pool_items (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        analysisId TEXT NOT NULL,
        selectionState TEXT NOT NULL DEFAULT 'selected',
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, assetId),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE RESTRICT,
        FOREIGN KEY(analysisId) REFERENCES batch_asset_analysis(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_pool_items_version
        ON batch_asset_pool_items(batchVersionId, assetId);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_scripts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('script_draft', 'external')),
        sourceId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, sourceId),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS batch_script_snapshots (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        sourceScriptId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        copyCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, sourceScriptId),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(sourceScriptId) REFERENCES batch_scripts(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_script_snapshots_version
        ON batch_script_snapshots(batchVersionId, sourceScriptId);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_output_plans (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        scriptSnapshotId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        planJson TEXT NOT NULL DEFAULT '{}',
        currentVersionId TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, seq),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(scriptSnapshotId) REFERENCES batch_script_snapshots(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_output_plans_version
        ON batch_output_plans(batchVersionId, seq);

      CREATE TABLE IF NOT EXISTS batch_output_versions (
        id TEXT PRIMARY KEY,
        planId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        arrangementJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        UNIQUE(planId, versionNumber),
        FOREIGN KEY(planId) REFERENCES batch_output_plans(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_output_versions_plan
        ON batch_output_versions(planId, versionNumber);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_tasks (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        workType TEXT NOT NULL CHECK(workType IN ('asset_prepare', 'render')),
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        attemptCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch
        ON batch_tasks(batchId, status, createdAt);

      CREATE TABLE IF NOT EXISTS batch_task_attempts (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        attemptNumber INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'cancelled')),
        progressJson TEXT NOT NULL DEFAULT '{}',
        resultJson TEXT,
        errorCode TEXT,
        errorMessage TEXT,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        createdAt TEXT NOT NULL,
        UNIQUE(taskId, attemptNumber),
        FOREIGN KEY(taskId) REFERENCES batch_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_task_attempts_task
        ON batch_task_attempts(taskId, attemptNumber);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_artifacts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        batchVersionId TEXT NOT NULL,
        outputPlanId TEXT NOT NULL,
        outputVersionId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('video', 'cover')),
        relativePath TEXT NOT NULL,
        checksum TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(outputPlanId, outputVersionId, kind),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(outputPlanId) REFERENCES batch_output_plans(id) ON DELETE CASCADE,
        FOREIGN KEY(outputVersionId) REFERENCES batch_output_versions(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_artifacts_plan
        ON batch_artifacts(outputPlanId, createdAt);

      ALTER TABLE batch_output_plans ADD COLUMN currentArtifactId TEXT;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE batch_artifacts_new (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        batchVersionId TEXT NOT NULL,
        outputPlanId TEXT NOT NULL,
        outputVersionId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('video', 'cover')),
        relativePath TEXT NOT NULL,
        checksum TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(outputPlanId, relativePath),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE RESTRICT,
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE RESTRICT,
        FOREIGN KEY(outputPlanId) REFERENCES batch_output_plans(id) ON DELETE RESTRICT,
        FOREIGN KEY(outputVersionId) REFERENCES batch_output_versions(id) ON DELETE RESTRICT
      );
      INSERT INTO batch_artifacts_new SELECT id, projectId, batchId, batchVersionId, outputPlanId, outputVersionId, kind, relativePath, checksum, createdAt FROM batch_artifacts;
      DROP TABLE batch_artifacts;
      ALTER TABLE batch_artifacts_new RENAME TO batch_artifacts;
      CREATE INDEX IF NOT EXISTS idx_batch_artifacts_plan ON batch_artifacts(outputPlanId, createdAt);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE batch_productions ADD COLUMN deletedAt TEXT;

      ALTER TABLE batch_production_versions
        ADD COLUMN inputState TEXT NOT NULL DEFAULT 'frozen'
        CHECK(inputState IN ('draft', 'frozen'));
      ALTER TABLE batch_production_versions ADD COLUMN frozenAt TEXT;

      UPDATE batch_production_versions
      SET inputState = 'draft', frozenAt = NULL
      WHERE id IN (
        SELECT currentVersionId
        FROM batch_productions
        WHERE status = 'draft'
          AND currentVersionId IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM batch_tasks t WHERE t.batchId = batch_productions.id
          )
      );
      UPDATE batch_production_versions
      SET frozenAt = createdAt
      WHERE inputState = 'frozen' AND frozenAt IS NULL;

      ALTER TABLE batch_scripts
        ADD COLUMN ownerBatchVersionId TEXT
        REFERENCES batch_production_versions(id) ON DELETE RESTRICT;
      ALTER TABLE batch_scripts ADD COLUMN externalSourceId TEXT;
      UPDATE batch_scripts
      SET
        ownerBatchVersionId = (
          SELECT MIN(s.batchVersionId)
          FROM batch_script_snapshots s
          WHERE s.sourceScriptId = batch_scripts.id
        ),
        externalSourceId = sourceId
      WHERE sourceKind = 'external'
        AND 1 = (
          SELECT COUNT(DISTINCT s.batchVersionId)
          FROM batch_script_snapshots s
          WHERE s.sourceScriptId = batch_scripts.id
        );
      CREATE INDEX idx_batch_scripts_owner_version
        ON batch_scripts(ownerBatchVersionId, createdAt);
      CREATE UNIQUE INDEX idx_batch_external_scripts_source
        ON batch_scripts(ownerBatchVersionId, externalSourceId)
        WHERE sourceKind = 'external';
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS batch_asset_sources (
        id TEXT PRIMARY KEY,
        assetId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('module4', 'managed', 'linked')),
        locationJson TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'healthy' CHECK(health IN ('healthy', 'offline', 'changed')),
        createdAt TEXT NOT NULL,
        UNIQUE(assetId, sourceKind, locationJson),
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_sources_asset
        ON batch_asset_sources(assetId, createdAt);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE batch_scripts ADD COLUMN coverTitleJson TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE batch_scripts ADD COLUMN shotSetId TEXT NOT NULL DEFAULT '';
      ALTER TABLE batch_scripts ADD COLUMN contentRevision TEXT NOT NULL DEFAULT '';
      ALTER TABLE batch_script_snapshots ADD COLUMN coverTitleJson TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE batch_script_snapshots ADD COLUMN shotSetId TEXT NOT NULL DEFAULT '';
      ALTER TABLE batch_script_snapshots ADD COLUMN contentRevision TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE batch_scripts ADD COLUMN sourceAvailable INTEGER NOT NULL DEFAULT 1 CHECK(sourceAvailable IN (0, 1));
      ALTER TABLE batch_scripts ADD COLUMN catalogManaged INTEGER NOT NULL DEFAULT 0 CHECK(catalogManaged IN (0, 1));
      UPDATE batch_scripts
      SET catalogManaged = 1
      WHERE sourceKind = 'script_draft'
        AND ownerBatchVersionId IS NULL
        AND contentRevision <> '';
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE batch_tasks ADD COLUMN requestKey TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_tasks_request_key
        ON batch_tasks(requestKey) WHERE requestKey IS NOT NULL;
      ALTER TABLE batch_tasks ADD COLUMN expectedState TEXT NOT NULL DEFAULT 'running'
        CHECK(expectedState IN ('running', 'paused', 'stopped'));
      ALTER TABLE batch_productions ADD COLUMN controlState TEXT NOT NULL DEFAULT 'running'
        CHECK(controlState IN ('running', 'paused', 'stopped'));

      CREATE TABLE batch_task_attempts_new (
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
        FOREIGN KEY(taskId) REFERENCES batch_tasks(id) ON DELETE CASCADE
      );
      INSERT INTO batch_task_attempts_new
        (id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, startedAt, finishedAt, createdAt)
      SELECT id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, startedAt, finishedAt, createdAt
      FROM batch_task_attempts;
      DROP TABLE batch_task_attempts;
      ALTER TABLE batch_task_attempts_new RENAME TO batch_task_attempts;
      CREATE INDEX IF NOT EXISTS idx_batch_task_attempts_task
        ON batch_task_attempts(taskId, attemptNumber);
    `,
  },
  {
    version: 14,
    sql: `
      -- LUT 受管内容身份:项目作用域、完整内容指纹、受管相对路径、显示名、验证信息、active/archived 状态
      CREATE TABLE IF NOT EXISTS batch_luts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        displayName TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        fileSizeBytes INTEGER NOT NULL,
        verifiedAt TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(projectId, contentFingerprint),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_luts_identity
        ON batch_luts(projectId, contentFingerprint);
      CREATE INDEX IF NOT EXISTS idx_batch_luts_project
        ON batch_luts(projectId, status, createdAt);

      -- 批次版本中每份素材的显式色彩快照(关闭或引用一个已验证 LUT);关闭也必须是确定状态,
      -- 因此用 NOT NULL DEFAULT 而不是可空列。
      ALTER TABLE batch_asset_pool_items ADD COLUMN colorJson TEXT NOT NULL DEFAULT '{"lutId":null}';

      -- 代理缓存项:proxyKey 是原片指纹+profile+色彩快照+色彩链版本共同派生的全局唯一身份
      CREATE TABLE IF NOT EXISTS batch_proxy_cache_items (
        id TEXT PRIMARY KEY,
        proxyKey TEXT NOT NULL,
        projectId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        profileVersion TEXT NOT NULL,
        colorJson TEXT NOT NULL DEFAULT '{"lutId":null}',
        relativePath TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'ready', 'failed')),
        mediaJson TEXT NOT NULL DEFAULT '{}',
        fileSizeBytes INTEGER NOT NULL DEFAULT 0,
        checksum TEXT,
        pendingDeleteAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(proxyKey),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_proxy_cache_items_key
        ON batch_proxy_cache_items(proxyKey);
      CREATE INDEX IF NOT EXISTS idx_batch_proxy_cache_items_project
        ON batch_proxy_cache_items(projectId, assetId, status);

      -- 扩展 batch_tasks.workType 支持 proxy_generate(targetKind 本身没有 CHECK,可直接使用 proxy_request)。
      -- batch_tasks 是 batch_task_attempts 的 FK 父表:SQLite 在 foreign_keys=ON 时,
      -- DROP TABLE 父表会先对其做隐式 DELETE 并触发子表 ON DELETE CASCADE,
      -- 若直接 DROP 旧 batch_tasks 会连带清空全部历史 batch_task_attempts。
      -- 因此必须先让新 attempts 表引用新 tasks 表(此时旧表仍持有全部数据),
      -- 依次丢弃旧 attempts(叶子表,无人引用它,可安全 DROP)、
      -- 再丢弃旧 tasks(此时已没有任何表引用它,DROP 不会级联到任何数据),
      -- 最后把两张新表分别改名到位——SQLite 的表改名会自动重写引用它的外键定义。
      CREATE TABLE batch_tasks_v14 (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        workType TEXT NOT NULL CHECK(workType IN ('asset_prepare', 'render', 'proxy_generate')),
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
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE
      );
      INSERT INTO batch_tasks_v14
        (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
      SELECT id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt
      FROM batch_tasks;

      CREATE TABLE batch_task_attempts_v14 (
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
        FOREIGN KEY(taskId) REFERENCES batch_tasks_v14(id) ON DELETE CASCADE
      );
      INSERT INTO batch_task_attempts_v14
        (id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, claimedBy, leaseExpiresAt, heartbeatAt, adapterVersion, remoteTaskId, startedAt, finishedAt, createdAt)
      SELECT id, taskId, attemptNumber, status, progressJson, resultJson, errorCode, errorMessage, claimedBy, leaseExpiresAt, heartbeatAt, adapterVersion, remoteTaskId, startedAt, finishedAt, createdAt
      FROM batch_task_attempts;

      DROP TABLE batch_task_attempts;
      DROP TABLE batch_tasks;
      ALTER TABLE batch_tasks_v14 RENAME TO batch_tasks;
      ALTER TABLE batch_task_attempts_v14 RENAME TO batch_task_attempts;

      CREATE INDEX IF NOT EXISTS idx_batch_tasks_batch
        ON batch_tasks(batchId, status, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_tasks_request_key
        ON batch_tasks(requestKey) WHERE requestKey IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_batch_task_attempts_task
        ON batch_task_attempts(taskId, attemptNumber);
    `,
  },
  {
    version: 15,
    sql: `
      -- Phase D v15(修正版):统一内容指纹 + 升级完整色彩快照 + 建立持久化代理请求。
      --
      -- 修复顺序(必须先确定规范 LUT 身份,再重映射引用,最后归一化指纹):
      -- 1. 同项目内裸 hex 与 sha256:<hex> 可能指向同一内容:先按规范化指纹分组,
      --    确定每组的规范 LUT 身份(引用优先 > 创建时间早 > active 优先 > id 字典序),
      --    把所有素材池/代理缓存/既有代理任务的 lutId 引用重映射到规范身份。
      -- 2. 删除重复 LUT 行(引用已全部重映射,删除不会留下悬空引用)。
      -- 3. 归一化指纹为 sha256:<hex>(重复已消除,UPDATE 不会再撞 UNIQUE)。
      -- 4. 把素材池与代理缓存的 colorJson 升级为完整 ColorSnapshotV1;
      --    引用 LUT 却解析不到真实指纹时写入 'unresolved:' 标记(非空、显式不可用),
      --    绝不允许静默生成空指纹伪装成关闭状态。
      -- 5. 建立 batch_proxy_requests:每个请求固定 project/batch/batchVersion/asset/
      --    原片指纹/完整色彩快照/proxyKey/当前 cache 引用/请求状态;
      --    batch_tasks.targetKind=proxy_request 的 targetId 指向请求而非可删除的 cache 行。
      -- 6. 既有 proxy_generate 任务从指向 cache item 迁移为指向新请求。

      -- Step 1: 每项目每规范化指纹确定规范 LUT 身份(引用数 > createdAt > active > id)。
      CREATE TEMP TABLE batch_lut_identity_map AS
      SELECT projectId, normFingerprint, id AS canonicalLutId
      FROM (
        SELECT
          l.id, l.projectId, l.createdAt, l.status,
          CASE WHEN l.contentFingerprint LIKE 'sha256:%' THEN l.contentFingerprint
               ELSE 'sha256:' || l.contentFingerprint END AS normFingerprint,
          (SELECT COUNT(*) FROM batch_asset_pool_items p
           WHERE json_extract(p.colorJson, '$.lutId') = l.id) AS refCount
        FROM batch_luts l
      ) ranked
      WHERE NOT EXISTS (
        SELECT 1
        FROM batch_luts l2
        WHERE l2.projectId = ranked.projectId
          AND (CASE WHEN l2.contentFingerprint LIKE 'sha256:%' THEN l2.contentFingerprint
                    ELSE 'sha256:' || l2.contentFingerprint END) = ranked.normFingerprint
          AND (
            (SELECT COUNT(*) FROM batch_asset_pool_items p2
             WHERE json_extract(p2.colorJson, '$.lutId') = l2.id) > ranked.refCount
            OR (
              (SELECT COUNT(*) FROM batch_asset_pool_items p2
               WHERE json_extract(p2.colorJson, '$.lutId') = l2.id) = ranked.refCount
              AND (l2.createdAt < ranked.createdAt
                   OR (l2.createdAt = ranked.createdAt
                       AND (l2.status = 'active' AND ranked.status <> 'active'
                            OR (l2.status = ranked.status AND l2.id < ranked.id))))
            )
          )
      );

      -- Step 2: 素材池与代理缓存的 lutId 引用重映射到规范身份
      -- (已经是规范身份的 id 重映射到自身,结果不变)。
      UPDATE batch_asset_pool_items
      SET colorJson = json_set(colorJson, '$.lutId', COALESCE(
        (SELECT m.canonicalLutId
         FROM batch_lut_identity_map m
         JOIN batch_luts l ON l.id = json_extract(batch_asset_pool_items.colorJson, '$.lutId')
         WHERE m.projectId = l.projectId
           AND m.normFingerprint = (CASE WHEN l.contentFingerprint LIKE 'sha256:%' THEN l.contentFingerprint
                                         ELSE 'sha256:' || l.contentFingerprint END)),
        json_extract(batch_asset_pool_items.colorJson, '$.lutId')
      ))
      WHERE json_extract(colorJson, '$.lutId') IS NOT NULL;

      UPDATE batch_proxy_cache_items
      SET colorJson = json_set(colorJson, '$.lutId', COALESCE(
        (SELECT m.canonicalLutId
         FROM batch_lut_identity_map m
         JOIN batch_luts l ON l.id = json_extract(batch_proxy_cache_items.colorJson, '$.lutId')
         WHERE m.projectId = l.projectId
           AND m.normFingerprint = (CASE WHEN l.contentFingerprint LIKE 'sha256:%' THEN l.contentFingerprint
                                         ELSE 'sha256:' || l.contentFingerprint END)),
        json_extract(batch_proxy_cache_items.colorJson, '$.lutId')
      ))
      WHERE json_extract(colorJson, '$.lutId') IS NOT NULL;

      -- Step 3: 删除重复 LUT 行(规范身份之外的全部删除)
      DELETE FROM batch_luts
      WHERE id NOT IN (SELECT canonicalLutId FROM batch_lut_identity_map);

      -- Step 4: 归一化指纹为 sha256:<hex>(64 位小写 hex;重复已消除,不再撞 UNIQUE)
      UPDATE batch_luts
      SET contentFingerprint = 'sha256:' || contentFingerprint
      WHERE contentFingerprint NOT LIKE 'sha256:%'
        AND LENGTH(contentFingerprint) = 64
        AND LOWER(contentFingerprint) = contentFingerprint
        AND contentFingerprint NOT GLOB '*[^a-f0-9]*';

      -- Step 5: 升级素材池色彩快照为完整 ColorSnapshotV1。
      -- lutId 非空时指纹一律从 batch_luts 权威解析;解析不到(悬空引用)写
      -- 'unresolved:' 标记——非空、显式失败,不允许用空字符串伪装成关闭。
      UPDATE batch_asset_pool_items
      SET colorJson = (
        SELECT CASE
          WHEN json_extract(batch_asset_pool_items.colorJson, '$.lutId') IS NULL THEN
            '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}'
          ELSE
            json_set(json_set(json_set(json_set(
              json_set(batch_asset_pool_items.colorJson, '$.lutFingerprint',
                COALESCE(
                  (SELECT l.contentFingerprint FROM batch_luts l
                   WHERE l.id = json_extract(batch_asset_pool_items.colorJson, '$.lutId')),
                  'unresolved:' || json_extract(batch_asset_pool_items.colorJson, '$.lutId')
                )),
              '$.colorPipelineVersion', 'color-v1'),
              '$.interpolation', 'trilinear'),
              '$.outputContract', 'sdr-v1'))
        END
      );

      -- Step 6: 同样升级代理缓存项的色彩快照
      UPDATE batch_proxy_cache_items
      SET colorJson = (
        SELECT CASE
          WHEN json_extract(batch_proxy_cache_items.colorJson, '$.lutId') IS NULL THEN
            '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}'
          ELSE
            json_set(json_set(json_set(json_set(
              json_set(batch_proxy_cache_items.colorJson, '$.lutFingerprint',
                COALESCE(
                  (SELECT l.contentFingerprint FROM batch_luts l
                   WHERE l.id = json_extract(batch_proxy_cache_items.colorJson, '$.lutId')),
                  'unresolved:' || json_extract(batch_proxy_cache_items.colorJson, '$.lutId')
                )),
              '$.colorPipelineVersion', 'color-v1'),
              '$.interpolation', 'trilinear'),
              '$.outputContract', 'sdr-v1'))
        END
      );

      -- Step 7: 持久化代理请求表。请求是稳定身份,cache 可删除但请求不能悬空;
      -- currentCacheItemId 外键 ON DELETE SET NULL,缓存行被清理后请求仍保留。
      CREATE TABLE IF NOT EXISTS batch_proxy_requests (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT NOT NULL,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        contentFingerprint TEXT NOT NULL,
        colorJson TEXT NOT NULL,
        profileVersion TEXT NOT NULL,
        colorPipelineVersion TEXT NOT NULL,
        proxyKey TEXT NOT NULL,
        currentCacheItemId TEXT,
        status TEXT NOT NULL DEFAULT 'requested'
          CHECK(status IN ('requested', 'generating', 'ready', 'failed', 'cancelled')),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(batchVersionId, assetId, proxyKey),
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE CASCADE,
        FOREIGN KEY(currentCacheItemId) REFERENCES batch_proxy_cache_items(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_batch_proxy_requests_version
        ON batch_proxy_requests(batchVersionId, assetId);
      CREATE INDEX IF NOT EXISTS idx_batch_proxy_requests_cache
        ON batch_proxy_requests(currentCacheItemId);

      -- Step 8: v14 代理任务只保存了 cache target，没有直接保存批次版本。
      -- 不能把它们一律挂到 currentVersionId：任务创建后用户可能已切换版本、
      -- 移除素材或改变 LUT。按任务创建时已经存在的历史版本素材池，以及升级后的
      -- 完整色彩身份回溯其兼容版本；相同输入的多个历史版本取创建时间不晚于任务的
      -- 最新版本。无法安全回溯的异常旧任务会在下方隔离取消，不能阻塞整个旧库升级。
      CREATE TEMP TABLE batch_proxy_legacy_task_versions AS
      SELECT
        t.id AS taskId,
        (
          SELECT v.id
          FROM batch_production_versions v
          JOIN batch_asset_pool_items historicalPool
            ON historicalPool.batchVersionId = v.id
          WHERE v.batchId = t.batchId
            AND v.createdAt <= t.createdAt
            AND historicalPool.assetId = c.assetId
            AND json_extract(historicalPool.colorJson, '$.lutId')
                IS json_extract(c.colorJson, '$.lutId')
            AND json_extract(historicalPool.colorJson, '$.lutFingerprint')
                IS json_extract(c.colorJson, '$.lutFingerprint')
            AND json_extract(historicalPool.colorJson, '$.colorPipelineVersion')
                IS json_extract(c.colorJson, '$.colorPipelineVersion')
            AND json_extract(historicalPool.colorJson, '$.interpolation')
                IS json_extract(c.colorJson, '$.interpolation')
            AND json_extract(historicalPool.colorJson, '$.outputContract')
                IS json_extract(c.colorJson, '$.outputContract')
          ORDER BY v.createdAt DESC, v.versionNumber DESC, v.id DESC
          LIMIT 1
        ) AS batchVersionId
      FROM batch_tasks t
      JOIN batch_proxy_cache_items c ON c.id = t.targetId
      WHERE t.workType = 'proxy_generate' AND t.targetKind = 'proxy_request';

      INSERT OR IGNORE INTO batch_proxy_requests
        (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
         profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
      SELECT
        lower(hex(randomblob(16))),
        t.projectId, t.batchId, mapping.batchVersionId,
        c.assetId, a.contentFingerprint, c.colorJson, c.profileVersion, 'color-v1', c.proxyKey, c.id,
        CASE t.status WHEN 'succeeded' THEN 'ready' WHEN 'failed' THEN 'failed'
                      WHEN 'cancelled' THEN 'cancelled' ELSE 'requested' END,
        t.createdAt, t.updatedAt
      FROM batch_tasks t
      JOIN batch_proxy_legacy_task_versions mapping ON mapping.taskId = t.id
      JOIN batch_proxy_cache_items c ON c.id = t.targetId
      JOIN batch_assets a ON a.id = c.assetId
      WHERE mapping.batchVersionId IS NOT NULL;

      UPDATE batch_tasks
      SET targetId = (
        SELECT r.id
        FROM batch_proxy_legacy_task_versions mapping
        JOIN batch_proxy_cache_items c ON c.id = batch_tasks.targetId
        JOIN batch_proxy_requests r
          ON r.batchVersionId = mapping.batchVersionId
         AND r.assetId = c.assetId
         AND r.proxyKey = c.proxyKey
        WHERE mapping.taskId = batch_tasks.id
        LIMIT 1
      )
      WHERE workType = 'proxy_generate' AND targetKind = 'proxy_request'
        AND EXISTS (
          SELECT 1 FROM batch_proxy_legacy_task_versions mapping
          WHERE mapping.taskId = batch_tasks.id AND mapping.batchVersionId IS NOT NULL
        );

      UPDATE batch_tasks
      SET requestKey = 'proxy_generate:' || projectId || ':' || targetId
      WHERE workType = 'proxy_generate' AND targetKind = 'proxy_request'
        AND id IN (
          SELECT taskId FROM batch_proxy_legacy_task_versions WHERE batchVersionId IS NOT NULL
        );

      -- 极端损坏/手工写入的 v14 数据可能找不到任何兼容历史版本。保留任务与 attempt
      -- 历史，但中断仍在运行的 attempt，并把任务改为不可调度的 legacy 隔离目标；
      -- 清空 requestKey 使未来合法请求不被这条历史记录永久占用。
      UPDATE batch_task_attempts
      SET status = 'interrupted',
          errorCode = 'legacy_proxy_lineage_unresolved',
          errorMessage = 'v15 升级无法安全恢复旧代理任务的批次版本谱系',
          leaseExpiresAt = NULL,
          heartbeatAt = NULL,
          finishedAt = COALESCE(finishedAt, (
            SELECT t.updatedAt FROM batch_tasks t WHERE t.id = batch_task_attempts.taskId
          ))
      WHERE status = 'running'
        AND taskId IN (
          SELECT taskId FROM batch_proxy_legacy_task_versions WHERE batchVersionId IS NULL
        );

      UPDATE batch_tasks
      SET status = 'cancelled', targetKind = 'legacy_proxy_cache', requestKey = NULL,
          expectedState = 'stopped'
      WHERE workType = 'proxy_generate' AND targetKind = 'proxy_request'
        AND id IN (
          SELECT taskId FROM batch_proxy_legacy_task_versions WHERE batchVersionId IS NULL
        );

      DROP TABLE batch_proxy_legacy_task_versions;
      DROP TABLE batch_lut_identity_map;
    `,
  },
  {
    version: 16,
    sql: `
      -- Phase E v16:联合分配运行与批次版本素材排除。
      -- 分配结果是可追溯的领域事实,不与代理缓存或渲染任务绑定。
      CREATE TABLE IF NOT EXISTS batch_allocation_runs (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        ruleVersion TEXT NOT NULL,
        seed TEXT NOT NULL,
        inputFingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed'
          CHECK(status IN ('completed', 'partial', 'blocked', 'failed')),
        resultJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, ruleVersion, seed, inputFingerprint),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_batch_allocation_runs_version
        ON batch_allocation_runs(batchVersionId, createdAt, id);

      -- 当前激活运行不能仅由 createdAt 推断：排除恢复可能重新激活一个历史
      -- 确定性运行，而单条重分配又会形成新的运行。
      ALTER TABLE batch_production_versions
        ADD COLUMN currentAllocationRunId TEXT
        REFERENCES batch_allocation_runs(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_batch_versions_current_allocation
        ON batch_production_versions(currentAllocationRunId);

      CREATE TABLE IF NOT EXISTS batch_asset_exclusions (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, assetId),
        FOREIGN KEY(batchVersionId) REFERENCES batch_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_exclusions_version
        ON batch_asset_exclusions(batchVersionId, assetId);

      -- 旧版本允许为空;新分配写入后必须指向同一批次版本的真实运行。
      ALTER TABLE batch_output_versions
        ADD COLUMN allocationRunId TEXT
        REFERENCES batch_allocation_runs(id) ON DELETE RESTRICT;
      CREATE INDEX IF NOT EXISTS idx_batch_output_versions_allocation
        ON batch_output_versions(allocationRunId);
    `,
  },
  {
    version: 17,
    sql: `
      -- 内容分析请求必须冻结素材指纹与视觉供应商身份。任务仍以 asset 为目标，
      -- 这张表只保存该次 asset_prepare 的不可变请求参数，避免重试时悄悄换模型。
      CREATE TABLE IF NOT EXISTS batch_asset_analysis_requests (
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
        FOREIGN KEY(taskId) REFERENCES batch_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES batch_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES batch_assets(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_batch_asset_analysis_requests_asset
        ON batch_asset_analysis_requests(projectId, assetId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_batch_asset_analysis_requests_batch
        ON batch_asset_analysis_requests(batchId, createdAt);
    `,
  },
  {
    version: 18,
    sql: `
      -- 内容分析重试必须保持创建时选择的供应商执行作用域；用户后来把同一
      -- provider 从直连改成公司（或反向）时，旧任务不得静默换路由。
      ALTER TABLE batch_asset_analysis_requests
        ADD COLUMN executionScope TEXT NOT NULL DEFAULT 'external'
        CHECK(executionScope IN ('external','company'));
    `,
  },
];

export type BatchSchemaFailureCode =
  | 'schema_history_invalid'
  | 'schema_too_new'
  | 'backup_failed'
  | 'backup_validation_failed'
  | 'insufficient_disk_space'
  | 'migration_failed';

export type BatchSchemaReadiness =
  | {
      state: 'current' | 'ready';
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: BatchSchemaBackupManifest;
    }
  | {
      state: 'compatibility_only';
      code: BatchSchemaFailureCode;
      message: string;
      appliedVersions: number[];
      targetVersion: number;
      backupDirectory?: string;
      backupManifest?: BatchSchemaBackupManifest;
    };

export interface EnsureBatchSchemaOptions {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: BatchSchemaDiskSpaceProbe;
}

const MIGRATION_TABLE = 'batch_schema_migrations';

function migrationTableExists(db: Database.Database): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(MIGRATION_TABLE));
}

function readAppliedVersions(db: Database.Database): number[] {
  if (!migrationTableExists(db)) return [];
  return (db.prepare(
    `SELECT version FROM batch_schema_migrations ORDER BY version`,
  ).all() as Array<{ version: number }>).map(({ version }) => version);
}

function validateMigrationHistory(appliedVersions: number[]): BatchSchemaFailureCode | null {
  const knownVersions = BATCH_SCHEMA_MIGRATIONS.map(({ version }) => version);
  const knownSet = new Set(knownVersions);
  if (appliedVersions.some((version) => version > (knownVersions.at(-1) ?? 0))) {
    return 'schema_too_new';
  }
  if (appliedVersions.some((version) => !knownSet.has(version))) {
    return 'schema_history_invalid';
  }
  const appliedSet = new Set(appliedVersions);
  const highestApplied = appliedVersions.at(-1) ?? 0;
  if (knownVersions.some((version) => version <= highestApplied && !appliedSet.has(version))) {
    return 'schema_history_invalid';
  }
  return null;
}

function validateBatchProductionTable(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    byName.get('id')?.pk !== 1
    || byName.get('projectId')?.notnull !== 1
    || byName.get('name')?.notnull !== 1
    || byName.get('createdAt')?.notnull !== 1
    || byName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('批量 schema 结构检查未通过');
  }

  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(batch_productions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!foreignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('批量 schema 项目外键检查未通过');
  }

  const indexes = db.prepare(`PRAGMA index_list(batch_productions)`).all() as Array<{ name: string }>;
  if (!indexes.some(({ name }) => name === 'idx_batch_productions_project')) {
    throw new Error('批量 schema 索引检查未通过');
  }
}

function validateAssetsTables(db: Database.Database): void {
  const assetColumns = db.prepare(`PRAGMA table_info(batch_assets)`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const assetByName = new Map(assetColumns.map((column) => [column.name, column]));
  if (
    assetByName.get('id')?.pk !== 1
    || assetByName.get('projectId')?.notnull !== 1
    || assetByName.get('sourceKind')?.notnull !== 1
    || assetByName.get('locationJson')?.notnull !== 1
    || assetByName.get('contentFingerprint')?.notnull !== 1
    || assetByName.get('mediaKind')?.notnull !== 1
    || assetByName.get('status')?.notnull !== 1
    || assetByName.get('createdAt')?.notnull !== 1
    || assetByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('素材表结构检查未通过');
  }

  const assetForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_assets)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!assetForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材表项目外键检查未通过');
  }

  const assetIndexes = db.prepare(`PRAGMA index_list(batch_assets)`).all() as Array<{ name: string; unique: number }>;
  if (!assetIndexes.some(({ name, unique }) => name === 'idx_batch_assets_identity' && unique === 1)) {
    throw new Error('素材身份唯一索引检查未通过');
  }
  if (!assetIndexes.some(({ name }) => name === 'idx_batch_assets_project')) {
    throw new Error('素材项目索引检查未通过');
  }

  const analysisColumns = db.prepare(`PRAGMA table_info(batch_asset_analysis)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const analysisByName = new Map(analysisColumns.map((column) => [column.name, column]));
  if (
    analysisByName.get('id')?.pk !== 1
    || analysisByName.get('assetId')?.notnull !== 1
    || analysisByName.get('analyzerVersion')?.notnull !== 1
    || analysisByName.get('providerId')?.notnull !== 1
    || analysisByName.get('model')?.notnull !== 1
    || analysisByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('素材分析表结构检查未通过');
  }

  const analysisForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_analysis)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!analysisForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材分析表素材外键检查未通过');
  }

  const analysisIndexes = db.prepare(`PRAGMA index_list(batch_asset_analysis)`).all() as Array<{ name: string }>;
  if (!analysisIndexes.some(({ name }) => name === 'idx_batch_asset_analysis_asset')) {
    throw new Error('素材分析索引检查未通过');
  }
}

function validateProductionVersionTables(db: Database.Database): void {
  const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const productionByName = new Map(productionColumns.map((column) => [column.name, column]));
  if (
    productionByName.get('status')?.notnull !== 1
    || productionByName.get('progressJson')?.notnull !== 1
  ) {
    throw new Error('批次表扩展列检查未通过');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const versionByName = new Map(versionColumns.map((column) => [column.name, column]));
  if (
    versionByName.get('id')?.pk !== 1
    || versionByName.get('batchId')?.notnull !== 1
    || versionByName.get('versionNumber')?.notnull !== 1
    || versionByName.get('copyCount')?.notnull !== 1
    || versionByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('批次版本表结构检查未通过');
  }

  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_production_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!versionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_productions'
    && foreignKey.from === 'batchId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('批次版本表批次外键检查未通过');
  }

  const versionIndexes = db.prepare(`PRAGMA index_list(batch_production_versions)`).all() as Array<{ name: string }>;
  if (!versionIndexes.some(({ name }) => name === 'idx_batch_production_versions_batch')) {
    throw new Error('批次版本索引检查未通过');
  }

  const poolColumns = db.prepare(`PRAGMA table_info(batch_asset_pool_items)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const poolByName = new Map(poolColumns.map((column) => [column.name, column]));
  if (
    poolByName.get('id')?.pk !== 1
    || poolByName.get('batchVersionId')?.notnull !== 1
    || poolByName.get('assetId')?.notnull !== 1
    || poolByName.get('analysisId')?.notnull !== 1
    || poolByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('素材池表结构检查未通过');
  }

  const poolForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_pool_items)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!poolForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材池表版本外键检查未通过');
  }
  if (!poolForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('素材池表必须限制被引用素材删除');
  }
  if (!poolForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_asset_analysis'
    && foreignKey.from === 'analysisId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('素材池表必须限制被引用的分析版本删除');
  }

  const poolIndexes = db.prepare(`PRAGMA index_list(batch_asset_pool_items)`).all() as Array<{ name: string }>;
  if (!poolIndexes.some(({ name }) => name === 'idx_batch_asset_pool_items_version')) {
    throw new Error('素材池索引检查未通过');
  }
}

function validateScriptTables(db: Database.Database): void {
  const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const scriptByName = new Map(scriptColumns.map((column) => [column.name, column]));
  if (
    scriptByName.get('id')?.pk !== 1
    || scriptByName.get('projectId')?.notnull !== 1
    || scriptByName.get('sourceId')?.notnull !== 1
    || scriptByName.get('title')?.notnull !== 1
    || scriptByName.get('bodyText')?.notnull !== 1
    || scriptByName.get('sourceVersion')?.notnull !== 1
    || scriptByName.get('createdAt')?.notnull !== 1
    || scriptByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('项目脚本表结构检查未通过');
  }

  const scriptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_scripts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!scriptForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('项目脚本表项目外键检查未通过');
  }

  const snapshotColumns = db.prepare(`PRAGMA table_info(batch_script_snapshots)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const snapshotByName = new Map(snapshotColumns.map((column) => [column.name, column]));
  if (
    snapshotByName.get('id')?.pk !== 1
    || snapshotByName.get('batchVersionId')?.notnull !== 1
    || snapshotByName.get('sourceScriptId')?.notnull !== 1
    || snapshotByName.get('title')?.notnull !== 1
    || snapshotByName.get('bodyText')?.notnull !== 1
    || snapshotByName.get('copyCount')?.notnull !== 1
    || snapshotByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('脚本快照表结构检查未通过');
  }

  const snapshotForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_script_snapshots)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!snapshotForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('脚本快照表批次版本外键检查未通过');
  }
  if (!snapshotForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_scripts'
    && foreignKey.from === 'sourceScriptId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('脚本快照表必须限制来源脚本删除');
  }

  const snapshotIndexes = db.prepare(`PRAGMA index_list(batch_script_snapshots)`).all() as Array<{ name: string }>;
  if (!snapshotIndexes.some(({ name }) => name === 'idx_batch_script_snapshots_version')) {
    throw new Error('脚本快照索引检查未通过');
  }
}

function validatePlanTables(db: Database.Database): void {
  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const planByName = new Map(planColumns.map((column) => [column.name, column]));
  if (
    planByName.get('id')?.pk !== 1
    || planByName.get('batchVersionId')?.notnull !== 1
    || planByName.get('scriptSnapshotId')?.notnull !== 1
    || planByName.get('seq')?.notnull !== 1
    || planByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('成片计划表结构检查未通过');
  }

  const planForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_plans)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!planForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('成片计划表批次版本外键检查未通过');
  }
  if (!planForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_script_snapshots'
    && foreignKey.from === 'scriptSnapshotId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('成片计划表脚本快照外键检查未通过');
  }

  const planIndexes = db.prepare(`PRAGMA index_list(batch_output_plans)`).all() as Array<{ name: string }>;
  if (!planIndexes.some(({ name }) => name === 'idx_batch_output_plans_version')) {
    throw new Error('成片计划索引检查未通过');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_output_versions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const versionByName = new Map(versionColumns.map((column) => [column.name, column]));
  if (
    versionByName.get('id')?.pk !== 1
    || versionByName.get('planId')?.notnull !== 1
    || versionByName.get('versionNumber')?.notnull !== 1
    || versionByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('成片版本表结构检查未通过');
  }

  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!versionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_output_plans'
    && foreignKey.from === 'planId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('成片版本表计划外键检查未通过');
  }

  const versionIndexes = db.prepare(`PRAGMA index_list(batch_output_versions)`).all() as Array<{ name: string }>;
  if (!versionIndexes.some(({ name }) => name === 'idx_batch_output_versions_plan')) {
    throw new Error('成片版本索引检查未通过');
  }
}

function validateTaskTables(db: Database.Database): void {
  const taskColumns = db.prepare(`PRAGMA table_info(batch_tasks)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const taskByName = new Map(taskColumns.map((column) => [column.name, column]));
  if (
    taskByName.get('id')?.pk !== 1
    || taskByName.get('projectId')?.notnull !== 1
    || taskByName.get('batchId')?.notnull !== 1
    || taskByName.get('workType')?.notnull !== 1
    || taskByName.get('targetKind')?.notnull !== 1
    || taskByName.get('targetId')?.notnull !== 1
    || taskByName.get('status')?.notnull !== 1
    || taskByName.get('createdAt')?.notnull !== 1
    || taskByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('生产任务表结构检查未通过');
  }

  const taskForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_tasks)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!taskForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_productions'
    && foreignKey.from === 'batchId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('生产任务表批次外键检查未通过');
  }
  if (!taskForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('生产任务表项目外键检查未通过');
  }

  const taskIndexes = db.prepare(`PRAGMA index_list(batch_tasks)`).all() as Array<{ name: string }>;
  if (!taskIndexes.some(({ name }) => name === 'idx_batch_tasks_batch')) {
    throw new Error('生产任务索引检查未通过');
  }

  const attemptColumns = db.prepare(`PRAGMA table_info(batch_task_attempts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const attemptByName = new Map(attemptColumns.map((column) => [column.name, column]));
  if (
    attemptByName.get('id')?.pk !== 1
    || attemptByName.get('taskId')?.notnull !== 1
    || attemptByName.get('attemptNumber')?.notnull !== 1
    || attemptByName.get('status')?.notnull !== 1
    || attemptByName.get('startedAt')?.notnull !== 1
    || attemptByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('任务尝试表结构检查未通过');
  }

  const attemptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_task_attempts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!attemptForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_tasks'
    && foreignKey.from === 'taskId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('任务尝试表任务外键检查未通过');
  }

  const attemptIndexes = db.prepare(`PRAGMA index_list(batch_task_attempts)`).all() as Array<{ name: string }>;
  if (!attemptIndexes.some(({ name }) => name === 'idx_batch_task_attempts_task')) {
    throw new Error('任务尝试索引检查未通过');
  }
}

/** v7 引入的产物表列结构(v8 重建后列不变,可继续验证) */
function validateArtifactTableColumns(db: Database.Database): void {
  const artifactColumns = db.prepare(`PRAGMA table_info(batch_artifacts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const artifactByName = new Map(artifactColumns.map((column) => [column.name, column]));
  if (
    artifactByName.get('id')?.pk !== 1
    || artifactByName.get('projectId')?.notnull !== 1
    || artifactByName.get('batchId')?.notnull !== 1
    || artifactByName.get('batchVersionId')?.notnull !== 1
    || artifactByName.get('outputPlanId')?.notnull !== 1
    || artifactByName.get('outputVersionId')?.notnull !== 1
    || artifactByName.get('kind')?.notnull !== 1
    || artifactByName.get('relativePath')?.notnull !== 1
    || artifactByName.get('checksum')?.notnull !== 1
    || artifactByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('正式产物表结构检查未通过');
  }

  const artifactIndexes = db.prepare(`PRAGMA index_list(batch_artifacts)`).all() as Array<{ name: string }>;
  if (!artifactIndexes.some(({ name }) => name === 'idx_batch_artifacts_plan')) {
    throw new Error('正式产物索引检查未通过');
  }

  const planColumns = db.prepare(`PRAGMA table_info(batch_output_plans)`).all() as Array<{ name: string }>;
  if (!planColumns.some(({ name }) => name === 'currentArtifactId')) {
    throw new Error('成片计划当前成片指向列检查未通过');
  }
}

/** v8 重建后的产物表约束:删除保护(非级联)与按文件路径的唯一性 */
function validateArtifactTableConstraints(db: Database.Database): void {
  const artifactForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_artifacts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const requiredForeignKeys: Array<{ table: string; from: string; onDelete: string }> = [
    { table: 'projects', from: 'projectId', onDelete: 'CASCADE' },
    { table: 'batch_productions', from: 'batchId', onDelete: 'RESTRICT' },
    { table: 'batch_production_versions', from: 'batchVersionId', onDelete: 'RESTRICT' },
    { table: 'batch_output_plans', from: 'outputPlanId', onDelete: 'RESTRICT' },
    { table: 'batch_output_versions', from: 'outputVersionId', onDelete: 'RESTRICT' },
  ];
  for (const required of requiredForeignKeys) {
    if (!artifactForeignKeys.some((foreignKey) => (
      foreignKey.table === required.table
      && foreignKey.from === required.from
      && foreignKey.to === 'id'
      && foreignKey.on_delete.toUpperCase() === required.onDelete
    ))) {
      throw new Error(`正式产物表外键检查未通过(${required.from})`);
    }
  }

  const artifactIndexes = db.prepare(`PRAGMA index_list(batch_artifacts)`).all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  const uniqueIndex = artifactIndexes.find(({ unique, origin }) => unique === 1 && origin !== 'pk');
  if (!uniqueIndex) {
    throw new Error('正式产物缺少唯一约束');
  }
  const uniqueColumns = db.prepare(`PRAGMA index_info(${uniqueIndex.name})`).all() as Array<{ name: string }>;
  if (
    uniqueColumns.length !== 2
    || uniqueColumns[0]?.name !== 'outputPlanId'
    || uniqueColumns[1]?.name !== 'relativePath'
  ) {
    throw new Error('正式产物唯一约束必须是成片计划与文件路径');
  }
}

/** v9 把输入冻结落在批次版本上，并为批次内外部文案和逻辑删除建立边界。 */
function validateBatchVersionLifecycleColumns(db: Database.Database): void {
  const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{
    name: string;
  }>;
  if (!productionColumns.some(({ name }) => name === 'deletedAt')) {
    throw new Error('批次表缺少逻辑删除列');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const versionByName = new Map(versionColumns.map((column) => [column.name, column]));
  if (versionByName.get('inputState')?.notnull !== 1 || !versionByName.has('frozenAt')) {
    throw new Error('批次版本缺少不可逆冻结列');
  }

  const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{
    name: string;
  }>;
  if (
    !scriptColumns.some(({ name }) => name === 'ownerBatchVersionId')
    || !scriptColumns.some(({ name }) => name === 'externalSourceId')
  ) {
    throw new Error('批次文案缺少所属版本列');
  }
  const scriptForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_scripts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!scriptForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'ownerBatchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('批次文案所属版本外键检查未通过');
  }
  const scriptIndexes = db.prepare(`PRAGMA index_list(batch_scripts)`).all() as Array<{ name: string }>;
  if (!scriptIndexes.some(({ name }) => name === 'idx_batch_scripts_owner_version')) {
    throw new Error('批次文案所属版本索引检查未通过');
  }
  if (!scriptIndexes.some(({ name }) => name === 'idx_batch_external_scripts_source')) {
    throw new Error('批次文案来源唯一索引检查未通过');
  }
}

function validateSourceTables(db: Database.Database): void {
  const sourceColumns = db.prepare(`PRAGMA table_info(batch_asset_sources)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const sourceByName = new Map(sourceColumns.map((column) => [column.name, column]));
  if (
    sourceByName.get('id')?.pk !== 1
    || sourceByName.get('assetId')?.notnull !== 1
    || sourceByName.get('sourceKind')?.notnull !== 1
    || sourceByName.get('locationJson')?.notnull !== 1
    || sourceByName.get('health')?.notnull !== 1
    || sourceByName.get('createdAt')?.notnull !== 1
  ) {
    throw new Error('素材来源表结构检查未通过');
  }

  const sourceForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_sources)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!sourceForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('素材来源表素材外键检查未通过');
  }

  const sourceIndexes = db.prepare(`PRAGMA index_list(batch_asset_sources)`).all() as Array<{ name: string }>;
  if (!sourceIndexes.some(({ name }) => name === 'idx_batch_asset_sources_asset')) {
    throw new Error('素材来源索引检查未通过');
  }
}

function validateScriptMetadataColumns(db: Database.Database): void {
  const scriptColumns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{ name: string }>;
  for (const name of ['coverTitleJson', 'shotSetId', 'contentRevision']) {
    if (!scriptColumns.some(({ name: column }) => column === name)) {
      throw new Error(`项目脚本表缺少元数据列 ${name}`);
    }
  }
  const snapshotColumns = db.prepare(`PRAGMA table_info(batch_script_snapshots)`).all() as Array<{ name: string }>;
  for (const name of ['coverTitleJson', 'shotSetId', 'contentRevision']) {
    if (!snapshotColumns.some(({ name: column }) => column === name)) {
      throw new Error(`脚本快照表缺少元数据列 ${name}`);
    }
  }
}

function validateScriptAvailabilityColumns(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(batch_scripts)`).all() as Array<{ name: string }>;
  for (const name of ['sourceAvailable', 'catalogManaged']) {
    if (!columns.some(({ name: column }) => column === name)) {
      throw new Error(`项目脚本表缺少来源状态列 ${name}`);
    }
  }
}

function validateSchedulerColumns(db: Database.Database): void {
  const taskColumns = db.prepare(`PRAGMA table_info(batch_tasks)`).all() as Array<{ name: string }>;
  for (const name of ['requestKey', 'expectedState']) {
    if (!taskColumns.some(({ name: column }) => column === name)) {
      throw new Error(`生产任务表缺少调度列 ${name}`);
    }
  }
  const attemptColumns = db.prepare(`PRAGMA table_info(batch_task_attempts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const attemptByName = new Map(attemptColumns.map((column) => [column.name, column]));
  for (const name of ['claimedBy', 'leaseExpiresAt', 'heartbeatAt', 'adapterVersion', 'remoteTaskId']) {
    if (!attemptByName.has(name)) {
      throw new Error(`任务尝试表缺少调度列 ${name}`);
    }
  }
  const productionColumns = db.prepare(`PRAGMA table_info(batch_productions)`).all() as Array<{ name: string }>;
  if (!productionColumns.some(({ name }) => name === 'controlState')) {
    throw new Error('批次表缺少控制状态列');
  }
}

function validateProxyAndColorTables(db: Database.Database): void {
  const lutColumns = db.prepare(`PRAGMA table_info(batch_luts)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const lutByName = new Map(lutColumns.map((column) => [column.name, column]));
  if (
    lutByName.get('id')?.pk !== 1
    || lutByName.get('projectId')?.notnull !== 1
    || lutByName.get('contentFingerprint')?.notnull !== 1
    || lutByName.get('displayName')?.notnull !== 1
    || lutByName.get('relativePath')?.notnull !== 1
    || lutByName.get('fileSizeBytes')?.notnull !== 1
    || lutByName.get('status')?.notnull !== 1
    || lutByName.get('createdAt')?.notnull !== 1
    || lutByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('LUT 表结构检查未通过');
  }
  const lutForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_luts)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!lutForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects'
    && foreignKey.from === 'projectId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('LUT 表项目外键检查未通过');
  }
  const lutIndexes = db.prepare(`PRAGMA index_list(batch_luts)`).all() as Array<{ name: string; unique: number }>;
  if (!lutIndexes.some(({ name, unique }) => name === 'idx_batch_luts_identity' && unique === 1)) {
    throw new Error('LUT 身份唯一索引检查未通过');
  }
  if (!lutIndexes.some(({ name }) => name === 'idx_batch_luts_project')) {
    throw new Error('LUT 项目索引检查未通过');
  }

  const poolColumns = db.prepare(`PRAGMA table_info(batch_asset_pool_items)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (!poolColumns.some(({ name, notnull }) => name === 'colorJson' && notnull === 1)) {
    throw new Error('素材池表缺少色彩快照列');
  }

  const cacheColumns = db.prepare(`PRAGMA table_info(batch_proxy_cache_items)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const cacheByName = new Map(cacheColumns.map((column) => [column.name, column]));
  if (
    cacheByName.get('id')?.pk !== 1
    || cacheByName.get('proxyKey')?.notnull !== 1
    || cacheByName.get('projectId')?.notnull !== 1
    || cacheByName.get('assetId')?.notnull !== 1
    || cacheByName.get('profileVersion')?.notnull !== 1
    || cacheByName.get('colorJson')?.notnull !== 1
    || cacheByName.get('relativePath')?.notnull !== 1
    || cacheByName.get('status')?.notnull !== 1
    || cacheByName.get('createdAt')?.notnull !== 1
    || cacheByName.get('updatedAt')?.notnull !== 1
  ) {
    throw new Error('代理缓存表结构检查未通过');
  }
  const cacheForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_proxy_cache_items)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!cacheForeignKeys.some((foreignKey) => (
    foreignKey.table === 'projects' && foreignKey.from === 'projectId' && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('代理缓存表项目外键检查未通过');
  }
  if (!cacheForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets' && foreignKey.from === 'assetId' && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('代理缓存表素材外键检查未通过');
  }
  const cacheIndexes = db.prepare(`PRAGMA index_list(batch_proxy_cache_items)`).all() as Array<{
    name: string;
    unique: number;
  }>;
  if (!cacheIndexes.some(({ name, unique }) => name === 'idx_batch_proxy_cache_items_key' && unique === 1)) {
    throw new Error('代理缓存 proxyKey 唯一索引检查未通过');
  }
  if (!cacheIndexes.some(({ name }) => name === 'idx_batch_proxy_cache_items_project')) {
    throw new Error('代理缓存项目索引检查未通过');
  }

  // batch_tasks/batch_task_attempts 在 v14 被整表重建(为了安全放宽 workType CHECK)。
  // 结构校验复用 v6/v13 已验证过的列/外键/索引断言,外加显式确认新 CHECK 已经生效。
  validateTaskTables(db);
  const taskTableSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'batch_tasks'`).get() as {
    sql: string;
  }).sql;
  if (!taskTableSql.includes('proxy_generate')) {
    throw new Error('生产任务表 workType 约束未放宽到 proxy_generate');
  }
  const attemptColumns = db.prepare(`PRAGMA table_info(batch_task_attempts)`).all() as Array<{ name: string }>;
  for (const name of ['claimedBy', 'leaseExpiresAt', 'heartbeatAt', 'adapterVersion', 'remoteTaskId']) {
    if (!attemptColumns.some((column) => column.name === name)) {
      throw new Error(`重建后的任务尝试表丢失调度列 ${name}`);
    }
  }
}

/** v15 引入的持久化代理请求表:请求是稳定身份,cache 可删除但请求不能悬空。 */
function validateProxyRequestTables(db: Database.Database): void {
  const requestColumns = db.prepare(`PRAGMA table_info(batch_proxy_requests)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const requestByName = new Map(requestColumns.map((column) => [column.name, column]));
  for (const name of ['projectId', 'batchId', 'batchVersionId', 'assetId', 'contentFingerprint', 'colorJson', 'profileVersion', 'colorPipelineVersion', 'proxyKey', 'status', 'createdAt', 'updatedAt']) {
    if (requestByName.get(name)?.notnull !== 1) {
      throw new Error(`代理请求表缺少必填列 ${name}`);
    }
  }
  if (requestByName.get('id')?.pk !== 1) {
    throw new Error('代理请求表主键检查未通过');
  }

  const requestForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_proxy_requests)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const requiredRequestForeignKeys: Array<{ table: string; from: string; onDelete: string }> = [
    { table: 'projects', from: 'projectId', onDelete: 'CASCADE' },
    { table: 'batch_productions', from: 'batchId', onDelete: 'CASCADE' },
    { table: 'batch_production_versions', from: 'batchVersionId', onDelete: 'CASCADE' },
    { table: 'batch_assets', from: 'assetId', onDelete: 'CASCADE' },
    { table: 'batch_proxy_cache_items', from: 'currentCacheItemId', onDelete: 'SET NULL' },
  ];
  for (const required of requiredRequestForeignKeys) {
    if (!requestForeignKeys.some((foreignKey) => (
      foreignKey.table === required.table
      && foreignKey.from === required.from
      && foreignKey.to === 'id'
      && foreignKey.on_delete.toUpperCase() === required.onDelete
    ))) {
      throw new Error(`代理请求表外键检查未通过(${required.from})`);
    }
  }

  const requestIndexes = db.prepare(`PRAGMA index_list(batch_proxy_requests)`).all() as Array<{ name: string }>;
  if (!requestIndexes.some(({ name }) => name === 'idx_batch_proxy_requests_version')) {
    throw new Error('代理请求表版本索引检查未通过');
  }
  if (!requestIndexes.some(({ name }) => name === 'idx_batch_proxy_requests_cache')) {
    throw new Error('代理请求表缓存索引检查未通过');
  }

  // 每条请求要么没有 cache 引用(清理后),要么引用的 cache 行真实存在
  const dangling = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_proxy_requests r
    LEFT JOIN batch_proxy_cache_items c ON c.id = r.currentCacheItemId
    WHERE r.currentCacheItemId IS NOT NULL AND c.id IS NULL
  `).get() as { n: number };
  if (dangling.n > 0) {
    throw new Error('代理请求表存在悬空的 cache 引用');
  }

  const invalidLineage = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_proxy_requests r
    JOIN batch_production_versions v ON v.id = r.batchVersionId
    JOIN batch_productions p ON p.id = r.batchId
    JOIN batch_assets a ON a.id = r.assetId
    LEFT JOIN batch_asset_pool_items pool
      ON pool.batchVersionId = r.batchVersionId AND pool.assetId = r.assetId
    WHERE v.batchId <> r.batchId
       OR p.projectId <> r.projectId
       OR a.projectId <> r.projectId
       OR pool.id IS NULL
  `).get() as { n: number };
  if (invalidLineage.n > 0) {
    throw new Error('代理请求表存在跨批次、跨项目或不属于版本素材池的谱系');
  }

  const invalidTaskTargets = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_tasks t
    LEFT JOIN batch_proxy_requests r ON r.id = t.targetId
    WHERE t.workType = 'proxy_generate'
      AND NOT (
        (
          t.targetKind = 'proxy_request'
          AND r.id IS NOT NULL
          AND r.projectId = t.projectId
          AND r.batchId = t.batchId
        )
        OR (
          t.targetKind = 'legacy_proxy_cache'
          AND t.status = 'cancelled'
          AND t.requestKey IS NULL
        )
      )
  `).get() as { n: number };
  if (invalidTaskTargets.n > 0) {
    throw new Error('代理任务存在跨批次或悬空的请求目标');
  }
}

/** v16 联合分配运行、批次版本内素材排除与成片版本谱系。 */
function validateAllocationTables(db: Database.Database): void {
  const runColumns = db.prepare(`PRAGMA table_info(batch_allocation_runs)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const runByName = new Map(runColumns.map((column) => [column.name, column]));
  if (runByName.get('id')?.pk !== 1) {
    throw new Error('联合分配运行表主键检查未通过');
  }
  for (const name of ['batchVersionId', 'ruleVersion', 'seed', 'inputFingerprint', 'status', 'resultJson', 'createdAt']) {
    if (runByName.get(name)?.notnull !== 1) {
      throw new Error(`联合分配运行表缺少必填列 ${name}`);
    }
  }
  const runForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_allocation_runs)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!runForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('联合分配运行表批次版本外键检查未通过');
  }
  const runIndexes = db.prepare(`PRAGMA index_list(batch_allocation_runs)`).all() as Array<{ name: string }>;
  if (!runIndexes.some(({ name }) => name === 'idx_batch_allocation_runs_version')) {
    throw new Error('联合分配运行表版本索引检查未通过');
  }

  const versionColumns = db.prepare(`PRAGMA table_info(batch_production_versions)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const currentRunColumn = versionColumns.find(({ name }) => name === 'currentAllocationRunId');
  if (!currentRunColumn || currentRunColumn.notnull !== 0) {
    throw new Error('批次版本缺少可空的当前联合分配运行指针');
  }
  const versionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_production_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!versionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_allocation_runs'
    && foreignKey.from === 'currentAllocationRunId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'SET NULL'
  ))) {
    throw new Error('批次版本当前联合分配运行外键检查未通过');
  }
  const versionIndexes = db.prepare(`PRAGMA index_list(batch_production_versions)`).all() as Array<{ name: string }>;
  if (!versionIndexes.some(({ name }) => name === 'idx_batch_versions_current_allocation')) {
    throw new Error('批次版本当前联合分配运行索引检查未通过');
  }

  const exclusionColumns = db.prepare(`PRAGMA table_info(batch_asset_exclusions)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const exclusionByName = new Map(exclusionColumns.map((column) => [column.name, column]));
  if (exclusionByName.get('id')?.pk !== 1) {
    throw new Error('批次素材排除表主键检查未通过');
  }
  for (const name of ['batchVersionId', 'assetId', 'reason', 'createdAt']) {
    if (exclusionByName.get(name)?.notnull !== 1) {
      throw new Error(`批次素材排除表缺少必填列 ${name}`);
    }
  }
  const exclusionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_exclusions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!exclusionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_production_versions'
    && foreignKey.from === 'batchVersionId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'CASCADE'
  ))) {
    throw new Error('批次素材排除表版本外键检查未通过');
  }
  if (!exclusionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_assets'
    && foreignKey.from === 'assetId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('批次素材排除表素材外键检查未通过');
  }
  const exclusionIndexes = db.prepare(`PRAGMA index_list(batch_asset_exclusions)`).all() as Array<{ name: string }>;
  if (!exclusionIndexes.some(({ name }) => name === 'idx_batch_asset_exclusions_version')) {
    throw new Error('批次素材排除表版本索引检查未通过');
  }

  const outputVersionColumns = db.prepare(`PRAGMA table_info(batch_output_versions)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const allocationColumn = outputVersionColumns.find(({ name }) => name === 'allocationRunId');
  if (!allocationColumn || allocationColumn.notnull !== 0) {
    throw new Error('成片版本缺少可空的联合分配运行追踪列');
  }
  const outputVersionForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_output_versions)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  if (!outputVersionForeignKeys.some((foreignKey) => (
    foreignKey.table === 'batch_allocation_runs'
    && foreignKey.from === 'allocationRunId'
    && foreignKey.to === 'id'
    && foreignKey.on_delete.toUpperCase() === 'RESTRICT'
  ))) {
    throw new Error('成片版本联合分配运行外键检查未通过');
  }
  const outputVersionIndexes = db.prepare(`PRAGMA index_list(batch_output_versions)`).all() as Array<{ name: string }>;
  if (!outputVersionIndexes.some(({ name }) => name === 'idx_batch_output_versions_allocation')) {
    throw new Error('成片版本联合分配索引检查未通过');
  }

  // batch_allocation_runs.batchVersionId 的外键已经确保批次版本仍存在；
  // 逻辑删除批次不应抹掉历史分配运行，故这里不按 deletedAt 拒绝历史行。
  const invalidExclusionLineage = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_asset_exclusions e
    JOIN batch_production_versions v ON v.id = e.batchVersionId
    JOIN batch_productions b ON b.id = v.batchId
    JOIN batch_assets a ON a.id = e.assetId
    LEFT JOIN batch_asset_pool_items pool
      ON pool.batchVersionId = e.batchVersionId AND pool.assetId = e.assetId
    WHERE a.projectId <> b.projectId OR pool.id IS NULL
  `).get() as { n: number };
  if (invalidExclusionLineage.n > 0) {
    throw new Error('批次素材排除存在跨项目谱系');
  }
  const invalidOutputLineage = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_output_versions o
    JOIN batch_output_plans p ON p.id = o.planId
    JOIN batch_production_versions v ON v.id = p.batchVersionId
    JOIN batch_allocation_runs r ON r.id = o.allocationRunId
    WHERE r.batchVersionId <> v.id
  `).get() as { n: number };
  if (invalidOutputLineage.n > 0) {
    throw new Error('成片版本联合分配运行谱系不一致');
  }
  const invalidCurrentRun = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_production_versions v
    JOIN batch_allocation_runs r ON r.id = v.currentAllocationRunId
    WHERE r.batchVersionId <> v.id
  `).get() as { n: number };
  if (invalidCurrentRun.n > 0) {
    throw new Error('批次版本当前联合分配运行谱系不一致');
  }
}

/** v17 冻结视觉内容分析的素材、供应商与模型身份。 */
function validateAssetAnalysisRequestTables(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(batch_asset_analysis_requests)`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (byName.get('taskId')?.pk !== 1) {
    throw new Error('内容分析请求表主键检查未通过');
  }
  for (const name of ['projectId', 'batchId', 'assetId', 'contentFingerprint', 'providerId', 'model', 'analysisMode', 'createdAt']) {
    if (byName.get(name)?.notnull !== 1) {
      throw new Error(`内容分析请求表缺少必填列 ${name}`);
    }
  }
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_analysis_requests)`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;
  const requiredForeignKeys = [
    ['batch_tasks', 'taskId', 'id', 'CASCADE'],
    ['projects', 'projectId', 'id', 'CASCADE'],
    ['batch_productions', 'batchId', 'id', 'CASCADE'],
    ['batch_assets', 'assetId', 'id', 'RESTRICT'],
  ] as const;
  for (const [table, from, to, onDelete] of requiredForeignKeys) {
    if (!foreignKeys.some((foreignKey) => (
      foreignKey.table === table
      && foreignKey.from === from
      && foreignKey.to === to
      && foreignKey.on_delete.toUpperCase() === onDelete
    ))) {
      throw new Error(`内容分析请求表外键 ${from} 检查未通过`);
    }
  }
  const indexes = db.prepare(`PRAGMA index_list(batch_asset_analysis_requests)`).all() as Array<{ name: string }>;
  for (const name of ['idx_batch_asset_analysis_requests_asset', 'idx_batch_asset_analysis_requests_batch']) {
    if (!indexes.some((index) => index.name === name)) {
      throw new Error(`内容分析请求表索引 ${name} 检查未通过`);
    }
  }
  const invalidLineage = db.prepare(`
    SELECT COUNT(*) AS n
    FROM batch_asset_analysis_requests r
    JOIN batch_tasks t ON t.id = r.taskId
    JOIN batch_productions b ON b.id = r.batchId
    JOIN batch_assets a ON a.id = r.assetId
    WHERE t.projectId <> r.projectId
       OR t.batchId <> r.batchId
       OR t.workType <> 'asset_prepare'
       OR t.targetKind <> 'asset'
       OR t.targetId <> r.assetId
       OR b.projectId <> r.projectId
       OR a.projectId <> r.projectId
       OR a.contentFingerprint <> r.contentFingerprint
  `).get() as { n: number };
  if (invalidLineage.n > 0) {
    throw new Error('内容分析请求存在跨项目、跨批次或过期素材谱系');
  }
}

/** v18 冻结内容分析供应商的直连／公司执行作用域。 */
function validateAssetAnalysisExecutionScope(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(batch_asset_analysis_requests)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  if (columns.find((column) => column.name === 'executionScope')?.notnull !== 1) {
    throw new Error('内容分析请求表缺少必填列 executionScope');
  }
  const invalid = db.prepare(`
    SELECT COUNT(*) AS n FROM batch_asset_analysis_requests
    WHERE executionScope NOT IN ('external','company')
  `).get() as { n: number };
  if (invalid.n > 0) throw new Error('内容分析请求存在无效供应商执行作用域');
}

const SCHEMA_VALIDATORS: ReadonlyArray<(db: Database.Database) => void> = [
  validateBatchProductionTable,
  validateAssetsTables,
  validateProductionVersionTables,
  validateScriptTables,
  validatePlanTables,
  validateTaskTables,
  validateArtifactTableColumns,
  validateArtifactTableConstraints,
  validateBatchVersionLifecycleColumns,
  validateSourceTables,
  validateScriptMetadataColumns,
  validateScriptAvailabilityColumns,
  validateSchedulerColumns,
  validateProxyAndColorTables,
  validateProxyRequestTables,
  validateAllocationTables,
  validateAssetAnalysisRequestTables,
  validateAssetAnalysisExecutionScope,
];

function validateBatchSchema(db: Database.Database): void {
  for (const validate of SCHEMA_VALIDATORS) {
    validate(db);
  }
  assertIntegrity(db);
}

function validateBatchSchemaUpTo(db: Database.Database, version: number): void {
  for (let index = 0; index < version && index < SCHEMA_VALIDATORS.length; index += 1) {
    SCHEMA_VALIDATORS[index]?.(db);
  }
  assertIntegrity(db);
}

function assertIntegrity(db: Database.Database): void {
  const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
    throw new Error('批量 schema 迁移后的完整性检查未通过');
  }
}

function applyMigration(db: Database.Database, migration: BatchSchemaMigration, appliedAt: string): void {
  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )
    `);
    db.exec(migration.sql);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('批量 schema 迁移后的外键检查未通过');
    }
    db.prepare(
      `INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`,
    ).run(migration.version, appliedAt);
    validateBatchSchemaUpTo(db, migration.version);
  });
  apply.immediate();
}

export async function ensureBatchSchemaReady(
  options: EnsureBatchSchemaOptions,
): Promise<BatchSchemaReadiness> {
  const {
    db,
    backupRoot,
    now = () => new Date(),
    diskSpaceProbe,
  } = options;
  const targetVersion = BATCH_SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;
  let appliedVersions: number[];

  try {
    appliedVersions = readAppliedVersions(db);
  } catch {
    return {
      state: 'compatibility_only',
      code: 'schema_history_invalid',
      message: '批量功能的升级记录无法读取，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const historyFailure = validateMigrationHistory(appliedVersions);
  if (historyFailure) {
    return {
      state: 'compatibility_only',
      code: historyFailure,
      message: historyFailure === 'schema_too_new'
        ? '当前数据库来自更新版本，批量功能暂不可用。'
        : '批量功能的升级记录不完整，旧功能仍可继续使用。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const appliedSet = new Set(appliedVersions);
  const pendingMigrations = BATCH_SCHEMA_MIGRATIONS.filter(({ version }) => !appliedSet.has(version));
  if (pendingMigrations.length === 0) {
    try {
      validateBatchSchema(db);
    } catch {
      return {
        state: 'compatibility_only',
        code: 'schema_history_invalid',
        message: '批量功能的数据结构与升级记录不一致，旧功能仍可继续使用。',
        appliedVersions: [],
        targetVersion,
      };
    }
    return { state: 'current', appliedVersions: [], targetVersion };
  }

  const startedAt = now();
  let backupDirectory: string | undefined;
  let backupManifest: BatchSchemaBackupManifest | undefined;
  try {
    const backup = await createValidatedBatchSchemaBackup({
      db,
      backupRoot,
      sourceVersions: appliedVersions,
      targetVersion,
      now: startedAt,
      diskSpaceProbe,
    });
    backupDirectory = backup.directory;
    backupManifest = backup.manifest;
  } catch (error) {
    return {
      state: 'compatibility_only',
      code: error instanceof BatchSchemaBackupError ? error.code : 'backup_failed',
      message: error instanceof BatchSchemaBackupError && error.code === 'backup_validation_failed'
        ? '数据库备份未通过完整性检查，尚未执行批量升级。'
        : error instanceof BatchSchemaBackupError && error.code === 'insufficient_disk_space'
          ? '项目盘空间不足，尚未执行批量升级。'
          : '无法完成数据库安全备份，尚未执行批量升级。',
      appliedVersions: [],
      targetVersion,
    };
  }

  const newlyApplied: number[] = [];
  try {
    for (const migration of pendingMigrations) {
      applyMigration(db, migration, now().toISOString());
      newlyApplied.push(migration.version);
    }
  } catch {
    return {
      state: 'compatibility_only',
      code: 'migration_failed',
      message: '批量数据库升级未完成，旧功能仍可继续使用。',
      appliedVersions: newlyApplied,
      targetVersion,
      backupDirectory,
      backupManifest,
    };
  }

  return {
    state: 'ready',
    appliedVersions: newlyApplied,
    targetVersion,
    backupDirectory,
    backupManifest,
  };
}
