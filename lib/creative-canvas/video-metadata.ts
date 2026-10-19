import type Database from 'better-sqlite3';
import { SEEDANCE_25 } from '../video-providers/seedance-contract.ts';

export type CanvasGenerationStage = 'direct' | 'draft' | 'final-from-draft';
export interface CanvasVideoMetadata {
  stage: CanvasGenerationStage;
  draftConfirmed?: boolean;
  remoteCreatedAt: string | null;
  expiresAt: string | null;
  model: string;
  resolution?: string;
  outputFormat?: string;
  usage?: Record<string, number>;
  draftAssetId?: string;
  tailAssetId?: string;
  referenceVideoDurationSec?: number;
}
export function generationStage(parameters: Record<string, unknown>): CanvasGenerationStage {
  return parameters.generationStage === 'draft' || parameters.generationStage === 'final-from-draft' ? parameters.generationStage : 'direct';
}
export function sanitizeVideoMetadata(raw: unknown, parameters: Record<string, unknown>, model: string): CanvasVideoMetadata {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const stage = generationStage(parameters);
  const seconds = Number(value.created_at);
  const timestamp = Number.isFinite(seconds) && seconds > 0 && seconds < 100_000_000_000 ? seconds * 1000 : NaN;
  const usage = value.usage && typeof value.usage === 'object'
    ? Object.fromEntries(Object.entries(value.usage).filter(([key, number]) => /^[a-z_]+$/.test(key) && typeof number === 'number' && Number.isFinite(number) && number >= 0)) : {};
  return {
    stage, model,
    ...(stage === 'draft' ? { draftConfirmed: value.draft === true && value.model === model } : {}),
    remoteCreatedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    expiresAt: stage === 'draft' && Number.isFinite(timestamp) ? new Date(timestamp + 7 * 86400_000).toISOString() : null,
    resolution: String(value.resolution ?? parameters.resolution ?? '1080p'),
    outputFormat: String(value.output_format ?? parameters.outputFormat ?? 'mp4'),
    usage: usage as Record<string, number>,
    ...(stage === 'final-from-draft' ? { draftAssetId: String(parameters.draftAssetId ?? '') } : {}),
  };
}
export function recordCanvasVideoMetadata(db: Database.Database, taskId: string, metadata: CanvasVideoMetadata): void {
  db.prepare('INSERT INTO creative_canvas_video_metadata (taskId, metadataJson) VALUES (?, ?) ON CONFLICT(taskId) DO UPDATE SET metadataJson = excluded.metadataJson')
    .run(taskId, JSON.stringify(metadata));
}
export interface CanvasDraftSource {
  assetId: string; taskId: string; providerTaskId: string; providerIdentity: string; model: string;
  remoteCreatedAt: string; expiresAt: string; expired: boolean;
  generationMode: string; prompt: string; parameters: Record<string, string | number | boolean>;
}
/** All source identity comes from committed task rows, never a client supplied remote ID/time. */
export function requireCanvasDraftSource(db: Database.Database, canvasId: string, assetId: string, now = Date.now()): CanvasDraftSource {
  const row = db.prepare(`SELECT a.id AS assetId, t.id AS taskId, t.providerTaskId, t.providerSnapshot, t.parameterSnapshot, m.metadataJson
    FROM creative_canvas_assets a JOIN creative_canvas_tasks t ON t.outputAssetId = a.id
    JOIN creative_canvas_video_metadata m ON m.taskId = t.id
    WHERE a.id = ? AND a.canvasId = ? AND a.ready = 1 AND t.phase = 'succeeded'`).get(assetId, canvasId) as
    { assetId: string; taskId: string; providerTaskId: string; providerSnapshot: string; parameterSnapshot: string; metadataJson: string } | undefined;
  if (!row) throw new Error('样片来源不可用，请重新选择同一画布内已完成的样片');
  const metadata = JSON.parse(row.metadataJson) as CanvasVideoMetadata;
  const provider = JSON.parse(row.providerSnapshot);
  const snapshot = JSON.parse(row.parameterSnapshot);
  if (metadata.stage !== 'draft' || metadata.draftConfirmed !== true || metadata.model !== SEEDANCE_25 || provider.modelAlias !== SEEDANCE_25 || !row.providerTaskId || !metadata.remoteCreatedAt || !metadata.expiresAt) {
    throw new Error('来源不是可转正式的样片，或缺少供应商创建时间；请重新生成样片');
  }
  return { assetId, taskId: row.taskId, providerTaskId: row.providerTaskId, providerIdentity: provider.providerIdentity,
    model: metadata.model, remoteCreatedAt: metadata.remoteCreatedAt, expiresAt: metadata.expiresAt,
    expired: Date.parse(metadata.expiresAt) <= now, generationMode: snapshot.generationMode, prompt: String(snapshot.prompt ?? ''), parameters: snapshot.parameters ?? {} };
}
export function assertDraftSourceMatches(source: CanvasDraftSource, model: string, providerIdentity: string): void {
  if (source.expired) throw new Error('样片已超过 7 天有效期，请重新生成样片；本地视频仍可下载');
  if (source.model !== model || source.providerIdentity !== providerIdentity) throw new Error('样片只能在原模型和原渠道转正式；请切回来源模型或重新生成样片');
}

export function canvasVideoMetadataForAsset(db: Database.Database, assetId: string): CanvasVideoMetadata | null {
  const row = db.prepare(`SELECT m.metadataJson FROM creative_canvas_tasks t JOIN creative_canvas_video_metadata m ON m.taskId = t.id WHERE t.outputAssetId = ?`).get(assetId) as { metadataJson: string } | undefined;
  return row ? JSON.parse(row.metadataJson) as CanvasVideoMetadata : null;
}
