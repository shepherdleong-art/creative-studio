/**
 * 实拍混剪 v5：新规矩的生产链。
 *
 * 新批次按「选片 → 识别原声 → AI 判断 → 定声音 → 配音」往下走，排在旧时间轴之前；
 * 10-26 的旧批次没有 rulesVersion 之外的任何变化，照旧读旧表、旧执行链。
 *
 * - generation_requests 追加 rulesVersion，旧记录默认 formula-generation/1。
 * - 新增判断、定声音和定声音之后的配音三组阶段表。
 * - 重建成片阶段视图，让任务调度和执行器按同一个视图找到新阶段。
 */
export const LIVE_MIXCUT_SCHEMA_V5_SQL = `
ALTER TABLE live_mixcut_formula_generation_requests
  ADD COLUMN rulesVersion TEXT NOT NULL DEFAULT 'formula-generation/1';

CREATE TABLE IF NOT EXISTS live_mixcut_formula_judgment_stages (
  id TEXT PRIMARY KEY,
  selectionStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  createdAt TEXT NOT NULL,
  UNIQUE(selectionStageId, revision)
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_judgment_results (
  stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_judgment_stages(id) ON DELETE RESTRICT,
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_voice_stages (
  id TEXT PRIMARY KEY,
  selectionStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
  judgmentStageId TEXT NOT NULL REFERENCES live_mixcut_formula_judgment_stages(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  createdAt TEXT NOT NULL,
  UNIQUE(selectionStageId, revision)
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_voice_results (
  stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_voice_stages(id) ON DELETE RESTRICT,
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_voice_narration_stages (
  id TEXT PRIMARY KEY,
  voiceStageId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_formula_voice_stages(id) ON DELETE RESTRICT,
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_voice_narration_results (
  stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_voice_narration_stages(id) ON DELETE RESTRICT,
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_judgment_stage_immutable BEFORE UPDATE ON live_mixcut_formula_judgment_stages
BEGIN SELECT RAISE(ABORT, 'formula judgment stage is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_voice_stage_immutable BEFORE UPDATE ON live_mixcut_formula_voice_stages
BEGIN SELECT RAISE(ABORT, 'formula voice stage is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_voice_narration_stage_immutable BEFORE UPDATE ON live_mixcut_formula_voice_narration_stages
BEGIN SELECT RAISE(ABORT, 'formula voice narration stage is immutable'); END;

DROP VIEW IF EXISTS live_mixcut_formula_execution_stages;
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
    JOIN live_mixcut_formula_audio_mapping_stages a ON a.id=t.audioMappingStageId JOIN live_mixcut_formula_stages s ON s.id=a.selectionStageId
  UNION ALL
  SELECT j.id,s.requestId,s.planId,'judgment',j.revision,s.id,NULL
    FROM live_mixcut_formula_judgment_stages j JOIN live_mixcut_formula_stages s ON s.id=j.selectionStageId
  UNION ALL
  SELECT v.id,s.requestId,s.planId,'voice',v.revision,s.id,NULL
    FROM live_mixcut_formula_voice_stages v JOIN live_mixcut_formula_stages s ON s.id=v.selectionStageId
  UNION ALL
  SELECT n.id,s.requestId,s.planId,'voice_narration',v.revision,s.id,NULL
    FROM live_mixcut_formula_voice_narration_stages n JOIN live_mixcut_formula_voice_stages v ON v.id=n.voiceStageId
    JOIN live_mixcut_formula_stages s ON s.id=v.selectionStageId;
`;
