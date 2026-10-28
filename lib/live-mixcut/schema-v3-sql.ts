/**
 * 实拍混剪 v3：分析画面结果。
 *
 * 一条记录对应「一段素材的内容」，按内容指纹存在项目下：
 *   - 同一段素材换批次不再重复分析，也不再重复花模型费；
 *   - 文件内容变了，指纹就变了，会当成新素材重新分析；
 *   - 有效片段、画面描述都留在这里，供 AI 判断、排时间使用。
 *
 * 只记画面分析。口播镜头的有效片段看原声说话起止，不在这张表里。
 */
export const LIVE_MIXCUT_SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS live_mixcut_formula_material_analysis (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
  contentFingerprint TEXT NOT NULL,
  durationUs INTEGER NOT NULL,
  usableInUs INTEGER NOT NULL,
  usableOutUs INTEGER NOT NULL,
  description TEXT NOT NULL,
  providerId TEXT NOT NULL,
  providerName TEXT NOT NULL,
  model TEXT NOT NULL,
  analysisJson TEXT NOT NULL,
  analyzedAt TEXT NOT NULL,
  UNIQUE(projectId, contentFingerprint)
);
`;
