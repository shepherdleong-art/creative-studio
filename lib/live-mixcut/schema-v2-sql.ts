/**
 * 实拍混剪 v2：原声转写（ASR）供应商配置。
 *
 * 只有一行内置记录（火山「大模型录音文件极速版识别」）：
 *   - 用户可以在设置页改 baseUrl、填 apiKey、启用/停用；
 *   - apiKey 留空时回退到环境变量 CREATIVE_STUDIO_VOLC_ASR_API_KEY，
 *     保证老的 .env.local 配置继续生效，不用强迫任何人改习惯；
 *   - keyEnv 记录回退用的环境变量名，便于界面提示「当前用的是环境变量」。
 *
 * 这张表只描述「用哪个服务」，不存任务结果；转写结果归 live_mixcut_formula_speech_results。
 */
export const LIVE_MIXCUT_SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS live_mixcut_asr_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  baseUrl TEXT NOT NULL,
  apiKey TEXT NOT NULL DEFAULT '',
  keyEnv TEXT NOT NULL DEFAULT '',
  resourceId TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  isBuiltin INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

INSERT OR IGNORE INTO live_mixcut_asr_providers
  (id, name, type, baseUrl, apiKey, keyEnv, resourceId, model, enabled, isBuiltin, createdAt, updatedAt)
VALUES
  ('volc-flash-asr', '火山 大模型录音文件极速版识别', 'volc-flash-asr',
   'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
   '', 'CREATIVE_STUDIO_VOLC_ASR_API_KEY', 'volc.seedasr.auc', 'bigmodel',
   1, 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
`;
