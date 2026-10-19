/** 痛点内容机会解析和请求的资源上限。 */
export const PAIN_PLANNING_CANDIDATE_LIMIT = 12;
export const PAIN_FACTS_PER_ROLE_LIMIT = 4;
export const PAIN_TEXT_FIELD_LIMIT = 400;
export const PAIN_PLANNING_MAX_TOKENS = 8000;

export const SCRIPT_TITLE_REPAIR_MAX_TOKENS = 1200;

export interface ScriptStudioLimits {
  maxImageWidth: number;
  baseTileHeight: number;
  verticalOverlapRatio: number;
  jpegQuality: number;
  maxImagesPerRequest: number;
  sourcePixelLimit: number;
  decodeBufferLimitBytes: number;
  maxTokensPerPage: number;
  reprobeConcurrency: number;
  reprobeBatchSize: number;
  reprobeMaxImagesPerBatch: number;
  extractTileBatchSize: number;
  extractConcurrency: number;
  extractRequestTimeoutMs: number;
  extractMaxAttempts: number;
  organizeMaxAttempts: number;
  organizeMaxTokens: number;
  organizeRequestTimeoutMs: number;
  generationConcurrency: number;
  titleRepairMaxAttempts: number;
  titleHistoryDays: number;
  titleHistoryMaxRevisions: number;
  /** 目录导入 .xlsx 最大字节数（策略库/模板库共用）。 */
  maxCatalogImportBytes: number;
  /** 每条方案从首稿到保存的应用层文本 completeJson 调用上限（正文生成/重试/修复/审核/标题修复共用）。 */
  scriptTextRequestsPerProposal: number;
  /** 单任务卖点提炼阶段的应用层模型调用上限（独立于脚本文本预算，分别记录）。 */
  distillMaxRequestsPerTask: number;
  /** 单任务受众画像分析调用上限（独立阶段预算，默认 2：一次主调用 + 一次重试）。 */
  planAnalysisMaxRequestsPerTask: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRatio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 && value < 1 ? value : fallback;
}

export function getScriptStudioLimits(): ScriptStudioLimits {
  return {
    maxImageWidth: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_MAX_IMAGE_WIDTH', 1024),
    baseTileHeight: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_BASE_TILE_HEIGHT', 1024),
    verticalOverlapRatio: readRatio('CREATIVE_STUDIO_SCRIPT_STUDIO_VERTICAL_OVERLAP', 0.12),
    jpegQuality: Math.min(100, Math.max(1, readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_JPEG_QUALITY', 88))),
    maxImagesPerRequest: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_MAX_IMAGES_PER_REQUEST', 50),
    sourcePixelLimit: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_SOURCE_PIXEL_LIMIT', 60_000_000),
    decodeBufferLimitBytes: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_DECODE_BUFFER_LIMIT_BYTES', 150 * 1024 * 1024),
    maxTokensPerPage: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_MAX_TOKENS_PER_PAGE', 8000),
    reprobeConcurrency: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_REPROBE_CONCURRENCY', 4),
    reprobeBatchSize: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_REPROBE_BATCH_SIZE', 4),
    reprobeMaxImagesPerBatch: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_REPROBE_MAX_IMAGES_PER_BATCH', 6),
    // 公司 Luna 实测 14 张连续命中 120s 超时，6 张约 16.6s；小批并行比大批等待/原样重试更稳。
    extractTileBatchSize: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_TILE_BATCH_SIZE', 6),
    extractConcurrency: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_CONCURRENCY', 4),
    // 75s/3 次的提前重试真机使提取从 144s 回退到 175s；保留供应商 120s 阈值与一次重试。
    extractRequestTimeoutMs: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_REQUEST_TIMEOUT_MS', 120_000),
    extractMaxAttempts: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_EXTRACT_MAX_ATTEMPTS', 2),
    organizeMaxAttempts: Math.min(2, readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_ORGANIZE_MAX_ATTEMPTS', 2)),
    organizeMaxTokens: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_ORGANIZE_MAX_TOKENS', 8000),
    organizeRequestTimeoutMs: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_ORGANIZE_TIMEOUT_MS', 120_000),
    generationConcurrency: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_GENERATION_CONCURRENCY', 2),
    titleRepairMaxAttempts: 2,
    titleHistoryDays: 30,
    titleHistoryMaxRevisions: 100,
    maxCatalogImportBytes: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_MAX_CATALOG_IMPORT_BYTES', 32 * 1024 * 1024),
    // 请求预算（方案 §2.2）：每条方案 8 次文本 completeJson；标题修复仍最多 2 次（单独闸门）。
    // 任务总额 = requestedCount × 每方案上限；视觉提取/证据复核/提炼阶段使用各自独立预算，不占此额度。
    scriptTextRequestsPerProposal: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_TEXT_REQUESTS_PER_PROPOSAL', 8),
    distillMaxRequestsPerTask: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_DISTILL_REQUESTS_PER_TASK', 4),
    planAnalysisMaxRequestsPerTask: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_PLAN_ANALYSIS_REQUESTS_PER_TASK', 2),
  };
}

export function logLimitHit(name: string, actual: number, threshold: number): void {
  console.warn(`[script-studio:limit] ${name} hit: actual=${actual}, threshold=${threshold}`);
}
