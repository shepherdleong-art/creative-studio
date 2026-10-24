// 由 scripts/live-mixcut-port/generate-schema.mjs 生成，不要手改。
// 来源：Codex 分支上批量 v1–v27 和公式 v1–v26 迁移跑完后的最终结构，改名为 live_mixcut_*。
// 这是实拍混剪迁移 v1 的内容；以后改表结构只能在 schema.ts 里追加新版本。
export const LIVE_MIXCUT_SCHEMA_V1_SQL = `
CREATE TABLE live_mixcut_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  productName TEXT NOT NULL,
  exportDirName TEXT NOT NULL UNIQUE,
  batchId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);

CREATE TABLE live_mixcut_productions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        name TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', currentVersionId TEXT, progressJson TEXT NOT NULL DEFAULT '{}', deletedAt TEXT, controlState TEXT NOT NULL DEFAULT 'running'
        CHECK(controlState IN ('running', 'paused', 'stopped')), archivedAt TEXT, planningMode TEXT NOT NULL DEFAULT 'semantic'
        CHECK(planningMode IN ('semantic','formula')),
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_assets (
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
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_asset_analysis (
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
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_production_versions (
        id TEXT PRIMARY KEY,
        batchId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        copyCount INTEGER NOT NULL,
        defaultsJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL, inputState TEXT NOT NULL DEFAULT 'frozen'
        CHECK(inputState IN ('draft', 'frozen')), frozenAt TEXT, currentAllocationRunId TEXT
        REFERENCES live_mixcut_allocation_runs(id) ON DELETE SET NULL, planningMode TEXT NOT NULL DEFAULT 'semantic'
        CHECK(planningMode IN ('semantic','formula')),
        UNIQUE(batchId, versionNumber),
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_asset_pool_items (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        analysisId TEXT NOT NULL,
        selectionState TEXT NOT NULL DEFAULT 'selected',
        createdAt TEXT NOT NULL, colorJson TEXT NOT NULL DEFAULT '{"lutId":null}',
        UNIQUE(batchVersionId, assetId),
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        FOREIGN KEY(analysisId) REFERENCES live_mixcut_asset_analysis(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_scripts (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('script_draft', 'external')),
        sourceId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL, ownerBatchVersionId TEXT
        REFERENCES live_mixcut_production_versions(id) ON DELETE RESTRICT, externalSourceId TEXT, coverTitleJson TEXT NOT NULL DEFAULT '{}', shotSetId TEXT NOT NULL DEFAULT '', contentRevision TEXT NOT NULL DEFAULT '', sourceAvailable INTEGER NOT NULL DEFAULT 1 CHECK(sourceAvailable IN (0, 1)), catalogManaged INTEGER NOT NULL DEFAULT 0 CHECK(catalogManaged IN (0, 1)), targetDurationSec INTEGER NOT NULL DEFAULT 15, narrationConfigJson TEXT NOT NULL DEFAULT '{}', catalogDeleted INTEGER NOT NULL DEFAULT 0 CHECK(catalogDeleted IN (0, 1)), scriptCode TEXT NOT NULL DEFAULT '',
        UNIQUE(projectId, sourceId),
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_script_snapshots (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        sourceScriptId TEXT NOT NULL,
        title TEXT NOT NULL,
        bodyText TEXT NOT NULL,
        sourceVersion TEXT NOT NULL,
        copyCount INTEGER NOT NULL,
        createdAt TEXT NOT NULL, coverTitleJson TEXT NOT NULL DEFAULT '{}', shotSetId TEXT NOT NULL DEFAULT '', contentRevision TEXT NOT NULL DEFAULT '', targetDurationSec INTEGER NOT NULL DEFAULT 15, narrationConfigJson TEXT NOT NULL DEFAULT '{}', scriptCode TEXT NOT NULL DEFAULT '',
        UNIQUE(batchVersionId, sourceScriptId),
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(sourceScriptId) REFERENCES live_mixcut_scripts(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_output_plans (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        scriptSnapshotId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        planJson TEXT NOT NULL DEFAULT '{}',
        currentVersionId TEXT,
        createdAt TEXT NOT NULL, currentArtifactId TEXT,
        UNIQUE(batchVersionId, seq),
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(scriptSnapshotId) REFERENCES live_mixcut_script_snapshots(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_output_versions (
        id TEXT PRIMARY KEY,
        planId TEXT NOT NULL,
        versionNumber INTEGER NOT NULL,
        arrangementJson TEXT NOT NULL DEFAULT '{}',
        createdAt TEXT NOT NULL, allocationRunId TEXT
        REFERENCES live_mixcut_allocation_runs(id) ON DELETE RESTRICT,
        UNIQUE(planId, versionNumber),
        FOREIGN KEY(planId) REFERENCES live_mixcut_output_plans(id) ON DELETE CASCADE
      );

CREATE TABLE "live_mixcut_artifacts" (
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
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE RESTRICT,
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE RESTRICT,
        FOREIGN KEY(outputPlanId) REFERENCES live_mixcut_output_plans(id) ON DELETE RESTRICT,
        FOREIGN KEY(outputVersionId) REFERENCES live_mixcut_output_versions(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_asset_sources (
        id TEXT PRIMARY KEY,
        assetId TEXT NOT NULL,
        sourceKind TEXT NOT NULL CHECK(sourceKind IN ('module4', 'managed', 'linked')),
        locationJson TEXT NOT NULL,
        health TEXT NOT NULL DEFAULT 'healthy' CHECK(health IN ('healthy', 'offline', 'changed')),
        createdAt TEXT NOT NULL, lastVerifiedIdentityJson TEXT,
        UNIQUE(assetId, sourceKind, locationJson),
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_luts (
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
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_proxy_cache_items (
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
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_allocation_runs (
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
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_asset_exclusions (
        id TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        UNIQUE(batchVersionId, assetId),
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_script_narrations (
        scriptSnapshotId TEXT PRIMARY KEY,
        batchVersionId TEXT NOT NULL,
        narrationJson TEXT NOT NULL,
        audioRelativePath TEXT NOT NULL,
        audioFingerprint TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY(scriptSnapshotId) REFERENCES live_mixcut_script_snapshots(id) ON DELETE CASCADE,
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE
      );

CREATE TABLE live_mixcut_semantic_matrices (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        scriptKey TEXT NOT NULL,
        poolKey TEXT NOT NULL,
        providerId TEXT NOT NULL,
        model TEXT NOT NULL,
        promptVersion TEXT NOT NULL,
        matrixJson TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

CREATE TABLE "live_mixcut_proxy_requests" (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        batchId TEXT,
        batchVersionId TEXT,
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
        CHECK((batchId IS NULL) = (batchVersionId IS NULL)),
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(batchVersionId) REFERENCES live_mixcut_production_versions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE CASCADE,
        FOREIGN KEY(currentCacheItemId) REFERENCES live_mixcut_proxy_cache_items(id) ON DELETE SET NULL
      );

CREATE TABLE live_mixcut_formula_collections (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_productions(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        materialsSessionId TEXT REFERENCES live_mixcut_formula_import_sessions(id) ON DELETE RESTRICT,
        scriptsSessionId TEXT REFERENCES live_mixcut_formula_import_sessions(id) ON DELETE RESTRICT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_import_sessions (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('materials','scripts')),
        fingerprint TEXT NOT NULL,
        filename TEXT NOT NULL,
        baseRevision INTEGER NOT NULL CHECK(baseRevision >= 0),
        previewJson TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','confirmed')),
        excludedKeysJson TEXT NOT NULL DEFAULT '[]',
        confirmedRevision INTEGER,
        createdAt TEXT NOT NULL, workbookBytes BLOB, draftRevision INTEGER NOT NULL DEFAULT 0 CHECK(draftRevision >= 0), extractionJson TEXT,
        UNIQUE(collectionId, kind, fingerprint, baseRevision)
      );

CREATE TABLE live_mixcut_formula_asset_bindings (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        sourceName TEXT NOT NULL,
        sourcePath TEXT NOT NULL,
        detectedCode TEXT,
        logicalCode TEXT,
        excludedReason TEXT CHECK(excludedReason IS NULL OR excludedReason='preview'),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(collectionId, assetId, sourcePath)
      );

CREATE TABLE live_mixcut_formula_material_profiles (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        bindingId TEXT NOT NULL REFERENCES live_mixcut_formula_asset_bindings(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputFingerprint TEXT NOT NULL, sourceJson TEXT NOT NULL, contentJson TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('ai','manual')),
        provenanceJson TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(bindingId, revision)
      );

CREATE TABLE live_mixcut_formula_material_organize_runs (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        providerId TEXT NOT NULL, providerName TEXT NOT NULL, model TEXT NOT NULL, promptVersion TEXT NOT NULL,
        inputJson TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
        total INTEGER NOT NULL CHECK(total >= 0), succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded >= 0),
        skipped INTEGER NOT NULL DEFAULT 0 CHECK(skipped >= 0), errorsJson TEXT NOT NULL DEFAULT '[]',
        message TEXT, startedAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_settings (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        scriptsSessionId TEXT NOT NULL REFERENCES live_mixcut_formula_import_sessions(id) ON DELETE RESTRICT,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL,
        UNIQUE(collectionId, revision)
      );

CREATE TABLE live_mixcut_formula_generation_requests (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL REFERENCES live_mixcut_productions(id) ON DELETE RESTRICT,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        batchVersionId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_production_versions(id) ON DELETE RESTRICT,
        settingsId TEXT NOT NULL REFERENCES live_mixcut_formula_settings(id) ON DELETE RESTRICT,
        inputRevision INTEGER NOT NULL CHECK(inputRevision >= 0),
        requestKey TEXT NOT NULL, seed TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(projectId, batchId, requestKey)
      );

CREATE TABLE live_mixcut_formula_generation_outputs (
        planId TEXT PRIMARY KEY REFERENCES live_mixcut_output_plans(id) ON DELETE RESTRICT,
        requestId TEXT NOT NULL REFERENCES live_mixcut_formula_generation_requests(id) ON DELETE RESTRICT,
        scriptKey TEXT NOT NULL, scriptNumber TEXT NOT NULL,
        copyIndex INTEGER NOT NULL CHECK(copyIndex > 0),
        slotsJson TEXT NOT NULL CHECK(json_valid(slotsJson)),
        UNIQUE(requestId, scriptKey, copyIndex)
      );

CREATE TABLE "live_mixcut_tasks" (
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
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE
      );

CREATE TABLE "live_mixcut_task_attempts" (
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
        FOREIGN KEY(taskId) REFERENCES "live_mixcut_tasks"(id) ON DELETE CASCADE
      );

CREATE TABLE "live_mixcut_asset_analysis_requests" (
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
        FOREIGN KEY(taskId) REFERENCES "live_mixcut_tasks"(id) ON DELETE CASCADE,
        FOREIGN KEY(projectId) REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(batchId) REFERENCES live_mixcut_productions(id) ON DELETE CASCADE,
        FOREIGN KEY(assetId) REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT
      );

CREATE TABLE live_mixcut_formula_stages (
        id TEXT PRIMARY KEY,
        requestId TEXT NOT NULL REFERENCES live_mixcut_formula_generation_requests(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES live_mixcut_formula_generation_outputs(planId) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('select')),
        revision INTEGER NOT NULL CHECK(revision > 0), createdAt TEXT NOT NULL,
        UNIQUE(planId,kind,revision)
      );

CREATE TABLE live_mixcut_formula_selection_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_selection_rules (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        scriptsSessionId TEXT REFERENCES live_mixcut_formula_import_sessions(id) ON DELETE RESTRICT,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL, formatVersion INTEGER NOT NULL DEFAULT 1
        CHECK(formatVersion IN (1,2)),
        UNIQUE(collectionId,revision)
      );

CREATE TABLE live_mixcut_formula_asset_ranges (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL,
        UNIQUE(collectionId,assetId,revision)
      );

CREATE TABLE live_mixcut_formula_reselections (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
        baseStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES live_mixcut_formula_generation_outputs(planId) ON DELETE RESTRICT,
        requestKey TEXT NOT NULL, seed TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        previousOutputVersionId TEXT REFERENCES live_mixcut_output_versions(id) ON DELETE RESTRICT,
        previousEditRevision INTEGER NOT NULL CHECK(previousEditRevision >= 0),
        UNIQUE(planId,requestKey)
      );

CREATE TABLE live_mixcut_formula_speech_stages (
        id TEXT PRIMARY KEY,
        selectionStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(selectionStageId,assetId,revision)
      );

CREATE TABLE live_mixcut_formula_speech_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_speech_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_audio_mapping_stages (
        id TEXT PRIMARY KEY,
        selectionStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(selectionStageId,revision)
      );

CREATE TABLE live_mixcut_formula_audio_mapping_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_narration_stages (
        id TEXT PRIMARY KEY,
        audioMappingStageId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_narration_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_narration_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_timeline_stages (
        id TEXT PRIMARY KEY,
        audioMappingStageId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        narrationStageId TEXT REFERENCES live_mixcut_formula_narration_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_timeline_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_timeline_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_output_versions (
        timelineStageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_timeline_stages(id) ON DELETE RESTRICT,
        outputVersionId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_output_versions(id) ON DELETE RESTRICT,
        createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_execution_checks (
        id TEXT PRIMARY KEY,
        outputVersionId TEXT NOT NULL REFERENCES live_mixcut_formula_output_versions(outputVersionId) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputKey TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(outputVersionId,inputKey), UNIQUE(outputVersionId,revision)
      );

CREATE TABLE live_mixcut_formula_execution_results (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_execution_checks(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_input_revisions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL REFERENCES live_mixcut_productions(id) ON DELETE RESTRICT,
        baseBatchVersionId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_production_versions(id) ON DELETE RESTRICT,
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision >= 0),
        openedRevision INTEGER NOT NULL CHECK(openedRevision=baseInputRevision+1),
        createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_manual_speech (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,assetId,revision)
      );

CREATE TABLE live_mixcut_formula_manual_audio_inputs (
        stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_reselections(stageId) ON DELETE RESTRICT,
        baseMappingStageId TEXT NOT NULL REFERENCES live_mixcut_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        createdAt TEXT NOT NULL
      );

CREATE TABLE live_mixcut_formula_replacement_hints (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        filename TEXT NOT NULL, fingerprint TEXT NOT NULL,
        hintsJson TEXT NOT NULL CHECK(json_valid(hintsJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,baseInputRevision)
      );

CREATE TABLE live_mixcut_formula_manual_media (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE RESTRICT,
        outputVersionId TEXT NOT NULL REFERENCES live_mixcut_formula_output_versions(outputVersionId) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
        requestKey TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        proofJson TEXT NOT NULL CHECK(json_valid(proofJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(outputVersionId,requestKey)
      );

CREATE TABLE live_mixcut_formula_external_narrations (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES live_mixcut_formula_collections(id) ON DELETE RESTRICT,
        scriptsSessionId TEXT NOT NULL REFERENCES live_mixcut_formula_import_sessions(id) ON DELETE RESTRICT,
        scriptKey TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        inputHash TEXT NOT NULL,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,scriptsSessionId,scriptKey,revision)
      );

CREATE INDEX idx_live_mixcut_productions_project
        ON live_mixcut_productions(projectId, updatedAt);

CREATE UNIQUE INDEX idx_live_mixcut_assets_identity
        ON live_mixcut_assets(projectId, contentFingerprint);

CREATE INDEX idx_live_mixcut_assets_project
        ON live_mixcut_assets(projectId, updatedAt);

CREATE INDEX idx_live_mixcut_asset_analysis_asset
        ON live_mixcut_asset_analysis(assetId, createdAt);

CREATE INDEX idx_live_mixcut_production_versions_batch
        ON live_mixcut_production_versions(batchId, versionNumber);

CREATE INDEX idx_live_mixcut_asset_pool_items_version
        ON live_mixcut_asset_pool_items(batchVersionId, assetId);

CREATE INDEX idx_live_mixcut_script_snapshots_version
        ON live_mixcut_script_snapshots(batchVersionId, sourceScriptId);

CREATE INDEX idx_live_mixcut_output_plans_version
        ON live_mixcut_output_plans(batchVersionId, seq);

CREATE INDEX idx_live_mixcut_output_versions_plan
        ON live_mixcut_output_versions(planId, versionNumber);

CREATE INDEX idx_live_mixcut_artifacts_plan ON live_mixcut_artifacts(outputPlanId, createdAt);

CREATE INDEX idx_live_mixcut_scripts_owner_version
        ON live_mixcut_scripts(ownerBatchVersionId, createdAt);

CREATE UNIQUE INDEX idx_live_mixcut_external_scripts_source
        ON live_mixcut_scripts(ownerBatchVersionId, externalSourceId)
        WHERE sourceKind = 'external';

CREATE INDEX idx_live_mixcut_asset_sources_asset
        ON live_mixcut_asset_sources(assetId, createdAt);

CREATE UNIQUE INDEX idx_live_mixcut_luts_identity
        ON live_mixcut_luts(projectId, contentFingerprint);

CREATE INDEX idx_live_mixcut_luts_project
        ON live_mixcut_luts(projectId, status, createdAt);

CREATE UNIQUE INDEX idx_live_mixcut_proxy_cache_items_key
        ON live_mixcut_proxy_cache_items(proxyKey);

CREATE INDEX idx_live_mixcut_proxy_cache_items_project
        ON live_mixcut_proxy_cache_items(projectId, assetId, status);

CREATE INDEX idx_live_mixcut_allocation_runs_version
        ON live_mixcut_allocation_runs(batchVersionId, createdAt, id);

CREATE INDEX idx_live_mixcut_versions_current_allocation
        ON live_mixcut_production_versions(currentAllocationRunId);

CREATE INDEX idx_live_mixcut_asset_exclusions_version
        ON live_mixcut_asset_exclusions(batchVersionId, assetId);

CREATE INDEX idx_live_mixcut_output_versions_allocation
        ON live_mixcut_output_versions(allocationRunId);

CREATE INDEX idx_live_mixcut_script_narrations_version
        ON live_mixcut_script_narrations(batchVersionId);

CREATE INDEX idx_live_mixcut_semantic_matrices_lookup
        ON live_mixcut_semantic_matrices(projectId, scriptKey, poolKey, createdAt);

CREATE INDEX idx_live_mixcut_proxy_requests_version
        ON live_mixcut_proxy_requests(batchVersionId, assetId);

CREATE INDEX idx_live_mixcut_proxy_requests_cache
        ON live_mixcut_proxy_requests(currentCacheItemId);

CREATE UNIQUE INDEX idx_live_mixcut_proxy_requests_version_identity
        ON live_mixcut_proxy_requests(batchVersionId, assetId, proxyKey)
        WHERE batchVersionId IS NOT NULL;

CREATE UNIQUE INDEX idx_live_mixcut_proxy_requests_asset_identity
        ON live_mixcut_proxy_requests(projectId, assetId, proxyKey)
        WHERE batchVersionId IS NULL;

CREATE INDEX idx_live_mixcut_formula_collections_project ON live_mixcut_formula_collections(projectId, batchId);

CREATE INDEX idx_live_mixcut_formula_bindings_code ON live_mixcut_formula_asset_bindings(collectionId, logicalCode);

CREATE INDEX idx_live_mixcut_formula_material_profiles_collection ON live_mixcut_formula_material_profiles(collectionId, bindingId, revision DESC);

CREATE INDEX idx_live_mixcut_formula_material_runs_collection ON live_mixcut_formula_material_organize_runs(collectionId, startedAt DESC);

CREATE INDEX idx_live_mixcut_tasks_batch
        ON live_mixcut_tasks(batchId, status, createdAt);

CREATE UNIQUE INDEX idx_live_mixcut_tasks_request_key
        ON live_mixcut_tasks(requestKey) WHERE requestKey IS NOT NULL;

CREATE INDEX idx_live_mixcut_task_attempts_task
        ON live_mixcut_task_attempts(taskId, attemptNumber);

CREATE INDEX idx_live_mixcut_asset_analysis_requests_asset
        ON live_mixcut_asset_analysis_requests(projectId, assetId, createdAt);

CREATE INDEX idx_live_mixcut_asset_analysis_requests_batch
        ON live_mixcut_asset_analysis_requests(batchId, createdAt);

CREATE VIEW live_mixcut_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM live_mixcut_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM live_mixcut_formula_speech_stages a JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'audio_mapping',a.revision,s.id,NULL
          FROM live_mixcut_formula_audio_mapping_stages a JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT n.id,s.requestId,s.planId,'narration',a.revision,s.id,NULL
          FROM live_mixcut_formula_narration_stages n JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=n.audioMappingStageId
          JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT t.id,s.requestId,s.planId,'timeline',a.revision,s.id,NULL
          FROM live_mixcut_formula_timeline_stages t JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId
          JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT e.id,s.requestId,s.planId,'execution',e.revision,s.id,NULL
          FROM live_mixcut_formula_execution_checks e JOIN live_mixcut_formula_output_versions f ON f.outputVersionId=e.outputVersionId
          JOIN live_mixcut_formula_timeline_stages t ON t.id=f.timelineStageId
          JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId;

CREATE TRIGGER live_mixcut_formula_mode_immutable BEFORE UPDATE OF planningMode ON live_mixcut_productions
        WHEN OLD.planningMode <> NEW.planningMode
        BEGIN SELECT RAISE(ABORT, 'batch planning mode is immutable'); END;

CREATE TRIGGER live_mixcut_formula_version_mode_immutable BEFORE UPDATE OF planningMode ON live_mixcut_production_versions
        WHEN OLD.planningMode <> NEW.planningMode
        BEGIN SELECT RAISE(ABORT, 'batch version planning mode is immutable'); END;

CREATE TRIGGER live_mixcut_formula_version_mode_matches BEFORE INSERT ON live_mixcut_production_versions
        WHEN NEW.planningMode <> (SELECT planningMode FROM live_mixcut_productions WHERE id = NEW.batchId)
        BEGIN SELECT RAISE(ABORT, 'batch version planning mode mismatch'); END;

CREATE TRIGGER live_mixcut_formula_confirmed_import_immutable BEFORE UPDATE ON live_mixcut_formula_import_sessions
        WHEN OLD.state = 'confirmed'
        BEGIN SELECT RAISE(ABORT, 'confirmed formula import is immutable'); END;

CREATE TRIGGER live_mixcut_formula_collection_owner BEFORE INSERT ON live_mixcut_formula_collections
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_productions WHERE id=NEW.batchId AND projectId=NEW.projectId AND planningMode='formula')
        BEGIN SELECT RAISE(ABORT, 'formula collection owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_collection_owner_immutable BEFORE UPDATE OF projectId, batchId ON live_mixcut_formula_collections
        WHEN OLD.projectId<>NEW.projectId OR OLD.batchId<>NEW.batchId
        BEGIN SELECT RAISE(ABORT, 'formula collection owner immutable'); END;

CREATE TRIGGER live_mixcut_formula_binding_owner BEFORE INSERT ON live_mixcut_formula_asset_bindings
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_collections c JOIN live_mixcut_assets a ON a.projectId=c.projectId
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint)
        BEGIN SELECT RAISE(ABORT, 'formula asset owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_binding_identity_immutable BEFORE UPDATE OF collectionId, assetId, contentFingerprint, sourceName, sourcePath, detectedCode, excludedReason ON live_mixcut_formula_asset_bindings
        BEGIN SELECT RAISE(ABORT, 'formula source identity immutable'); END;

CREATE TRIGGER live_mixcut_formula_material_profile_owner BEFORE INSERT ON live_mixcut_formula_material_profiles
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_asset_bindings b WHERE b.id=NEW.bindingId AND b.collectionId=NEW.collectionId)
        BEGIN SELECT RAISE(ABORT, 'formula material profile owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_material_profile_immutable BEFORE UPDATE ON live_mixcut_formula_material_profiles
        BEGIN SELECT RAISE(ABORT, 'formula material profile immutable'); END;

CREATE TRIGGER live_mixcut_formula_settings_owner BEFORE INSERT ON live_mixcut_formula_settings
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_import_sessions s WHERE s.id=NEW.scriptsSessionId
          AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula settings script owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_settings_immutable BEFORE UPDATE ON live_mixcut_formula_settings
        BEGIN SELECT RAISE(ABORT, 'formula settings immutable'); END;

CREATE TRIGGER live_mixcut_formula_generation_owner BEFORE INSERT ON live_mixcut_formula_generation_requests
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_collections c
          JOIN live_mixcut_formula_settings s ON s.collectionId=c.id
          JOIN live_mixcut_production_versions v ON v.batchId=c.batchId AND v.planningMode='formula'
          WHERE c.id=NEW.collectionId AND c.projectId=NEW.projectId AND c.batchId=NEW.batchId
            AND s.id=NEW.settingsId AND v.id=NEW.batchVersionId)
        BEGIN SELECT RAISE(ABORT, 'formula generation owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_generation_output_owner BEFORE INSERT ON live_mixcut_formula_generation_outputs
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_generation_requests r
          JOIN live_mixcut_output_plans p ON p.batchVersionId=r.batchVersionId
          WHERE r.id=NEW.requestId AND p.id=NEW.planId)
        BEGIN SELECT RAISE(ABORT, 'formula generation output owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_generation_immutable BEFORE UPDATE ON live_mixcut_formula_generation_requests
        BEGIN SELECT RAISE(ABORT, 'formula generation input immutable'); END;

CREATE TRIGGER live_mixcut_formula_generation_output_immutable BEFORE UPDATE ON live_mixcut_formula_generation_outputs
        BEGIN SELECT RAISE(ABORT, 'formula generation output identity immutable'); END;

CREATE TRIGGER live_mixcut_formula_stage_owner BEFORE INSERT ON live_mixcut_formula_stages
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_generation_outputs o WHERE o.planId=NEW.planId AND o.requestId=NEW.requestId)
        BEGIN SELECT RAISE(ABORT, 'formula stage owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_stage_immutable BEFORE UPDATE ON live_mixcut_formula_stages
        BEGIN SELECT RAISE(ABORT, 'formula stage immutable'); END;

CREATE TRIGGER live_mixcut_formula_selection_immutable BEFORE UPDATE ON live_mixcut_formula_selection_results
        BEGIN SELECT RAISE(ABORT, 'formula selection immutable'); END;

CREATE TRIGGER live_mixcut_formula_task_identity BEFORE UPDATE OF projectId,batchId,workType,targetKind,targetId ON live_mixcut_tasks
        WHEN (OLD.workType='formula_stage' OR NEW.workType='formula_stage') AND
          (OLD.projectId<>NEW.projectId OR OLD.batchId IS NOT NEW.batchId OR OLD.workType<>NEW.workType
            OR OLD.targetKind<>NEW.targetKind OR OLD.targetId<>NEW.targetId)
        BEGIN SELECT RAISE(ABORT, 'formula task identity immutable'); END;

CREATE TRIGGER live_mixcut_formula_rules_owner BEFORE INSERT ON live_mixcut_formula_selection_rules
        WHEN NEW.scriptsSessionId IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_import_sessions s WHERE s.id=NEW.scriptsSessionId
            AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula selection rules owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_rules_immutable BEFORE UPDATE ON live_mixcut_formula_selection_rules
        BEGIN SELECT RAISE(ABORT, 'formula selection rules immutable'); END;

CREATE TRIGGER live_mixcut_formula_range_owner BEFORE INSERT ON live_mixcut_formula_asset_ranges
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_collections c JOIN live_mixcut_assets a ON a.projectId=c.projectId
          JOIN live_mixcut_formula_asset_bindings f ON f.collectionId=c.id AND f.assetId=a.id
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND f.contentFingerprint=NEW.contentFingerprint AND f.excludedReason IS NULL AND f.logicalCode IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'formula range owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_range_immutable BEFORE UPDATE ON live_mixcut_formula_asset_ranges
        BEGIN SELECT RAISE(ABORT, 'formula range immutable'); END;

CREATE TRIGGER live_mixcut_formula_reselection_owner BEFORE INSERT ON live_mixcut_formula_reselections
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_stages s JOIN live_mixcut_formula_stages b
          ON b.id=NEW.baseStageId AND b.planId=s.planId AND b.requestId=s.requestId AND b.kind=s.kind
          WHERE s.id=NEW.stageId AND s.planId=NEW.planId AND s.kind='select' AND s.revision=b.revision+1)
          OR (NEW.previousOutputVersionId IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM live_mixcut_output_versions v WHERE v.id=NEW.previousOutputVersionId AND v.planId=NEW.planId))
        BEGIN SELECT RAISE(ABORT, 'formula reselection owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_reselection_immutable BEFORE UPDATE ON live_mixcut_formula_reselections
        BEGIN SELECT RAISE(ABORT, 'formula reselection input immutable'); END;

CREATE TRIGGER live_mixcut_formula_speech_owner BEFORE INSERT ON live_mixcut_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_stages s JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
          JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId JOIN live_mixcut_assets a ON a.projectId=r.projectId
          JOIN json_each(x.resultJson,'$.slots') slot
          WHERE s.id=NEW.selectionStageId AND s.kind='select' AND json_extract(x.resultJson,'$.status')='selected'
            AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND json_extract(slot.value,'$.assetId')=NEW.assetId
            AND json_extract(slot.value,'$.candidate.contentFingerprint')=NEW.contentFingerprint)
        BEGIN SELECT RAISE(ABORT, 'formula speech source owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_select_id_unique BEFORE INSERT ON live_mixcut_formula_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_speech_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_speech_immutable BEFORE UPDATE ON live_mixcut_formula_speech_stages
        BEGIN SELECT RAISE(ABORT, 'formula speech input immutable'); END;

CREATE TRIGGER live_mixcut_formula_speech_result_immutable BEFORE UPDATE ON live_mixcut_formula_speech_results
        BEGIN SELECT RAISE(ABORT, 'formula speech result immutable'); END;

CREATE TRIGGER live_mixcut_formula_task_owner BEFORE INSERT ON live_mixcut_tasks
        WHEN NEW.workType='formula_stage' AND (NEW.targetKind<>'formula_stage' OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_execution_stages s JOIN live_mixcut_formula_generation_requests r ON r.id=s.requestId
          WHERE s.id=NEW.targetId AND r.projectId=NEW.projectId AND r.batchId=NEW.batchId))
        BEGIN SELECT RAISE(ABORT, 'formula task owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_audio_mapping_owner BEFORE INSERT ON live_mixcut_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_stages s JOIN live_mixcut_formula_selection_results x ON x.stageId=s.id
          WHERE s.id=NEW.selectionStageId AND s.kind='select' AND json_extract(x.resultJson,'$.status')='selected')
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_audio_mapping_input_immutable BEFORE UPDATE ON live_mixcut_formula_audio_mapping_stages
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping input immutable'); END;

CREATE TRIGGER live_mixcut_formula_audio_mapping_result_immutable BEFORE UPDATE ON live_mixcut_formula_audio_mapping_results
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping result immutable'); END;

CREATE TRIGGER live_mixcut_formula_select_audio_identity BEFORE INSERT ON live_mixcut_formula_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_audio_mapping_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_speech_audio_identity BEFORE INSERT ON live_mixcut_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_audio_mapping_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_narration_owner BEFORE INSERT ON live_mixcut_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_audio_mapping_results x WHERE x.stageId=NEW.audioMappingStageId
            AND json_extract(x.resultJson,'$.status')='mapped')
        BEGIN SELECT RAISE(ABORT, 'formula narration owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_narration_input_immutable BEFORE UPDATE ON live_mixcut_formula_narration_stages
        BEGIN SELECT RAISE(ABORT, 'formula narration input immutable'); END;

CREATE TRIGGER live_mixcut_formula_narration_result_immutable BEFORE UPDATE ON live_mixcut_formula_narration_results
        BEGIN SELECT RAISE(ABORT, 'formula narration result immutable'); END;

CREATE TRIGGER live_mixcut_formula_select_narration_identity BEFORE INSERT ON live_mixcut_formula_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_speech_narration_identity BEFORE INSERT ON live_mixcut_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_mapping_narration_identity BEFORE INSERT ON live_mixcut_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_timeline_owner BEFORE INSERT ON live_mixcut_formula_timeline_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_audio_mapping_results x WHERE x.stageId=NEW.audioMappingStageId
            AND json_extract(x.resultJson,'$.status')='mapped'
            AND ((json_array_length(x.resultJson,'$.narrations')=0 AND NEW.narrationStageId IS NULL)
              OR (json_array_length(x.resultJson,'$.narrations')>0 AND EXISTS (
                SELECT 1 FROM live_mixcut_formula_narration_stages n JOIN live_mixcut_formula_narration_results v ON v.stageId=n.id
                WHERE n.id=NEW.narrationStageId AND n.audioMappingStageId=NEW.audioMappingStageId AND json_extract(v.resultJson,'$.status')='ready'))))
        BEGIN SELECT RAISE(ABORT, 'formula timeline owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_timeline_input_immutable BEFORE UPDATE ON live_mixcut_formula_timeline_stages
        BEGIN SELECT RAISE(ABORT, 'formula timeline input immutable'); END;

CREATE TRIGGER live_mixcut_formula_timeline_result_immutable BEFORE UPDATE ON live_mixcut_formula_timeline_results
        BEGIN SELECT RAISE(ABORT, 'formula timeline result immutable'); END;

CREATE TRIGGER live_mixcut_formula_select_timeline_identity BEFORE INSERT ON live_mixcut_formula_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_speech_timeline_identity BEFORE INSERT ON live_mixcut_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_mapping_timeline_identity BEFORE INSERT ON live_mixcut_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_narration_timeline_identity BEFORE INSERT ON live_mixcut_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_output_owner BEFORE INSERT ON live_mixcut_formula_output_versions
        WHEN NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_execution_stages s JOIN live_mixcut_formula_timeline_results x ON x.stageId=s.id
          JOIN live_mixcut_output_versions v ON v.planId=s.planId
          WHERE s.id=NEW.timelineStageId AND s.kind='timeline' AND v.id=NEW.outputVersionId
            AND json_extract(x.resultJson,'$.status')='planned'
            AND json_extract(v.arrangementJson,'$.formula.timelineStageId')=s.id
            AND json_extract(v.arrangementJson,'$.formula.selectionStageId')=s.selectionStageId
            AND json_extract(v.arrangementJson,'$.formula.version')=1
            AND json_extract(v.arrangementJson,'$.audioPlan.version')=1)
        BEGIN SELECT RAISE(ABORT, 'formula output owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_output_link_immutable BEFORE UPDATE ON live_mixcut_formula_output_versions
        BEGIN SELECT RAISE(ABORT, 'formula output link immutable'); END;

CREATE TRIGGER live_mixcut_formula_output_basis_immutable BEFORE UPDATE OF arrangementJson ON live_mixcut_output_versions
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_output_versions WHERE outputVersionId=OLD.id)
          AND json_extract(NEW.arrangementJson,'$.formula') IS NOT json_extract(OLD.arrangementJson,'$.formula')
        BEGIN SELECT RAISE(ABORT, 'formula output basis immutable'); END;

CREATE TRIGGER live_mixcut_formula_execution_check_owner BEFORE INSERT ON live_mixcut_formula_execution_checks
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM live_mixcut_formula_output_versions f JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId
          WHERE f.outputVersionId=NEW.outputVersionId
            AND json_extract(NEW.inputJson,'$.formula')=json_extract(o.arrangementJson,'$.formula'))
        BEGIN SELECT RAISE(ABORT, 'formula execution check owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_execution_check_immutable BEFORE UPDATE ON live_mixcut_formula_execution_checks
        BEGIN SELECT RAISE(ABORT, 'formula execution check immutable'); END;

CREATE TRIGGER live_mixcut_formula_execution_result_immutable BEFORE UPDATE ON live_mixcut_formula_execution_results
        BEGIN SELECT RAISE(ABORT, 'formula execution result immutable'); END;

CREATE TRIGGER live_mixcut_formula_select_execution_identity BEFORE INSERT ON live_mixcut_formula_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_speech_execution_identity BEFORE INSERT ON live_mixcut_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_mapping_execution_identity BEFORE INSERT ON live_mixcut_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_narration_execution_identity BEFORE INSERT ON live_mixcut_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_timeline_execution_identity BEFORE INSERT ON live_mixcut_formula_timeline_stages
        WHEN EXISTS (SELECT 1 FROM live_mixcut_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;

CREATE TRIGGER live_mixcut_formula_input_revision_owner BEFORE INSERT ON live_mixcut_formula_input_revisions
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_productions b
          JOIN live_mixcut_production_versions v ON v.id=NEW.baseBatchVersionId AND v.batchId=b.id
          JOIN live_mixcut_formula_collections c ON c.batchId=b.id AND c.projectId=b.projectId
          JOIN live_mixcut_formula_generation_requests r ON r.batchVersionId=v.id AND r.batchId=b.id AND r.projectId=b.projectId
          WHERE b.id=NEW.batchId AND b.projectId=NEW.projectId AND b.deletedAt IS NULL AND b.planningMode='formula'
            AND b.currentVersionId=v.id AND v.inputState='frozen' AND c.revision=NEW.openedRevision)
        BEGIN SELECT RAISE(ABORT, 'formula input revision owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_input_revision_immutable BEFORE UPDATE ON live_mixcut_formula_input_revisions
        BEGIN SELECT RAISE(ABORT, 'formula input revision immutable'); END;

CREATE TRIGGER live_mixcut_formula_manual_speech_owner BEFORE INSERT ON live_mixcut_formula_manual_speech
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_collections c JOIN live_mixcut_assets a ON a.projectId=c.projectId
          JOIN live_mixcut_formula_asset_bindings f ON f.collectionId=c.id AND f.assetId=a.id
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND c.revision=NEW.baseInputRevision AND f.contentFingerprint=NEW.contentFingerprint
            AND f.excludedReason IS NULL AND f.logicalCode IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'formula manual speech owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_manual_speech_immutable BEFORE UPDATE ON live_mixcut_formula_manual_speech
        BEGIN SELECT RAISE(ABORT, 'formula manual speech immutable'); END;

CREATE TRIGGER live_mixcut_formula_manual_audio_owner BEFORE INSERT ON live_mixcut_formula_manual_audio_inputs
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_reselections r
          JOIN live_mixcut_formula_audio_mapping_stages a ON a.selectionStageId=r.baseStageId
          WHERE r.stageId=NEW.stageId AND a.id=NEW.baseMappingStageId)
        BEGIN SELECT RAISE(ABORT, 'formula manual audio owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_manual_audio_immutable BEFORE UPDATE ON live_mixcut_formula_manual_audio_inputs
        BEGIN SELECT RAISE(ABORT, 'formula manual audio input immutable'); END;

CREATE TRIGGER live_mixcut_formula_replacement_hints_immutable BEFORE UPDATE ON live_mixcut_formula_replacement_hints
        BEGIN SELECT RAISE(ABORT, 'formula replacement hints immutable'); END;

CREATE TRIGGER live_mixcut_formula_manual_media_owner BEFORE INSERT ON live_mixcut_formula_manual_media
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_output_versions f
          JOIN live_mixcut_formula_execution_stages e ON e.id=f.timelineStageId
          JOIN live_mixcut_formula_generation_requests g ON g.id=e.requestId
          JOIN live_mixcut_assets a ON a.id=NEW.assetId AND a.projectId=g.projectId
          WHERE f.outputVersionId=NEW.outputVersionId AND g.projectId=NEW.projectId)
        BEGIN SELECT RAISE(ABORT, 'formula manual media owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_manual_media_immutable BEFORE UPDATE ON live_mixcut_formula_manual_media
        BEGIN SELECT RAISE(ABORT, 'formula manual media immutable'); END;

CREATE TRIGGER live_mixcut_formula_external_narrations_owner BEFORE INSERT ON live_mixcut_formula_external_narrations
        WHEN NOT EXISTS (SELECT 1 FROM live_mixcut_formula_import_sessions s
          WHERE s.id=NEW.scriptsSessionId AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula external narration owner mismatch'); END;

CREATE TRIGGER live_mixcut_formula_external_narrations_immutable BEFORE UPDATE ON live_mixcut_formula_external_narrations
        BEGIN SELECT RAISE(ABORT, 'formula external narration immutable'); END;
`;
