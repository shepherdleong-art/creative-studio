import crypto from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { FinalEditError } from './errors.ts';

export const FINAL_EDIT_ANALYZER_VERSION = '2';

export interface VideoAnalysisResult {
  summary: string;
  sellingPoints: string[];
  semanticTags: string[];
  usableRanges: Array<{ startUs: number; endUs: number; qualityScore: number }>;
  qualityIssues: string[];
  coverFrameTimesUs: number[];
  scenes?: Array<{ startUs: number; endUs: number; description: string; labels: string[]; qualityScore: number }>;
}

interface AssetAnalysisDependencies {
  db: Database.Database;
  probeVideo(input: { filePath: string; videoJobId: string }): Promise<{ durationUs: number; width: number; height: number; fps: number }>;
  analyzeVideo(input: { filePath: string; videoJobId: string; shotSetId: string; providerId: string }): Promise<VideoAnalysisResult>;
}

interface AssetAnalysisInput {
  filePath: string;
  videoJobId: string;
  shotSetId: string;
  providerId: string;
  model?: string;
  /** prepare 可复用成功缓存、记录失败并降级；refresh 强制重分析，失败保留旧记录。 */
  mode: 'prepare' | 'refresh';
}

function isVideoAnalysisResult(value: unknown): value is VideoAnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const analysis = value as Partial<VideoAnalysisResult>;
  return typeof analysis.summary === 'string'
    && Array.isArray(analysis.sellingPoints)
    && Array.isArray(analysis.semanticTags)
    && Array.isArray(analysis.usableRanges)
    && analysis.usableRanges.every((range) => Number.isFinite(range?.startUs) && Number.isFinite(range?.endUs) && Number.isFinite(range?.qualityScore) && range.endUs > range.startUs)
    && Array.isArray(analysis.qualityIssues)
    && Array.isArray(analysis.coverFrameTimesUs);
}

function providerModel(db: Database.Database, providerId: string): string {
  try {
    return String((db.prepare(`SELECT COALESCE(NULLIF(model, ''), defaultModel, '') AS model FROM script_providers WHERE id=?`).get(providerId) as { model?: string } | undefined)?.model || '');
  } catch { return ''; } // 保留旧工作区对缺少供应商表的隔离数据集的兼容。
}

/** 调用方先完成素材归属、路径和供应商资格检查；本模块不修改人工标注与剪辑。 */
export async function analyzeFinalEditAsset(deps: AssetAnalysisDependencies, input: AssetAnalysisInput) {
  const { db } = deps;
  const { videoJobId, shotSetId, providerId } = input;
  const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(input.filePath)).digest('hex');
  // 媒体不可读不是 AI 分析降级：探测失败直接抛出，不调用供应商、不覆盖旧记录。
  const media = await deps.probeVideo({ filePath: input.filePath, videoJobId });
  const model = input.model ?? providerModel(db, providerId);
  const cached = input.mode === 'prepare'
    ? db.prepare(`SELECT fileFingerprint, providerId, model, analyzerVersion, status, generatedJson FROM final_edit_asset_analysis WHERE videoJobId=?`).get(videoJobId) as {
      fileFingerprint: string; providerId: string; model: string; analyzerVersion: string; status: string; generatedJson: string;
    } | undefined
    : undefined;
  let cachedGenerated: unknown;
  try { cachedGenerated = cached ? JSON.parse(cached.generatedJson) : null; }
  catch { cachedGenerated = null; }
  try {
    const cacheHit = cached?.fileFingerprint === fingerprint
      && cached.providerId === providerId
      && cached.model === model
      && cached.analyzerVersion === FINAL_EDIT_ANALYZER_VERSION
      && cached.status === 'succeeded'
      && isVideoAnalysisResult(cachedGenerated);
    const analysis = cacheHit
      ? cachedGenerated as VideoAnalysisResult
      : await deps.analyzeVideo({ filePath: input.filePath, videoJobId, shotSetId, providerId });
    if (!isVideoAnalysisResult(analysis)) throw new FinalEditError('analysis_failed', '视频分析结果结构无效');
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO final_edit_asset_analysis
        (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, updatedAt, analyzedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)
      ON CONFLICT(videoJobId) DO UPDATE SET shotSetId=excluded.shotSetId, fileFingerprint=excluded.fileFingerprint,
        providerId=excluded.providerId, model=excluded.model, analyzerVersion=excluded.analyzerVersion, status='succeeded',
        mediaJson=excluded.mediaJson, generatedJson=excluded.generatedJson,
        errorCode=NULL, errorMessage=NULL, analyzedAt=excluded.analyzedAt, updatedAt=excluded.updatedAt
    `).run(videoJobId, shotSetId, fingerprint, providerId, model, FINAL_EDIT_ANALYZER_VERSION, JSON.stringify(media), JSON.stringify(analysis), timestamp, timestamp);
    return { fingerprint, media, analysis, status: 'succeeded' as const, cacheHit };
  } catch (error) {
    if (input.mode === 'refresh') throw error;
    db.prepare(`
      INSERT INTO final_edit_asset_analysis
        (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, errorCode, errorMessage, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, '{}', 'analysis_failed', ?, ?)
      ON CONFLICT(videoJobId) DO UPDATE SET fileFingerprint=excluded.fileFingerprint, providerId=excluded.providerId,
        model=excluded.model, analyzerVersion=excluded.analyzerVersion, status='failed', mediaJson=excluded.mediaJson,
        generatedJson='{}', errorCode='analysis_failed', errorMessage=excluded.errorMessage, updatedAt=excluded.updatedAt
    `).run(videoJobId, shotSetId, fingerprint, providerId, model, FINAL_EDIT_ANALYZER_VERSION, JSON.stringify(media), error instanceof Error ? error.message : String(error), new Date().toISOString());
    const analysis: VideoAnalysisResult = { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [], qualityIssues: ['analysis_failed'], coverFrameTimesUs: [] };
    return { fingerprint, media, analysis, status: 'failed' as const, cacheHit: false };
  }
}
