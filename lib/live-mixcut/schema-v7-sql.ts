/**
 * 实拍混剪 v7：新规矩成片的人工素材核验记录。
 *
 * v1 的人工素材表把 outputVersionId 外键和归属触发器都绑在旧时间轴的表上，
 * 新规矩的成片不写那张表，人工换片/插片会被外键和触发器挡住。
 * 这里给新规矩的成片单独一张同构的表：外键指向新表的成片登记，归属走排时间链路。
 * 旧表一行不动，旧成片的人工素材记录照旧。
 */
export const LIVE_MIXCUT_SCHEMA_V7_SQL = `
CREATE TABLE IF NOT EXISTS live_mixcut_formula_schedule_manual_media (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE RESTRICT,
  outputVersionId TEXT NOT NULL REFERENCES live_mixcut_formula_schedule_output_versions(outputVersionId) ON DELETE RESTRICT,
  assetId TEXT NOT NULL REFERENCES live_mixcut_assets(id) ON DELETE RESTRICT,
  requestKey TEXT NOT NULL,
  inputJson TEXT NOT NULL CHECK(json_valid(inputJson)),
  proofJson TEXT NOT NULL CHECK(json_valid(proofJson)),
  createdAt TEXT NOT NULL,
  UNIQUE(outputVersionId,requestKey)
);

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_manual_media_owner BEFORE INSERT ON live_mixcut_formula_schedule_manual_media
WHEN NOT EXISTS (
  SELECT 1 FROM live_mixcut_formula_schedule_output_versions f
  JOIN live_mixcut_formula_schedule_stages s ON s.id=f.scheduleStageId
  JOIN live_mixcut_formula_stages sel ON sel.id=s.selectionStageId
  JOIN live_mixcut_formula_generation_requests g ON g.id=sel.requestId
  JOIN live_mixcut_assets a ON a.id=NEW.assetId AND a.projectId=g.projectId
  WHERE f.outputVersionId=NEW.outputVersionId AND g.projectId=NEW.projectId)
BEGIN SELECT RAISE(ABORT, 'formula schedule manual media owner mismatch'); END;

CREATE TRIGGER IF NOT EXISTS live_mixcut_formula_schedule_manual_media_immutable BEFORE UPDATE ON live_mixcut_formula_schedule_manual_media
BEGIN SELECT RAISE(ABORT, 'formula schedule manual media immutable'); END;
`;
