/**
 * 实拍混剪 v6：新规矩的「排时间」与它往下的成片登记。
 *
 * 新批次在配音之后用排片计算排出画面、声音、字幕和审片标记，结果存自己的表；
 * 成片版本、执行检查也各有新表，不和旧时间轴的表混用。旧批次一行不碰。
 *
 * - 新增排时间阶段/结果、成片版本、执行检查/结果五张表。
 * - 重建成片阶段视图：加上 'schedule'，执行检查同时列旧链和新规矩两种。
 * - 新增两条只读血缘视图，让音乐预览、包装重分配、执行检查和渲染都用同一份查法。
 */
export const LIVE_MIXCUT_SCHEMA_V6_SQL = `
CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_stages (
  id TEXT PRIMARY KEY,
  selectionStageId TEXT NOT NULL REFERENCES live_mixcut_formula_stages(id) ON DELETE RESTRICT,
  voiceStageId TEXT NOT NULL REFERENCES live_mixcut_formula_voice_stages(id) ON DELETE RESTRICT,
  narrationStageId TEXT REFERENCES live_mixcut_formula_voice_narration_stages(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  createdAt TEXT NOT NULL,
  UNIQUE(selectionStageId, revision)
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_results (
  stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_schedule_stages(id) ON DELETE RESTRICT,
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_output_versions (
  scheduleStageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_schedule_stages(id) ON DELETE RESTRICT,
  outputVersionId TEXT NOT NULL UNIQUE REFERENCES live_mixcut_output_versions(id) ON DELETE RESTRICT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_execution_checks (
  id TEXT PRIMARY KEY,
  outputVersionId TEXT NOT NULL REFERENCES live_mixcut_formula_schedule_output_versions(outputVersionId) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0),
  inputKey TEXT NOT NULL,
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  createdAt TEXT NOT NULL,
  UNIQUE(outputVersionId,inputKey), UNIQUE(outputVersionId,revision)
);

CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_execution_results (
  stageId TEXT PRIMARY KEY REFERENCES live_mixcut_formula_schedule_execution_checks(id) ON DELETE RESTRICT,
  resultJson TEXT NOT NULL CHECK(json_valid(resultJson)),
  createdAt TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_owner BEFORE INSERT ON live_mixcut_formula_schedule_stages
WHEN NOT EXISTS (
  SELECT 1 FROM live_mixcut_formula_voice_stages v
  JOIN live_mixcut_formula_stages sel ON sel.id=v.selectionStageId
  WHERE v.id=NEW.voiceStageId AND v.selectionStageId=NEW.selectionStageId
    AND (NEW.narrationStageId IS NULL OR EXISTS (
      SELECT 1 FROM live_mixcut_formula_voice_narration_stages n
      WHERE n.id=NEW.narrationStageId AND n.voiceStageId=v.id)))
BEGIN SELECT RAISE(ABORT, 'formula schedule owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_input_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_stages
BEGIN SELECT RAISE(ABORT, 'formula schedule stage is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_result_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_results
BEGIN SELECT RAISE(ABORT, 'formula schedule result is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_output_owner BEFORE INSERT ON live_mixcut_formula_schedule_output_versions
WHEN NOT EXISTS (
  SELECT 1 FROM live_mixcut_formula_schedule_results x
  JOIN live_mixcut_formula_schedule_stages s ON s.id=x.stageId
  JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
  JOIN live_mixcut_output_versions v ON v.planId=sel.planId
  WHERE s.id=NEW.scheduleStageId AND v.id=NEW.outputVersionId
    AND json_extract(x.resultJson,'$.status')='planned'
    AND json_extract(v.arrangementJson,'$.formula.timelineStageId')=s.id
    AND json_extract(v.arrangementJson,'$.formula.selectionStageId')=s.selectionStageId
    AND json_extract(v.arrangementJson,'$.formula.version')=1
    AND json_extract(v.arrangementJson,'$.audioPlan.version')=1)
BEGIN SELECT RAISE(ABORT, 'formula schedule output owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_output_link_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_output_versions
BEGIN SELECT RAISE(ABORT, 'formula schedule output link is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_execution_check_owner BEFORE INSERT ON live_mixcut_formula_schedule_execution_checks
WHEN NOT EXISTS (
  SELECT 1 FROM live_mixcut_formula_schedule_output_versions f
  JOIN live_mixcut_output_versions o ON o.id=f.outputVersionId
  WHERE f.outputVersionId=NEW.outputVersionId
    AND json_extract(NEW.inputJson,'$.formula')=json_extract(o.arrangementJson,'$.formula'))
BEGIN SELECT RAISE(ABORT, 'formula schedule execution check owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_execution_check_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_execution_checks
BEGIN SELECT RAISE(ABORT, 'formula schedule execution check is immutable'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_execution_result_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_execution_results
BEGIN SELECT RAISE(ABORT, 'formula schedule execution result is immutable'); END;

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
    JOIN live_mixcut_formula_stages s ON s.id=v.selectionStageId
  UNION ALL
  SELECT sc.id,s.requestId,s.planId,'schedule',sc.revision,s.id,NULL
    FROM live_mixcut_formula_schedule_stages sc JOIN live_mixcut_formula_stages s ON s.id=sc.selectionStageId
  UNION ALL
  SELECT e.id,s.requestId,s.planId,'execution',e.revision,s.id,NULL
    FROM live_mixcut_formula_schedule_execution_checks e
    JOIN live_mixcut_formula_schedule_output_versions f ON f.outputVersionId=e.outputVersionId
    JOIN live_mixcut_formula_schedule_stages sc ON sc.id=f.scheduleStageId
    JOIN live_mixcut_formula_stages s ON s.id=sc.selectionStageId;

DROP VIEW IF EXISTS live_mixcut_formula_output_lineage;
CREATE VIEW live_mixcut_formula_output_lineage AS
  SELECT f.outputVersionId,f.timelineStageId AS sourceStageId,'timeline' AS sourceKind,s.planId,s.selectionStageId,s.requestId,
    t.narrationStageId AS narrationStageId
  FROM live_mixcut_formula_output_versions f
  JOIN live_mixcut_formula_execution_stages s ON s.id=f.timelineStageId
  JOIN live_mixcut_formula_timeline_stages t ON t.id=f.timelineStageId
  UNION ALL
  SELECT f.outputVersionId,f.scheduleStageId,'schedule',s2.planId,s.selectionStageId,s2.requestId,s.narrationStageId
  FROM live_mixcut_formula_schedule_output_versions f
  JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
  JOIN live_mixcut_formula_stages s2 ON s2.id=s.selectionStageId;

DROP VIEW IF EXISTS live_mixcut_formula_execution_lineage;
CREATE VIEW live_mixcut_formula_execution_lineage AS
  SELECT e.id,e.outputVersionId,e.inputKey,e.revision,s.planId,s.selectionStageId,s.requestId,'timeline' AS sourceKind
  FROM live_mixcut_formula_execution_checks e JOIN live_mixcut_formula_execution_stages s ON s.id=e.id
  UNION ALL
  SELECT e.id,e.outputVersionId,e.inputKey,e.revision,s2.planId,s.selectionStageId,s2.requestId,'schedule'
  FROM live_mixcut_formula_schedule_execution_checks e
  JOIN live_mixcut_formula_schedule_output_versions f ON f.outputVersionId=e.outputVersionId
  JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
  JOIN live_mixcut_formula_stages s2 ON s2.id=s.selectionStageId;
`;
