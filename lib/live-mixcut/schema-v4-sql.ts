/**
 * 实拍混剪 v4：AI 判断结果。
 *
 * 每条成片生成前问一次文本模型：哪段口播和哪行文案意思相近、最搭的是哪段口播、
 * 每行文案相关的非口播素材怎么排。同样的文案和素材直接复用，不再问第二次。
 *
 * 指纹里同时含有提示词版本和模型身份：换了模型或提示词就要重新判断。
 */
export const LIVE_MIXCUT_SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS live_mixcut_formula_judgments (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES live_mixcut_projects(id) ON DELETE CASCADE,
  contentFingerprint TEXT NOT NULL,
  providerId TEXT NOT NULL,
  providerName TEXT NOT NULL,
  model TEXT NOT NULL,
  promptVersion TEXT NOT NULL,
  judgmentJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(projectId, contentFingerprint)
);
`;
