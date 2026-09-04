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
  generationConcurrency: number;
  /** 目录导入 .xlsx 最大字节数（策略库/模板库共用）。 */
  maxCatalogImportBytes: number;
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
    generationConcurrency: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_GENERATION_CONCURRENCY', 2),
    maxCatalogImportBytes: readPositiveInt('CREATIVE_STUDIO_SCRIPT_STUDIO_MAX_CATALOG_IMPORT_BYTES', 32 * 1024 * 1024),
  };
}

export function logLimitHit(name: string, actual: number, threshold: number): void {
  console.warn(`[script-studio:limit] ${name} hit: actual=${actual}, threshold=${threshold}`);
}
