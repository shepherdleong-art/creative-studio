import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  SchemaUpgradeBackupError,
  type SchemaUpgradeDiskSpaceProbe,
} from '../../schema-upgrade/backup.ts';
import type { SchemaUpgradeOperationResult } from '../../schema-upgrade/gate.ts';
import { validateCurrentBatchSchema } from '../schema.ts';
import { FORMULA_TASK_TABLES_SQL, assertFormulaTaskRebuildSafe } from './task-schema.ts';

/** 公式能力单独追加迁移；不得提高普通批量 readiness 的必需版本。 */
export const FORMULA_SCHEMA_MIGRATIONS = [
  {
    version: 1,
    sql: `
      ALTER TABLE batch_productions ADD COLUMN planningMode TEXT NOT NULL DEFAULT 'semantic'
        CHECK(planningMode IN ('semantic','formula'));
      ALTER TABLE batch_production_versions ADD COLUMN planningMode TEXT NOT NULL DEFAULT 'semantic'
        CHECK(planningMode IN ('semantic','formula'));
      CREATE TRIGGER batch_formula_mode_immutable BEFORE UPDATE OF planningMode ON batch_productions
        WHEN OLD.planningMode <> NEW.planningMode
        BEGIN SELECT RAISE(ABORT, 'batch planning mode is immutable'); END;
      CREATE TRIGGER batch_formula_version_mode_immutable BEFORE UPDATE OF planningMode ON batch_production_versions
        WHEN OLD.planningMode <> NEW.planningMode
        BEGIN SELECT RAISE(ABORT, 'batch version planning mode is immutable'); END;
      CREATE TRIGGER batch_formula_version_mode_matches BEFORE INSERT ON batch_production_versions
        WHEN NEW.planningMode <> (SELECT planningMode FROM batch_productions WHERE id = NEW.batchId)
        BEGIN SELECT RAISE(ABORT, 'batch version planning mode mismatch'); END;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE batch_formula_collections (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL UNIQUE REFERENCES batch_productions(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
        materialsSessionId TEXT REFERENCES batch_formula_import_sessions(id) ON DELETE RESTRICT,
        scriptsSessionId TEXT REFERENCES batch_formula_import_sessions(id) ON DELETE RESTRICT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE batch_formula_import_sessions (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('materials','scripts')),
        fingerprint TEXT NOT NULL,
        filename TEXT NOT NULL,
        baseRevision INTEGER NOT NULL CHECK(baseRevision >= 0),
        previewJson TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','confirmed')),
        excludedKeysJson TEXT NOT NULL DEFAULT '[]',
        confirmedRevision INTEGER,
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId, kind, fingerprint, baseRevision)
      );
      CREATE INDEX idx_batch_formula_collections_project ON batch_formula_collections(projectId, batchId);
      CREATE TRIGGER batch_formula_confirmed_import_immutable BEFORE UPDATE ON batch_formula_import_sessions
        WHEN OLD.state = 'confirmed'
        BEGIN SELECT RAISE(ABORT, 'confirmed formula import is immutable'); END;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE batch_formula_asset_bindings (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES batch_assets(id) ON DELETE RESTRICT,
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
      CREATE INDEX idx_batch_formula_bindings_code ON batch_formula_asset_bindings(collectionId, logicalCode);
      CREATE TRIGGER batch_formula_collection_owner BEFORE INSERT ON batch_formula_collections
        WHEN NOT EXISTS (SELECT 1 FROM batch_productions WHERE id=NEW.batchId AND projectId=NEW.projectId AND planningMode='formula')
        BEGIN SELECT RAISE(ABORT, 'formula collection owner mismatch'); END;
      CREATE TRIGGER batch_formula_collection_owner_immutable BEFORE UPDATE OF projectId, batchId ON batch_formula_collections
        WHEN OLD.projectId<>NEW.projectId OR OLD.batchId<>NEW.batchId
        BEGIN SELECT RAISE(ABORT, 'formula collection owner immutable'); END;
      CREATE TRIGGER batch_formula_binding_owner BEFORE INSERT ON batch_formula_asset_bindings
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_collections c JOIN batch_assets a ON a.projectId=c.projectId
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint)
        BEGIN SELECT RAISE(ABORT, 'formula asset owner mismatch'); END;
      CREATE TRIGGER batch_formula_binding_identity_immutable BEFORE UPDATE OF collectionId, assetId, contentFingerprint, sourceName, sourcePath, detectedCode, excludedReason ON batch_formula_asset_bindings
        BEGIN SELECT RAISE(ABORT, 'formula source identity immutable'); END;
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE batch_formula_import_sessions ADD COLUMN workbookBytes BLOB;
      ALTER TABLE batch_formula_import_sessions ADD COLUMN draftRevision INTEGER NOT NULL DEFAULT 0 CHECK(draftRevision >= 0);
      ALTER TABLE batch_formula_import_sessions ADD COLUMN extractionJson TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE batch_formula_material_profiles (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        bindingId TEXT NOT NULL REFERENCES batch_formula_asset_bindings(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputFingerprint TEXT NOT NULL, sourceJson TEXT NOT NULL, contentJson TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('ai','manual')),
        provenanceJson TEXT NOT NULL, createdAt TEXT NOT NULL,
        UNIQUE(bindingId, revision)
      );
      CREATE INDEX idx_formula_material_profiles_collection ON batch_formula_material_profiles(collectionId, bindingId, revision DESC);
      CREATE TRIGGER batch_formula_material_profile_owner BEFORE INSERT ON batch_formula_material_profiles
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_asset_bindings b WHERE b.id=NEW.bindingId AND b.collectionId=NEW.collectionId)
        BEGIN SELECT RAISE(ABORT, 'formula material profile owner mismatch'); END;
      CREATE TRIGGER batch_formula_material_profile_immutable BEFORE UPDATE ON batch_formula_material_profiles
        BEGIN SELECT RAISE(ABORT, 'formula material profile immutable'); END;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE batch_formula_material_organize_runs (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        providerId TEXT NOT NULL, providerName TEXT NOT NULL, model TEXT NOT NULL, promptVersion TEXT NOT NULL,
        inputJson TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
        total INTEGER NOT NULL CHECK(total >= 0), succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded >= 0),
        skipped INTEGER NOT NULL DEFAULT 0 CHECK(skipped >= 0), errorsJson TEXT NOT NULL DEFAULT '[]',
        message TEXT, startedAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX idx_formula_material_runs_collection ON batch_formula_material_organize_runs(collectionId, startedAt DESC);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE batch_formula_settings (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        scriptsSessionId TEXT NOT NULL REFERENCES batch_formula_import_sessions(id) ON DELETE RESTRICT,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL,
        UNIQUE(collectionId, revision)
      );
      CREATE TRIGGER batch_formula_settings_owner BEFORE INSERT ON batch_formula_settings
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_import_sessions s WHERE s.id=NEW.scriptsSessionId
          AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula settings script owner mismatch'); END;
      CREATE TRIGGER batch_formula_settings_immutable BEFORE UPDATE ON batch_formula_settings
        BEGIN SELECT RAISE(ABORT, 'formula settings immutable'); END;
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE batch_formula_generation_requests (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL REFERENCES batch_productions(id) ON DELETE RESTRICT,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        batchVersionId TEXT NOT NULL UNIQUE REFERENCES batch_production_versions(id) ON DELETE RESTRICT,
        settingsId TEXT NOT NULL REFERENCES batch_formula_settings(id) ON DELETE RESTRICT,
        inputRevision INTEGER NOT NULL CHECK(inputRevision >= 0),
        requestKey TEXT NOT NULL, seed TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(projectId, batchId, requestKey)
      );
      CREATE TABLE batch_formula_generation_outputs (
        planId TEXT PRIMARY KEY REFERENCES batch_output_plans(id) ON DELETE RESTRICT,
        requestId TEXT NOT NULL REFERENCES batch_formula_generation_requests(id) ON DELETE RESTRICT,
        scriptKey TEXT NOT NULL, scriptNumber TEXT NOT NULL,
        copyIndex INTEGER NOT NULL CHECK(copyIndex > 0),
        slotsJson TEXT NOT NULL CHECK(json_valid(slotsJson)),
        UNIQUE(requestId, scriptKey, copyIndex)
      );
      CREATE TRIGGER batch_formula_generation_owner BEFORE INSERT ON batch_formula_generation_requests
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_collections c
          JOIN batch_formula_settings s ON s.collectionId=c.id
          JOIN batch_production_versions v ON v.batchId=c.batchId AND v.planningMode='formula'
          WHERE c.id=NEW.collectionId AND c.projectId=NEW.projectId AND c.batchId=NEW.batchId
            AND s.id=NEW.settingsId AND v.id=NEW.batchVersionId)
        BEGIN SELECT RAISE(ABORT, 'formula generation owner mismatch'); END;
      CREATE TRIGGER batch_formula_generation_output_owner BEFORE INSERT ON batch_formula_generation_outputs
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_generation_requests r
          JOIN batch_output_plans p ON p.batchVersionId=r.batchVersionId
          WHERE r.id=NEW.requestId AND p.id=NEW.planId)
        BEGIN SELECT RAISE(ABORT, 'formula generation output owner mismatch'); END;
      CREATE TRIGGER batch_formula_generation_immutable BEFORE UPDATE ON batch_formula_generation_requests
        BEGIN SELECT RAISE(ABORT, 'formula generation input immutable'); END;
      CREATE TRIGGER batch_formula_generation_output_immutable BEFORE UPDATE ON batch_formula_generation_outputs
        BEGIN SELECT RAISE(ABORT, 'formula generation output identity immutable'); END;
    `,
  },
  {
    version: 9,
    sql: FORMULA_TASK_TABLES_SQL + `
      CREATE TABLE batch_formula_stages (
        id TEXT PRIMARY KEY,
        requestId TEXT NOT NULL REFERENCES batch_formula_generation_requests(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES batch_formula_generation_outputs(planId) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK(kind IN ('select')),
        revision INTEGER NOT NULL CHECK(revision > 0), createdAt TEXT NOT NULL,
        UNIQUE(planId,kind,revision)
      );
      CREATE TABLE batch_formula_selection_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_stage_owner BEFORE INSERT ON batch_formula_stages
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_generation_outputs o WHERE o.planId=NEW.planId AND o.requestId=NEW.requestId)
        BEGIN SELECT RAISE(ABORT, 'formula stage owner mismatch'); END;
      CREATE TRIGGER batch_formula_stage_immutable BEFORE UPDATE ON batch_formula_stages
        BEGIN SELECT RAISE(ABORT, 'formula stage immutable'); END;
      CREATE TRIGGER batch_formula_selection_immutable BEFORE UPDATE ON batch_formula_selection_results
        BEGIN SELECT RAISE(ABORT, 'formula selection immutable'); END;
      CREATE TRIGGER batch_formula_task_owner BEFORE INSERT ON batch_tasks
        WHEN NEW.workType='formula_stage' AND (NEW.targetKind<>'formula_stage' OR NOT EXISTS (
          SELECT 1 FROM batch_formula_stages s JOIN batch_formula_generation_requests r ON r.id=s.requestId
          WHERE s.id=NEW.targetId AND r.projectId=NEW.projectId AND r.batchId=NEW.batchId))
        BEGIN SELECT RAISE(ABORT, 'formula task owner mismatch'); END;
      CREATE TRIGGER batch_formula_task_identity BEFORE UPDATE OF projectId,batchId,workType,targetKind,targetId ON batch_tasks
        WHEN (OLD.workType='formula_stage' OR NEW.workType='formula_stage') AND
          (OLD.projectId<>NEW.projectId OR OLD.batchId IS NOT NEW.batchId OR OLD.workType<>NEW.workType
            OR OLD.targetKind<>NEW.targetKind OR OLD.targetId<>NEW.targetId)
        BEGIN SELECT RAISE(ABORT, 'formula task identity immutable'); END;
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE batch_formula_selection_rules (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        scriptsSessionId TEXT REFERENCES batch_formula_import_sessions(id) ON DELETE RESTRICT,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL,
        UNIQUE(collectionId,revision)
      );
      CREATE TRIGGER batch_formula_rules_owner BEFORE INSERT ON batch_formula_selection_rules
        WHEN NEW.scriptsSessionId IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM batch_formula_import_sessions s WHERE s.id=NEW.scriptsSessionId
            AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula selection rules owner mismatch'); END;
      CREATE TRIGGER batch_formula_rules_immutable BEFORE UPDATE ON batch_formula_selection_rules
        BEGIN SELECT RAISE(ABORT, 'formula selection rules immutable'); END;
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE batch_formula_asset_ranges (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES batch_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)), createdAt TEXT NOT NULL,
        UNIQUE(collectionId,assetId,revision)
      );
      CREATE TRIGGER batch_formula_range_owner BEFORE INSERT ON batch_formula_asset_ranges
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_collections c JOIN batch_assets a ON a.projectId=c.projectId
          JOIN batch_formula_asset_bindings f ON f.collectionId=c.id AND f.assetId=a.id
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND f.contentFingerprint=NEW.contentFingerprint AND f.excludedReason IS NULL AND f.logicalCode IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'formula range owner mismatch'); END;
      CREATE TRIGGER batch_formula_range_immutable BEFORE UPDATE ON batch_formula_asset_ranges
        BEGIN SELECT RAISE(ABORT, 'formula range immutable'); END;
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE batch_formula_reselections (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_stages(id) ON DELETE RESTRICT,
        baseStageId TEXT NOT NULL REFERENCES batch_formula_stages(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES batch_formula_generation_outputs(planId) ON DELETE RESTRICT,
        requestKey TEXT NOT NULL, seed TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        previousOutputVersionId TEXT REFERENCES batch_output_versions(id) ON DELETE RESTRICT,
        previousEditRevision INTEGER NOT NULL CHECK(previousEditRevision >= 0),
        UNIQUE(planId,requestKey)
      );
      CREATE TRIGGER batch_formula_reselection_owner BEFORE INSERT ON batch_formula_reselections
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_stages s JOIN batch_formula_stages b
          ON b.id=NEW.baseStageId AND b.planId=s.planId AND b.requestId=s.requestId AND b.kind=s.kind
          WHERE s.id=NEW.stageId AND s.planId=NEW.planId AND s.kind='select' AND s.revision=b.revision+1)
          OR (NEW.previousOutputVersionId IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM batch_output_versions v WHERE v.id=NEW.previousOutputVersionId AND v.planId=NEW.planId))
        BEGIN SELECT RAISE(ABORT, 'formula reselection owner mismatch'); END;
      CREATE TRIGGER batch_formula_reselection_immutable BEFORE UPDATE ON batch_formula_reselections
        BEGIN SELECT RAISE(ABORT, 'formula reselection input immutable'); END;
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE batch_formula_selection_rules ADD COLUMN formatVersion INTEGER NOT NULL DEFAULT 1
        CHECK(formatVersion IN (1,2));
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE batch_formula_speech_stages (
        id TEXT PRIMARY KEY,
        selectionStageId TEXT NOT NULL REFERENCES batch_formula_stages(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES batch_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(selectionStageId,assetId,revision)
      );
      CREATE TABLE batch_formula_speech_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_speech_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE VIEW batch_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM batch_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM batch_formula_speech_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId;
      CREATE TRIGGER batch_formula_speech_owner BEFORE INSERT ON batch_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM batch_formula_stages s JOIN batch_formula_selection_results x ON x.stageId=s.id
          JOIN batch_formula_generation_requests r ON r.id=s.requestId JOIN batch_assets a ON a.projectId=r.projectId
          JOIN json_each(x.resultJson,'$.slots') slot
          WHERE s.id=NEW.selectionStageId AND s.kind='select' AND json_extract(x.resultJson,'$.status')='selected'
            AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND json_extract(slot.value,'$.assetId')=NEW.assetId
            AND json_extract(slot.value,'$.candidate.contentFingerprint')=NEW.contentFingerprint)
        BEGIN SELECT RAISE(ABORT, 'formula speech source owner mismatch'); END;
      CREATE TRIGGER batch_formula_select_id_unique BEFORE INSERT ON batch_formula_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_speech_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_speech_immutable BEFORE UPDATE ON batch_formula_speech_stages
        BEGIN SELECT RAISE(ABORT, 'formula speech input immutable'); END;
      CREATE TRIGGER batch_formula_speech_result_immutable BEFORE UPDATE ON batch_formula_speech_results
        BEGIN SELECT RAISE(ABORT, 'formula speech result immutable'); END;
      DROP TRIGGER batch_formula_task_owner;
      CREATE TRIGGER batch_formula_task_owner BEFORE INSERT ON batch_tasks
        WHEN NEW.workType='formula_stage' AND (NEW.targetKind<>'formula_stage' OR NOT EXISTS (
          SELECT 1 FROM batch_formula_execution_stages s JOIN batch_formula_generation_requests r ON r.id=s.requestId
          WHERE s.id=NEW.targetId AND r.projectId=NEW.projectId AND r.batchId=NEW.batchId))
        BEGIN SELECT RAISE(ABORT, 'formula task owner mismatch'); END;
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE batch_formula_audio_mapping_stages (
        id TEXT PRIMARY KEY,
        selectionStageId TEXT NOT NULL REFERENCES batch_formula_stages(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL,
        UNIQUE(selectionStageId,revision)
      );
      CREATE TABLE batch_formula_audio_mapping_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_audio_mapping_owner BEFORE INSERT ON batch_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM batch_formula_stages s JOIN batch_formula_selection_results x ON x.stageId=s.id
          WHERE s.id=NEW.selectionStageId AND s.kind='select' AND json_extract(x.resultJson,'$.status')='selected')
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping owner mismatch'); END;
      CREATE TRIGGER batch_formula_audio_mapping_input_immutable BEFORE UPDATE ON batch_formula_audio_mapping_stages
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping input immutable'); END;
      CREATE TRIGGER batch_formula_audio_mapping_result_immutable BEFORE UPDATE ON batch_formula_audio_mapping_results
        BEGIN SELECT RAISE(ABORT, 'formula audio mapping result immutable'); END;
      CREATE TRIGGER batch_formula_select_audio_identity BEFORE INSERT ON batch_formula_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_audio_mapping_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_speech_audio_identity BEFORE INSERT ON batch_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_audio_mapping_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      DROP VIEW batch_formula_execution_stages;
      CREATE VIEW batch_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM batch_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM batch_formula_speech_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'audio_mapping',a.revision,s.id,NULL
          FROM batch_formula_audio_mapping_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId;
    `,
  },
  {
    version: 16,
    sql: `
      CREATE TABLE batch_formula_narration_stages (
        id TEXT PRIMARY KEY,
        audioMappingStageId TEXT NOT NULL UNIQUE REFERENCES batch_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL
      );
      CREATE TABLE batch_formula_narration_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_narration_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_narration_owner BEFORE INSERT ON batch_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM batch_formula_audio_mapping_results x WHERE x.stageId=NEW.audioMappingStageId
            AND json_extract(x.resultJson,'$.status')='mapped')
        BEGIN SELECT RAISE(ABORT, 'formula narration owner mismatch'); END;
      CREATE TRIGGER batch_formula_narration_input_immutable BEFORE UPDATE ON batch_formula_narration_stages
        BEGIN SELECT RAISE(ABORT, 'formula narration input immutable'); END;
      CREATE TRIGGER batch_formula_narration_result_immutable BEFORE UPDATE ON batch_formula_narration_results
        BEGIN SELECT RAISE(ABORT, 'formula narration result immutable'); END;
      CREATE TRIGGER batch_formula_select_narration_identity BEFORE INSERT ON batch_formula_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_speech_narration_identity BEFORE INSERT ON batch_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_mapping_narration_identity BEFORE INSERT ON batch_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_narration_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      DROP VIEW batch_formula_execution_stages;
      CREATE VIEW batch_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM batch_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM batch_formula_speech_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'audio_mapping',a.revision,s.id,NULL
          FROM batch_formula_audio_mapping_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT n.id,s.requestId,s.planId,'narration',a.revision,s.id,NULL
          FROM batch_formula_narration_stages n JOIN batch_formula_audio_mapping_stages a ON a.id=n.audioMappingStageId
          JOIN batch_formula_stages s ON s.id=a.selectionStageId;
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE batch_formula_timeline_stages (
        id TEXT PRIMARY KEY,
        audioMappingStageId TEXT NOT NULL UNIQUE REFERENCES batch_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        narrationStageId TEXT REFERENCES batch_formula_narration_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)), createdAt TEXT NOT NULL
      );
      CREATE TABLE batch_formula_timeline_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_timeline_stages(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_timeline_owner BEFORE INSERT ON batch_formula_timeline_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM batch_formula_audio_mapping_results x WHERE x.stageId=NEW.audioMappingStageId
            AND json_extract(x.resultJson,'$.status')='mapped'
            AND ((json_array_length(x.resultJson,'$.narrations')=0 AND NEW.narrationStageId IS NULL)
              OR (json_array_length(x.resultJson,'$.narrations')>0 AND EXISTS (
                SELECT 1 FROM batch_formula_narration_stages n JOIN batch_formula_narration_results v ON v.stageId=n.id
                WHERE n.id=NEW.narrationStageId AND n.audioMappingStageId=NEW.audioMappingStageId AND json_extract(v.resultJson,'$.status')='ready'))))
        BEGIN SELECT RAISE(ABORT, 'formula timeline owner mismatch'); END;
      CREATE TRIGGER batch_formula_timeline_input_immutable BEFORE UPDATE ON batch_formula_timeline_stages
        BEGIN SELECT RAISE(ABORT, 'formula timeline input immutable'); END;
      CREATE TRIGGER batch_formula_timeline_result_immutable BEFORE UPDATE ON batch_formula_timeline_results
        BEGIN SELECT RAISE(ABORT, 'formula timeline result immutable'); END;
      CREATE TRIGGER batch_formula_select_timeline_identity BEFORE INSERT ON batch_formula_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_speech_timeline_identity BEFORE INSERT ON batch_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_mapping_timeline_identity BEFORE INSERT ON batch_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_narration_timeline_identity BEFORE INSERT ON batch_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_timeline_stages WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      DROP VIEW batch_formula_execution_stages;
      CREATE VIEW batch_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM batch_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM batch_formula_speech_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'audio_mapping',a.revision,s.id,NULL
          FROM batch_formula_audio_mapping_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT n.id,s.requestId,s.planId,'narration',a.revision,s.id,NULL
          FROM batch_formula_narration_stages n JOIN batch_formula_audio_mapping_stages a ON a.id=n.audioMappingStageId
          JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT t.id,s.requestId,s.planId,'timeline',a.revision,s.id,NULL
          FROM batch_formula_timeline_stages t JOIN batch_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId
          JOIN batch_formula_stages s ON s.id=a.selectionStageId;
    `,
  },
  {
    version: 18,
    sql: `
      CREATE TABLE batch_formula_output_versions (
        timelineStageId TEXT PRIMARY KEY REFERENCES batch_formula_timeline_stages(id) ON DELETE RESTRICT,
        outputVersionId TEXT NOT NULL UNIQUE REFERENCES batch_output_versions(id) ON DELETE RESTRICT,
        createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_output_owner BEFORE INSERT ON batch_formula_output_versions
        WHEN NOT EXISTS (
          SELECT 1 FROM batch_formula_execution_stages s JOIN batch_formula_timeline_results x ON x.stageId=s.id
          JOIN batch_output_versions v ON v.planId=s.planId
          WHERE s.id=NEW.timelineStageId AND s.kind='timeline' AND v.id=NEW.outputVersionId
            AND json_extract(x.resultJson,'$.status')='planned'
            AND json_extract(v.arrangementJson,'$.formula.timelineStageId')=s.id
            AND json_extract(v.arrangementJson,'$.formula.selectionStageId')=s.selectionStageId
            AND json_extract(v.arrangementJson,'$.formula.version')=1
            AND json_extract(v.arrangementJson,'$.audioPlan.version')=1)
        BEGIN SELECT RAISE(ABORT, 'formula output owner mismatch'); END;
      CREATE TRIGGER batch_formula_output_link_immutable BEFORE UPDATE ON batch_formula_output_versions
        BEGIN SELECT RAISE(ABORT, 'formula output link immutable'); END;
      CREATE TRIGGER batch_formula_output_basis_immutable BEFORE UPDATE OF arrangementJson ON batch_output_versions
        WHEN EXISTS (SELECT 1 FROM batch_formula_output_versions WHERE outputVersionId=OLD.id)
          AND json_extract(NEW.arrangementJson,'$.formula') IS NOT json_extract(OLD.arrangementJson,'$.formula')
        BEGIN SELECT RAISE(ABORT, 'formula output basis immutable'); END;
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE batch_formula_execution_checks (
        id TEXT PRIMARY KEY,
        outputVersionId TEXT NOT NULL REFERENCES batch_formula_output_versions(outputVersionId) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        inputKey TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(outputVersionId,inputKey), UNIQUE(outputVersionId,revision)
      );
      CREATE TABLE batch_formula_execution_results (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_execution_checks(id) ON DELETE RESTRICT,
        resultJson TEXT NOT NULL CHECK(json_valid(resultJson)), createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_execution_check_owner BEFORE INSERT ON batch_formula_execution_checks
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_stages WHERE id=NEW.id) OR NOT EXISTS (
          SELECT 1 FROM batch_formula_output_versions f JOIN batch_output_versions o ON o.id=f.outputVersionId
          WHERE f.outputVersionId=NEW.outputVersionId
            AND json_extract(NEW.inputJson,'$.formula')=json_extract(o.arrangementJson,'$.formula'))
        BEGIN SELECT RAISE(ABORT, 'formula execution check owner mismatch'); END;
      CREATE TRIGGER batch_formula_execution_check_immutable BEFORE UPDATE ON batch_formula_execution_checks
        BEGIN SELECT RAISE(ABORT, 'formula execution check immutable'); END;
      CREATE TRIGGER batch_formula_execution_result_immutable BEFORE UPDATE ON batch_formula_execution_results
        BEGIN SELECT RAISE(ABORT, 'formula execution result immutable'); END;
      CREATE TRIGGER batch_formula_select_execution_identity BEFORE INSERT ON batch_formula_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_speech_execution_identity BEFORE INSERT ON batch_formula_speech_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_mapping_execution_identity BEFORE INSERT ON batch_formula_audio_mapping_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_narration_execution_identity BEFORE INSERT ON batch_formula_narration_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      CREATE TRIGGER batch_formula_timeline_execution_identity BEFORE INSERT ON batch_formula_timeline_stages
        WHEN EXISTS (SELECT 1 FROM batch_formula_execution_checks WHERE id=NEW.id)
        BEGIN SELECT RAISE(ABORT, 'formula stage identity collision'); END;
      DROP VIEW batch_formula_execution_stages;
      CREATE VIEW batch_formula_execution_stages AS
        SELECT id,requestId,planId,kind,revision,id AS selectionStageId,NULL AS assetId FROM batch_formula_stages
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'source_speech',a.revision,s.id,a.assetId
          FROM batch_formula_speech_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT a.id,s.requestId,s.planId,'audio_mapping',a.revision,s.id,NULL
          FROM batch_formula_audio_mapping_stages a JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT n.id,s.requestId,s.planId,'narration',a.revision,s.id,NULL
          FROM batch_formula_narration_stages n JOIN batch_formula_audio_mapping_stages a ON a.id=n.audioMappingStageId
          JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT t.id,s.requestId,s.planId,'timeline',a.revision,s.id,NULL
          FROM batch_formula_timeline_stages t JOIN batch_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId
          JOIN batch_formula_stages s ON s.id=a.selectionStageId
        UNION ALL
        SELECT e.id,s.requestId,s.planId,'execution',e.revision,s.id,NULL
          FROM batch_formula_execution_checks e JOIN batch_formula_output_versions f ON f.outputVersionId=e.outputVersionId
          JOIN batch_formula_timeline_stages t ON t.id=f.timelineStageId
          JOIN batch_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId JOIN batch_formula_stages s ON s.id=a.selectionStageId;
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE batch_formula_export_packages (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL REFERENCES batch_productions(id) ON DELETE RESTRICT,
        requestKey TEXT NOT NULL,
        selectionJson TEXT NOT NULL CHECK(json_valid(selectionJson)),
        manifestJson TEXT NOT NULL CHECK(json_valid(manifestJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(projectId,batchId,requestKey)
      );
      CREATE TABLE batch_formula_export_package_items (
        packageId TEXT NOT NULL REFERENCES batch_formula_export_packages(id) ON DELETE RESTRICT,
        planId TEXT NOT NULL REFERENCES batch_output_plans(id) ON DELETE RESTRICT,
        videoArtifactId TEXT NOT NULL REFERENCES batch_artifacts(id) ON DELETE RESTRICT,
        coverArtifactId TEXT NOT NULL REFERENCES batch_artifacts(id) ON DELETE RESTRICT,
        PRIMARY KEY(packageId,planId)
      );
      CREATE TRIGGER batch_formula_export_package_owner BEFORE INSERT ON batch_formula_export_packages
        WHEN NOT EXISTS (SELECT 1 FROM batch_productions b WHERE b.id=NEW.batchId
          AND b.projectId=NEW.projectId AND b.planningMode='formula' AND b.deletedAt IS NULL)
        BEGIN SELECT RAISE(ABORT, 'formula package owner mismatch'); END;
      CREATE TRIGGER batch_formula_export_package_item_owner BEFORE INSERT ON batch_formula_export_package_items
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_export_packages p
          JOIN batch_artifacts v ON v.id=NEW.videoArtifactId AND v.kind='video'
          JOIN batch_artifacts c ON c.id=NEW.coverArtifactId AND c.kind='cover'
          WHERE p.id=NEW.packageId AND v.projectId=p.projectId AND c.projectId=p.projectId
            AND v.batchId=p.batchId AND c.batchId=p.batchId
            AND v.outputPlanId=NEW.planId AND c.outputPlanId=NEW.planId AND v.outputVersionId=c.outputVersionId)
        BEGIN SELECT RAISE(ABORT, 'formula package artifact mismatch'); END;
      CREATE TRIGGER batch_formula_export_package_immutable BEFORE UPDATE ON batch_formula_export_packages
        BEGIN SELECT RAISE(ABORT, 'formula package immutable'); END;
      CREATE TRIGGER batch_formula_export_package_item_immutable BEFORE UPDATE ON batch_formula_export_package_items
        BEGIN SELECT RAISE(ABORT, 'formula package item immutable'); END;
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE batch_formula_input_revisions (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        batchId TEXT NOT NULL REFERENCES batch_productions(id) ON DELETE RESTRICT,
        baseBatchVersionId TEXT NOT NULL UNIQUE REFERENCES batch_production_versions(id) ON DELETE RESTRICT,
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision >= 0),
        openedRevision INTEGER NOT NULL CHECK(openedRevision=baseInputRevision+1),
        createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_input_revision_owner BEFORE INSERT ON batch_formula_input_revisions
        WHEN NOT EXISTS (SELECT 1 FROM batch_productions b
          JOIN batch_production_versions v ON v.id=NEW.baseBatchVersionId AND v.batchId=b.id
          JOIN batch_formula_collections c ON c.batchId=b.id AND c.projectId=b.projectId
          JOIN batch_formula_generation_requests r ON r.batchVersionId=v.id AND r.batchId=b.id AND r.projectId=b.projectId
          WHERE b.id=NEW.batchId AND b.projectId=NEW.projectId AND b.deletedAt IS NULL AND b.planningMode='formula'
            AND b.currentVersionId=v.id AND v.inputState='frozen' AND c.revision=NEW.openedRevision)
        BEGIN SELECT RAISE(ABORT, 'formula input revision owner mismatch'); END;
      CREATE TRIGGER batch_formula_input_revision_immutable BEFORE UPDATE ON batch_formula_input_revisions
        BEGIN SELECT RAISE(ABORT, 'formula input revision immutable'); END;
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE batch_formula_manual_speech (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES batch_assets(id) ON DELETE RESTRICT,
        contentFingerprint TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,assetId,revision)
      );
      CREATE TRIGGER batch_formula_manual_speech_owner BEFORE INSERT ON batch_formula_manual_speech
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_collections c JOIN batch_assets a ON a.projectId=c.projectId
          JOIN batch_formula_asset_bindings f ON f.collectionId=c.id AND f.assetId=a.id
          WHERE c.id=NEW.collectionId AND a.id=NEW.assetId AND a.contentFingerprint=NEW.contentFingerprint
            AND c.revision=NEW.baseInputRevision AND f.contentFingerprint=NEW.contentFingerprint
            AND f.excludedReason IS NULL AND f.logicalCode IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'formula manual speech owner mismatch'); END;
      CREATE TRIGGER batch_formula_manual_speech_immutable BEFORE UPDATE ON batch_formula_manual_speech
        BEGIN SELECT RAISE(ABORT, 'formula manual speech immutable'); END;
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE batch_formula_manual_audio_inputs (
        stageId TEXT PRIMARY KEY REFERENCES batch_formula_reselections(stageId) ON DELETE RESTRICT,
        baseMappingStageId TEXT NOT NULL REFERENCES batch_formula_audio_mapping_stages(id) ON DELETE RESTRICT,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        createdAt TEXT NOT NULL
      );
      CREATE TRIGGER batch_formula_manual_audio_owner BEFORE INSERT ON batch_formula_manual_audio_inputs
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_reselections r
          JOIN batch_formula_audio_mapping_stages a ON a.selectionStageId=r.baseStageId
          WHERE r.stageId=NEW.stageId AND a.id=NEW.baseMappingStageId)
        BEGIN SELECT RAISE(ABORT, 'formula manual audio owner mismatch'); END;
      CREATE TRIGGER batch_formula_manual_audio_immutable BEFORE UPDATE ON batch_formula_manual_audio_inputs
        BEGIN SELECT RAISE(ABORT, 'formula manual audio input immutable'); END;
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE batch_formula_replacement_hints (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        filename TEXT NOT NULL, fingerprint TEXT NOT NULL,
        hintsJson TEXT NOT NULL CHECK(json_valid(hintsJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,baseInputRevision)
      );
      CREATE TRIGGER batch_formula_replacement_hints_immutable BEFORE UPDATE ON batch_formula_replacement_hints
        BEGIN SELECT RAISE(ABORT, 'formula replacement hints immutable'); END;
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE batch_formula_manual_media (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        outputVersionId TEXT NOT NULL REFERENCES batch_formula_output_versions(outputVersionId) ON DELETE RESTRICT,
        assetId TEXT NOT NULL REFERENCES batch_assets(id) ON DELETE RESTRICT,
        requestKey TEXT NOT NULL,
        inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
        proofJson TEXT NOT NULL CHECK(json_valid(proofJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(outputVersionId,requestKey)
      );
      CREATE TRIGGER batch_formula_manual_media_owner BEFORE INSERT ON batch_formula_manual_media
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_output_versions f
          JOIN batch_formula_execution_stages e ON e.id=f.timelineStageId
          JOIN batch_formula_generation_requests g ON g.id=e.requestId
          JOIN batch_assets a ON a.id=NEW.assetId AND a.projectId=g.projectId
          WHERE f.outputVersionId=NEW.outputVersionId AND g.projectId=NEW.projectId)
        BEGIN SELECT RAISE(ABORT, 'formula manual media owner mismatch'); END;
      CREATE TRIGGER batch_formula_manual_media_immutable BEFORE UPDATE ON batch_formula_manual_media
        BEGIN SELECT RAISE(ABORT, 'formula manual media immutable'); END;
    `,
  },
  {
    version: 26,
    sql: `
      CREATE TABLE batch_formula_external_narrations (
        id TEXT PRIMARY KEY,
        collectionId TEXT NOT NULL REFERENCES batch_formula_collections(id) ON DELETE RESTRICT,
        scriptsSessionId TEXT NOT NULL REFERENCES batch_formula_import_sessions(id) ON DELETE RESTRICT,
        scriptKey TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0),
        baseInputRevision INTEGER NOT NULL CHECK(baseInputRevision>=0),
        inputHash TEXT NOT NULL,
        contentJson TEXT NOT NULL CHECK(json_valid(contentJson)),
        createdAt TEXT NOT NULL,
        UNIQUE(collectionId,scriptsSessionId,scriptKey,revision)
      );
      CREATE TRIGGER batch_formula_external_narrations_owner BEFORE INSERT ON batch_formula_external_narrations
        WHEN NOT EXISTS (SELECT 1 FROM batch_formula_import_sessions s
          WHERE s.id=NEW.scriptsSessionId AND s.collectionId=NEW.collectionId AND s.kind='scripts' AND s.state='confirmed')
        BEGIN SELECT RAISE(ABORT, 'formula external narration owner mismatch'); END;
      CREATE TRIGGER batch_formula_external_narrations_immutable BEFORE UPDATE ON batch_formula_external_narrations
        BEGIN SELECT RAISE(ABORT, 'formula external narration immutable'); END;
    `,
  },
] as const;

function validateFormulaSchema(db: Database.Database, version: number): void {
  if (version >= 26) {
    db.prepare('SELECT id,collectionId,scriptsSessionId,scriptKey,revision,baseInputRevision,inputHash,contentJson,createdAt FROM batch_formula_external_narrations LIMIT 1').get();
    for (const name of ['batch_formula_external_narrations_owner', 'batch_formula_external_narrations_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('外部配音约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_external_narrations n
      LEFT JOIN batch_formula_import_sessions s ON s.id=n.scriptsSessionId
      WHERE s.collectionId IS NOT n.collectionId OR s.kind IS NOT 'scripts' OR s.state IS NOT 'confirmed' LIMIT 1`).get()) {
      throw new Error('外部配音脚本归属不一致');
    }
  }
  if (version >= 25) {
    db.prepare('SELECT id,projectId,outputVersionId,assetId,requestKey,inputJson,proofJson,createdAt FROM batch_formula_manual_media LIMIT 1').get();
    for (const name of ['batch_formula_manual_media_owner', 'batch_formula_manual_media_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式人工素材约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_manual_media m
      LEFT JOIN batch_formula_output_versions f ON f.outputVersionId=m.outputVersionId
      LEFT JOIN batch_formula_execution_stages e ON e.id=f.timelineStageId
      LEFT JOIN batch_formula_generation_requests g ON g.id=e.requestId
      LEFT JOIN batch_assets a ON a.id=m.assetId
      WHERE g.projectId IS NOT m.projectId OR a.projectId IS NOT m.projectId LIMIT 1`).get()) throw new Error('公式人工素材归属不一致');
  }
  if (version >= 24) {
    db.prepare('SELECT id,collectionId,baseInputRevision,filename,fingerprint,hintsJson,createdAt FROM batch_formula_replacement_hints LIMIT 1').get();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='batch_formula_replacement_hints_immutable'").get()) {
      throw new Error('公式替换建议不可变约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_replacement_hints h LEFT JOIN batch_formula_collections c ON c.id=h.collectionId
      WHERE c.id IS NULL OR h.baseInputRevision>=c.revision LIMIT 1`).get()) throw new Error('公式替换建议归属或修订不一致');
  }
  if (version >= 23) {
    db.prepare('SELECT stageId,baseMappingStageId,inputJson,createdAt FROM batch_formula_manual_audio_inputs LIMIT 1').get();
    for (const name of ['batch_formula_manual_audio_owner', 'batch_formula_manual_audio_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式人工声音用途约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_manual_audio_inputs m
      LEFT JOIN batch_formula_reselections r ON r.stageId=m.stageId
      LEFT JOIN batch_formula_audio_mapping_stages a ON a.id=m.baseMappingStageId
      WHERE r.baseStageId IS NOT a.selectionStageId LIMIT 1`).get()) throw new Error('公式人工声音用途归属不一致');
  }
  if (version >= 22) {
    db.prepare('SELECT id,collectionId,assetId,contentFingerprint,revision,baseInputRevision,contentJson,createdAt FROM batch_formula_manual_speech LIMIT 1').get();
    for (const name of ['batch_formula_manual_speech_owner', 'batch_formula_manual_speech_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式人工台词约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_manual_speech m
      LEFT JOIN batch_formula_collections c ON c.id=m.collectionId LEFT JOIN batch_assets a ON a.id=m.assetId
      WHERE c.projectId IS NOT a.projectId OR a.contentFingerprint IS NOT m.contentFingerprint
        OR c.revision<=m.baseInputRevision LIMIT 1`).get()) throw new Error('公式人工台词归属不一致');
  }
  if (version >= 21) {
    db.prepare('SELECT id,projectId,batchId,baseBatchVersionId,baseInputRevision,openedRevision,createdAt FROM batch_formula_input_revisions LIMIT 1').get();
    for (const name of ['batch_formula_input_revision_owner', 'batch_formula_input_revision_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式输入修订约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_input_revisions e
      LEFT JOIN batch_formula_generation_requests r ON r.batchVersionId=e.baseBatchVersionId
      LEFT JOIN batch_formula_collections c ON c.batchId=e.batchId
      WHERE r.projectId IS NOT e.projectId OR r.batchId IS NOT e.batchId
        OR c.projectId IS NOT e.projectId OR c.revision<e.openedRevision
        OR e.openedRevision!=e.baseInputRevision+1 LIMIT 1`).get()) throw new Error('公式输入修订归属不一致');
  }
  if (version >= 20) {
    db.prepare('SELECT id,projectId,batchId,requestKey,selectionJson,manifestJson,createdAt FROM batch_formula_export_packages LIMIT 1').get();
    db.prepare('SELECT packageId,planId,videoArtifactId,coverArtifactId FROM batch_formula_export_package_items LIMIT 1').get();
    for (const name of ['batch_formula_export_package_owner', 'batch_formula_export_package_item_owner',
      'batch_formula_export_package_immutable', 'batch_formula_export_package_item_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式导出包约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_export_package_items i
      JOIN batch_formula_export_packages p ON p.id=i.packageId
      JOIN batch_artifacts v ON v.id=i.videoArtifactId JOIN batch_artifacts c ON c.id=i.coverArtifactId
      WHERE v.kind!='video' OR c.kind!='cover' OR v.projectId!=p.projectId OR c.projectId!=p.projectId
        OR v.batchId!=p.batchId OR c.batchId!=p.batchId OR v.outputPlanId!=i.planId OR c.outputPlanId!=i.planId
        OR v.outputVersionId!=c.outputVersionId LIMIT 1`).get()) throw new Error('公式导出包产物归属不一致');
  }
  if (version >= 19) {
    db.prepare('SELECT id,outputVersionId,revision,inputKey,inputJson,createdAt FROM batch_formula_execution_checks LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_execution_results LIMIT 1').get();
    for (const name of ['batch_formula_execution_check_owner', 'batch_formula_execution_check_immutable', 'batch_formula_execution_result_immutable',
      'batch_formula_select_execution_identity', 'batch_formula_speech_execution_identity', 'batch_formula_mapping_execution_identity',
      'batch_formula_narration_execution_identity', 'batch_formula_timeline_execution_identity']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式执行检查约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_execution_checks e LEFT JOIN batch_formula_output_versions f ON f.outputVersionId=e.outputVersionId
      LEFT JOIN batch_output_versions o ON o.id=e.outputVersionId LEFT JOIN batch_formula_execution_stages s ON s.id=e.id AND s.kind='execution'
      WHERE f.outputVersionId IS NULL OR s.id IS NULL OR json_extract(e.inputJson,'$.formula') IS NOT json_extract(o.arrangementJson,'$.formula') LIMIT 1`).get()) {
      throw new Error('公式执行检查归属不一致');
    }
  }
  if (version >= 18) {
    db.prepare('SELECT timelineStageId,outputVersionId,createdAt FROM batch_formula_output_versions LIMIT 1').get();
    for (const name of ['batch_formula_output_owner', 'batch_formula_output_link_immutable', 'batch_formula_output_basis_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式输出版本约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_output_versions f
      LEFT JOIN batch_formula_execution_stages s ON s.id=f.timelineStageId LEFT JOIN batch_output_versions v ON v.id=f.outputVersionId
      LEFT JOIN batch_formula_timeline_results x ON x.stageId=f.timelineStageId
      WHERE s.id IS NULL OR v.id IS NULL OR x.stageId IS NULL OR s.kind<>'timeline' OR s.planId<>v.planId
        OR json_extract(x.resultJson,'$.status') IS NOT 'planned'
        OR json_extract(v.arrangementJson,'$.formula.timelineStageId') IS NOT s.id
        OR json_extract(v.arrangementJson,'$.formula.selectionStageId') IS NOT s.selectionStageId
        OR json_extract(v.arrangementJson,'$.formula.version') IS NOT 1
        OR json_extract(v.arrangementJson,'$.audioPlan.version') IS NOT 1 LIMIT 1`).get()) throw new Error('公式输出版本归属或格式不一致');
  }
  if (version >= 17) {
    db.prepare('SELECT id,audioMappingStageId,narrationStageId,inputJson,createdAt FROM batch_formula_timeline_stages LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_timeline_results LIMIT 1').get();
    for (const name of ['batch_formula_timeline_owner', 'batch_formula_timeline_input_immutable', 'batch_formula_timeline_result_immutable',
      'batch_formula_select_timeline_identity', 'batch_formula_speech_timeline_identity', 'batch_formula_mapping_timeline_identity', 'batch_formula_narration_timeline_identity']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式时间线约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_timeline_stages t LEFT JOIN batch_formula_audio_mapping_results x ON x.stageId=t.audioMappingStageId
      LEFT JOIN batch_formula_narration_stages n ON n.id=t.narrationStageId LEFT JOIN batch_formula_narration_results v ON v.stageId=n.id
      WHERE x.stageId IS NULL OR json_extract(x.resultJson,'$.status')<>'mapped'
        OR (json_array_length(x.resultJson,'$.narrations')=0 AND t.narrationStageId IS NOT NULL)
        OR (json_array_length(x.resultJson,'$.narrations')>0 AND (v.stageId IS NULL OR n.audioMappingStageId<>t.audioMappingStageId OR json_extract(v.resultJson,'$.status')<>'ready'))
        OR EXISTS (SELECT 1 FROM batch_formula_stages WHERE id=t.id)
        OR EXISTS (SELECT 1 FROM batch_formula_speech_stages WHERE id=t.id)
        OR EXISTS (SELECT 1 FROM batch_formula_audio_mapping_stages WHERE id=t.id)
        OR EXISTS (SELECT 1 FROM batch_formula_narration_stages WHERE id=t.id) LIMIT 1`).get()) throw new Error('公式时间线归属或声音依据不一致');
  }
  if (version >= 16) {
    db.prepare('SELECT id,audioMappingStageId,inputJson,createdAt FROM batch_formula_narration_stages LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_narration_results LIMIT 1').get();
    for (const name of ['batch_formula_narration_owner', 'batch_formula_narration_input_immutable', 'batch_formula_narration_result_immutable',
      'batch_formula_select_narration_identity', 'batch_formula_speech_narration_identity', 'batch_formula_mapping_narration_identity']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式配音约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_narration_stages n LEFT JOIN batch_formula_audio_mapping_results x ON x.stageId=n.audioMappingStageId
      WHERE x.stageId IS NULL OR json_extract(x.resultJson,'$.status')<>'mapped'
        OR EXISTS (SELECT 1 FROM batch_formula_stages WHERE id=n.id)
        OR EXISTS (SELECT 1 FROM batch_formula_speech_stages WHERE id=n.id)
        OR EXISTS (SELECT 1 FROM batch_formula_audio_mapping_stages WHERE id=n.id) LIMIT 1`).get()) throw new Error('公式配音归属不一致');
  }
  if (version >= 15) {
    db.prepare('SELECT id,selectionStageId,revision,inputJson,createdAt FROM batch_formula_audio_mapping_stages LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_audio_mapping_results LIMIT 1').get();
    for (const name of ['batch_formula_audio_mapping_owner', 'batch_formula_audio_mapping_input_immutable',
      'batch_formula_audio_mapping_result_immutable', 'batch_formula_select_audio_identity', 'batch_formula_speech_audio_identity']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式声音映射约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_audio_mapping_stages a
      LEFT JOIN batch_formula_selection_results x ON x.stageId=a.selectionStageId
      WHERE x.stageId IS NULL OR json_extract(x.resultJson,'$.status')<>'selected'
        OR EXISTS (SELECT 1 FROM batch_formula_stages WHERE id=a.id)
        OR EXISTS (SELECT 1 FROM batch_formula_speech_stages WHERE id=a.id) LIMIT 1`).get()) throw new Error('公式声音映射归属不一致');
  }
  if (version >= 14) {
    db.prepare('SELECT id,selectionStageId,assetId,contentFingerprint,revision,inputJson,createdAt FROM batch_formula_speech_stages LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_speech_results LIMIT 1').get();
    db.prepare('SELECT id,requestId,planId,kind,revision,selectionStageId,assetId FROM batch_formula_execution_stages LIMIT 1').get();
    for (const name of ['batch_formula_speech_owner','batch_formula_select_id_unique','batch_formula_speech_immutable','batch_formula_speech_result_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式声音约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_speech_stages a
      LEFT JOIN batch_formula_stages s ON s.id=a.selectionStageId
      LEFT JOIN batch_formula_generation_requests r ON r.id=s.requestId LEFT JOIN batch_assets m ON m.id=a.assetId
      WHERE s.id IS NULL OR s.kind<>'select' OR m.id IS NULL OR m.projectId<>r.projectId
        OR a.contentFingerprint<>m.contentFingerprint OR EXISTS (SELECT 1 FROM batch_formula_stages WHERE id=a.id) LIMIT 1`).get()) {
      throw new Error('公式声音归属或文件身份不一致');
    }
  }
  if (version >= 13) {
    const columns = db.prepare('PRAGMA table_info(batch_formula_selection_rules)').all() as Array<{ name: string; type: string; notnull: number }>;
    const format = columns.find(column => column.name === 'formatVersion');
    if (format?.type !== 'INTEGER' || format.notnull !== 1
      || db.prepare('SELECT 1 FROM batch_formula_selection_rules WHERE formatVersion IS NULL OR formatVersion NOT IN (1,2) LIMIT 1').get()) {
      throw new Error('公式人工选片格式版本无效');
    }
  }
  if (version >= 12) {
    db.prepare('SELECT stageId,baseStageId,planId,requestKey,seed,inputJson,previousOutputVersionId,previousEditRevision FROM batch_formula_reselections LIMIT 1').get();
    for (const name of ['batch_formula_reselection_owner', 'batch_formula_reselection_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式重选约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_reselections r
      LEFT JOIN batch_formula_stages s ON s.id=r.stageId LEFT JOIN batch_formula_stages b ON b.id=r.baseStageId
      LEFT JOIN batch_output_versions v ON v.id=r.previousOutputVersionId
      WHERE s.id IS NULL OR b.id IS NULL OR s.planId<>r.planId OR b.planId<>r.planId OR s.requestId<>b.requestId
        OR s.kind<>'select' OR b.kind<>'select' OR s.revision<>b.revision+1
        OR (r.previousOutputVersionId IS NOT NULL AND (v.id IS NULL OR v.planId<>r.planId)) LIMIT 1`).get()) {
      throw new Error('公式重选归属或版本不一致');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_stages s LEFT JOIN batch_formula_reselections r ON r.stageId=s.id
      WHERE s.kind='select' AND s.revision>1 AND r.stageId IS NULL LIMIT 1`).get()) throw new Error('公式重选输入缺失');
  }
  if (version >= 11) {
    db.prepare('SELECT id,collectionId,assetId,contentFingerprint,revision,contentJson,createdAt FROM batch_formula_asset_ranges LIMIT 1').get();
    for (const name of ['batch_formula_range_owner', 'batch_formula_range_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式可用区间约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_asset_ranges r JOIN batch_formula_collections c ON c.id=r.collectionId
      JOIN batch_assets a ON a.id=r.assetId WHERE c.projectId<>a.projectId OR r.contentFingerprint<>a.contentFingerprint LIMIT 1`).get()) {
      throw new Error('公式可用区间归属或内容不一致');
    }
  }
  if (version >= 10) {
    db.prepare('SELECT id,collectionId,revision,scriptsSessionId,contentJson,createdAt FROM batch_formula_selection_rules LIMIT 1').get();
    for (const name of ['batch_formula_rules_owner', 'batch_formula_rules_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式人工选片约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_selection_rules r LEFT JOIN batch_formula_import_sessions s ON s.id=r.scriptsSessionId
      WHERE r.scriptsSessionId IS NOT NULL AND (s.id IS NULL OR s.collectionId<>r.collectionId OR s.kind<>'scripts' OR s.state<>'confirmed') LIMIT 1`).get()) {
      throw new Error('公式人工选片归属不一致');
    }
  }
  if (version >= 9) {
    db.prepare('SELECT id,requestId,planId,kind,revision,createdAt FROM batch_formula_stages LIMIT 1').get();
    db.prepare('SELECT stageId,resultJson,createdAt FROM batch_formula_selection_results LIMIT 1').get();
    for (const name of ['batch_formula_stage_owner','batch_formula_stage_immutable','batch_formula_selection_immutable','batch_formula_task_owner','batch_formula_task_identity']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式任务约束缺失');
    }
    const taskSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='batch_tasks'").get() as { sql: string };
    if (!taskSql.sql.includes("'formula_stage'")) throw new Error('公式任务类型未启用');
    if (db.prepare(`SELECT 1 FROM batch_formula_stages s JOIN batch_formula_generation_outputs o ON o.planId=s.planId
      WHERE s.requestId<>o.requestId LIMIT 1`).get() || db.prepare(`SELECT 1 FROM batch_tasks t
        LEFT JOIN ${version >= 14 ? 'batch_formula_execution_stages' : 'batch_formula_stages'} s ON s.id=t.targetId LEFT JOIN batch_formula_generation_requests r ON r.id=s.requestId
        WHERE t.workType='formula_stage' AND (t.targetKind<>'formula_stage' OR s.id IS NULL
          OR t.projectId<>r.projectId OR t.batchId IS NOT r.batchId) LIMIT 1`).get()) throw new Error('公式任务归属不一致');
  }
  if (version >= 8) {
    db.prepare('SELECT id,projectId,batchId,collectionId,batchVersionId,settingsId,inputRevision,requestKey,seed,inputJson,createdAt FROM batch_formula_generation_requests LIMIT 1').get();
    db.prepare('SELECT planId,requestId,scriptKey,scriptNumber,copyIndex,slotsJson FROM batch_formula_generation_outputs LIMIT 1').get();
    for (const name of ['batch_formula_generation_owner', 'batch_formula_generation_output_owner', 'batch_formula_generation_immutable', 'batch_formula_generation_output_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式生成请求约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_generation_requests r
      JOIN batch_formula_collections c ON c.id=r.collectionId JOIN batch_formula_settings s ON s.id=r.settingsId
      JOIN batch_production_versions v ON v.id=r.batchVersionId
      WHERE c.projectId<>r.projectId OR c.batchId<>r.batchId OR s.collectionId<>r.collectionId
        OR v.batchId<>r.batchId OR v.planningMode<>'formula' LIMIT 1`).get()
      || db.prepare(`SELECT 1 FROM batch_formula_generation_outputs o
        JOIN batch_formula_generation_requests r ON r.id=o.requestId JOIN batch_output_plans p ON p.id=o.planId
        WHERE p.batchVersionId<>r.batchVersionId LIMIT 1`).get()) throw new Error('公式生成请求归属不一致');
  }
  if (version >= 7) {
    db.prepare('SELECT id,collectionId,revision,scriptsSessionId,contentJson,createdAt FROM batch_formula_settings LIMIT 1').get();
    for (const name of ['batch_formula_settings_owner', 'batch_formula_settings_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式生成设置约束缺失');
    }
    if (db.prepare(`SELECT 1 FROM batch_formula_settings f JOIN batch_formula_import_sessions s ON s.id=f.scriptsSessionId
      WHERE s.collectionId<>f.collectionId OR s.kind<>'scripts' OR s.state<>'confirmed' LIMIT 1`).get()) throw new Error('公式生成设置归属不一致');
  }
  if (version >= 6) {
    db.prepare('SELECT id,collectionId,providerId,providerName,model,promptVersion,inputJson,state,total,succeeded,skipped,errorsJson,message,startedAt,updatedAt FROM batch_formula_material_organize_runs LIMIT 1').get();
  }
  if (version >= 5) {
    db.prepare('SELECT id,collectionId,bindingId,revision,inputFingerprint,sourceJson,contentJson,origin,provenanceJson,createdAt FROM batch_formula_material_profiles LIMIT 1').get();
    for (const name of ['batch_formula_material_profile_owner', 'batch_formula_material_profile_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('素材内容修订约束缺失');
    }
  }
  if (version >= 4) {
    db.prepare('SELECT workbookBytes, draftRevision, extractionJson FROM batch_formula_import_sessions LIMIT 1').get();
  }
  for (const table of ['batch_productions', 'batch_production_versions']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
    if (columns.find(column => column.name === 'planningMode')?.notnull !== 1) throw new Error('剪辑方式字段缺失');
    if (db.prepare(`SELECT 1 FROM ${table} WHERE planningMode NOT IN ('semantic','formula') LIMIT 1`).get()) {
      throw new Error('剪辑方式字段无效');
    }
  }
  for (const trigger of ['batch_formula_mode_immutable', 'batch_formula_version_mode_immutable', 'batch_formula_version_mode_matches']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)) {
      throw new Error('剪辑方式约束缺失');
    }
  }
  if (db.prepare(`SELECT 1 FROM batch_production_versions v JOIN batch_productions b ON b.id=v.batchId
    WHERE v.planningMode <> b.planningMode LIMIT 1`).get()) throw new Error('批次与版本剪辑方式不一致');
  if (version >= 2) {
    db.prepare('SELECT id, projectId, batchId, revision, materialsSessionId, scriptsSessionId FROM batch_formula_collections LIMIT 1').get();
    db.prepare('SELECT id, collectionId, kind, fingerprint, filename, baseRevision, previewJson, state, excludedKeysJson, confirmedRevision FROM batch_formula_import_sessions LIMIT 1').get();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='batch_formula_confirmed_import_immutable'").get()) throw new Error('导入快照约束缺失');
  }
  if (version >= 3) {
    db.prepare('SELECT id, collectionId, assetId, contentFingerprint, sourceName, sourcePath, detectedCode, logicalCode, excludedReason FROM batch_formula_asset_bindings LIMIT 1').get();
    if (db.prepare(`SELECT 1 FROM batch_formula_collections c JOIN batch_productions b ON b.id=c.batchId
      WHERE c.projectId<>b.projectId OR b.planningMode<>'formula' LIMIT 1`).get()) throw new Error('公式集合归属不一致');
    if (db.prepare(`SELECT 1 FROM batch_formula_asset_bindings f JOIN batch_formula_collections c ON c.id=f.collectionId
      JOIN batch_assets a ON a.id=f.assetId WHERE a.projectId<>c.projectId OR a.contentFingerprint<>f.contentFingerprint LIMIT 1`).get()) throw new Error('公式素材归属不一致');
    for (const name of ['batch_formula_collection_owner', 'batch_formula_collection_owner_immutable', 'batch_formula_binding_owner', 'batch_formula_binding_identity_immutable']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)) throw new Error('公式素材约束缺失');
    }
  }
}

/** 不迁移、不读运行库；调度器在能力开关打开时检查已经升级的当前连接。 */
export function validateFormulaExecutionSchema(db: Database.Database): void {
  const actual = (db.prepare('SELECT version FROM batch_formula_schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(row => row.version);
  if (JSON.stringify(actual) !== JSON.stringify(FORMULA_SCHEMA_MIGRATIONS.map(item => item.version))) throw new Error('公式任务结构尚未就绪');
  validateFormulaSchema(db, FORMULA_SCHEMA_MIGRATIONS.at(-1)!.version);
}

export async function ensureFormulaSchemaReady(options: {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<SchemaUpgradeOperationResult> {
  const { db, backupRoot, diskSpaceProbe } = options;
  const now = options.now ?? (() => new Date());
  const targetVersion = FORMULA_SCHEMA_MIGRATIONS.at(-1)!.version;
  const failed = (code: string, message: string): SchemaUpgradeOperationResult => ({
    state: 'compatibility_only', targetVersion, appliedVersions: [], code, message,
  });
  try { validateCurrentBatchSchema(db); } catch {
    return failed('base_batch_unavailable', '基础批量数据未通过检查，暂不能启用实拍公式混剪。');
  }
  let versions: number[];
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='batch_formula_schema_migrations'").get();
    versions = exists ? (db.prepare('SELECT version FROM batch_formula_schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(row => row.version) : [];
    if (versions.some((version, index) => version !== index + 1 || version > targetVersion)) {
      return failed('formula_schema_history_invalid', '实拍公式混剪的升级记录不兼容，普通批量可继续使用。');
    }
  } catch {
    return failed('formula_schema_history_invalid', '无法读取实拍公式混剪的升级记录。');
  }
  if (versions.length === targetVersion) {
    try { validateFormulaSchema(db, targetVersion); } catch {
      return failed('formula_schema_invalid', '实拍公式混剪的数据结构未通过检查。');
    }
    return { state: 'current', appliedVersions: [], targetVersion };
  }
  let backup;
  try {
    backup = await createValidatedSchemaUpgradeBackup({
      db, backupRoot, scope: 'batch-formula', sourceVersions: versions, targetVersion, now: now(), diskSpaceProbe,
    });
  } catch (error) {
    return failed(error instanceof SchemaUpgradeBackupError ? error.code : 'backup_failed',
      '实拍公式混剪的安全备份未完成，普通批量仍可使用。');
  }
  const appliedVersions: number[] = [];
  try {
    for (const migration of FORMULA_SCHEMA_MIGRATIONS.filter(item => !versions.includes(item.version))) {
      db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS batch_formula_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
        if (migration.version === 9) assertFormulaTaskRebuildSafe(db);
        db.exec(migration.sql);
        db.prepare('INSERT INTO batch_formula_schema_migrations VALUES (?, ?)').run(migration.version, now().toISOString());
        validateCurrentBatchSchema(db);
        validateFormulaSchema(db, migration.version);
      }).immediate();
      appliedVersions.push(migration.version);
    }
  } catch {
    // 事务回滚后重新验证基础能力；失败时不可宣称普通批量安全。
    let baseSafe = true;
    try { validateCurrentBatchSchema(db); } catch { baseSafe = false; }
    return {
      ...failed(baseSafe ? 'formula_migration_failed' : 'base_batch_unavailable', baseSafe
        ? '实拍公式混剪升级未完成，普通批量仍可使用。' : '基础批量数据未通过检查，批量功能暂不可用。'),
      appliedVersions, backupDirectory: backup.directory, backupManifest: backup.manifest,
    };
  }
  return { state: 'ready', targetVersion, appliedVersions, backupDirectory: backup.directory, backupManifest: backup.manifest };
}
