import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.ts';
import { snapCompanyVideoAspectRatio } from './company-gateway-size.ts';
import { resolveTemplateOpeningCode } from './media-core/production-code-reader.ts';
import { getVideoProviderConfigState } from './video-auth.ts';
import { parseVideoDuration, videoDurationError } from './video-duration.ts';
import { normalizeVideoMultiShotForStorage } from './video-multi-shot.ts';
import { countVideoJobsForShot, planVideoJobDisplayName } from './video-output-filenames.ts';
import { validateVideoReferenceRequest, videoReferenceCapability, type VideoReferenceKind } from './video-reference-contract.ts';
import { validateVideoTailFrameAsset } from './video-tail-frame.ts';
import { readVideoSourceReference } from './video-source-reference.ts';

export type VideoJobGenerationMode = 'image-to-video' | 'reference-to-video';

export interface VideoJobCreationItem {
  prompt: string;
  templateId: string | null;
  providerId: string;
  durationSec: number;
  tailImageId: string | null;
  multiShot: unknown;
  generationMode: VideoJobGenerationMode;
  referenceAssetIds: string[];
  aspectRatio: string | null;
  resolution: string | null;
}

export type VideoJobCreationItemParse =
  | { ok: true; item: VideoJobCreationItem }
  | { ok: false; error: string };

export function parseVideoJobCreationItem(value: unknown): VideoJobCreationItemParse {
  const body = (value ?? {}) as Record<string, unknown>;
  const generationMode = body.generationMode ?? 'image-to-video';
  if (generationMode !== 'image-to-video' && generationMode !== 'reference-to-video') {
    return { ok: false, error: 'generationMode 必须是 image-to-video 或 reference-to-video' };
  }
  const rawReferenceIds = body.referenceAssetIds ?? [];
  if (!Array.isArray(rawReferenceIds) || rawReferenceIds.some((id) => typeof id !== 'string' || !id.trim())) {
    return { ok: false, error: 'referenceAssetIds 必须是非空字符串数组' };
  }
  return {
    ok: true,
    item: {
      prompt: typeof body.prompt === 'string' ? body.prompt.trim() : '',
      templateId: typeof body.templateId === 'string' && body.templateId ? body.templateId : null,
      providerId: typeof body.providerId === 'string' ? body.providerId : '',
      durationSec: parseVideoDuration(body.durationSec),
      tailImageId: typeof body.tailImageId === 'string' && body.tailImageId.trim() ? body.tailImageId.trim() : null,
      multiShot: body.multiShot,
      generationMode,
      referenceAssetIds: rawReferenceIds.map((id) => id.trim()),
      aspectRatio: optionalString(body.aspectRatio),
      resolution: optionalString(body.resolution),
    },
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

interface VideoProviderRow {
  id: string;
  name: string;
  type: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  defaultModel: string;
  baseUrl: string;
  apiKey: string;
  accessKey: string;
  secretKey: string;
}

interface ReferenceAssetRow {
  id: string;
  kind: VideoReferenceKind;
  path: string;
  mimeType: string;
  byteSize: number;
  durationSec: number | null;
}

export type VideoJobCreationResult =
  | { ok: true; videoJobIds: string[] }
  | { ok: false; status: number; error: string };

export async function createVideoJobsForShot(input: {
  shotSetId: string;
  shotId: string;
  items: VideoJobCreationItem[];
  batch?: boolean;
  db?: Database.Database;
}): Promise<VideoJobCreationResult> {
  const db = input.db ?? getDb();
  const { shotSetId, shotId, items } = input;
  const itemError = (index: number, error: string) => input.batch ? `第 ${index + 1} 条运镜：${error}` : error;

  const shot = db.prepare(`SELECT id, latestGeneratedImageId, sourceImageId FROM shots WHERE id = ? AND shotSetId = ?`)
    .get(shotId, shotSetId) as { id: string; latestGeneratedImageId: string | null; sourceImageId: string } | undefined;
  if (!shot) return { ok: false, status: 404, error: 'Shot not found in this shot set' };

  const providerCache = new Map<string, VideoProviderRow & { model: string }>();
  for (const providerId of [...new Set(items.map((item) => item.providerId))]) {
    const provider = db.prepare(`SELECT * FROM video_providers WHERE id = ? AND enabled = 1`).get(providerId) as VideoProviderRow | undefined;
    if (!provider) {
      return { ok: false, status: 400, error: input.batch ? `视频供应商 ${providerId} 未找到或已禁用` : 'Video provider not found or disabled' };
    }
    const config = getVideoProviderConfigState(provider);
    if (!config.configured) {
      return { ok: false, status: 400, error: `视频供应商 ${provider.name} 未配置完整：${config.missing.join(', ')}` };
    }
    providerCache.set(providerId, { ...provider, model: provider.defaultModel.trim() });
  }
  for (const [index, item] of items.entries()) {
    const provider = providerCache.get(item.providerId)!;
    const durationError = videoDurationError(provider.type, provider.model, item.durationSec);
    if (durationError) return { ok: false, status: 400, error: itemError(index, durationError) };
  }

  const shotSet = db.prepare(`SELECT projectId FROM shot_sets WHERE id = ?`).get(shotSetId) as { projectId: string } | undefined;
  if (!shotSet) return { ok: false, status: 404, error: 'Shot set not found' };
  const sourceImageId = shot.latestGeneratedImageId || shot.sourceImageId;
  let sourceReference: Awaited<ReturnType<typeof readVideoSourceReference>> | null = null;
  if (items.some((item) => item.generationMode === 'reference-to-video' && item.referenceAssetIds.length === 0)) {
    try { sourceReference = await readVideoSourceReference(db, sourceImageId, shotSet.projectId); }
    catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
  }

  let sourceDimensions: { width: number; height: number } | null = null;
  // 只有参考模式在未显式指定比例时才需要按分镜来源图吸附；
  // 读取失败不阻断创建，改用 16:9 或模型比例表首项兜底。
  if (items.some((item) => item.generationMode === 'reference-to-video' && !item.aspectRatio)) {
    const source = db.prepare(`
      SELECT originalWidth, originalHeight, originalPath, processedPath, path FROM image_assets WHERE id = ?
    `).get(sourceImageId) as {
      originalWidth: number | null;
      originalHeight: number | null;
      originalPath: string | null;
      processedPath: string | null;
      path: string;
    } | undefined;
    if (source?.originalWidth && source.originalWidth > 0 && source.originalHeight && source.originalHeight > 0) {
      sourceDimensions = { width: source.originalWidth, height: source.originalHeight };
    } else if (source) {
      try {
        const metadata = await sharp(source.originalPath || source.processedPath || source.path).metadata();
        if (metadata.width && metadata.height) sourceDimensions = { width: metadata.width, height: metadata.height };
      } catch {
        sourceDimensions = null;
      }
    }
  }

  const prepared = items.map((item, index) => {
    const provider = providerCache.get(item.providerId)!;
    if (item.generationMode === 'image-to-video') {
      if (item.referenceAssetIds.length > 0) return { error: itemError(index, '首尾帧模式不得携带全能参考素材') };
      return { item, provider, aspectRatio: null, resolution: null };
    }
    if (item.tailImageId) return { error: itemError(index, '全能参考模式不能携带尾帧图') };
    const capability = videoReferenceCapability(provider.type, provider.model);
    if (!capability.supported) return { error: itemError(index, `模型 ${provider.model} 不支持全能参考`) };
    const specificRatios = capability.aspectRatios.filter((ratio) => ratio !== 'adaptive');
    let aspectRatio: string | null = item.aspectRatio;
    if (aspectRatio) {
      if (!capability.aspectRatios.includes(aspectRatio)) {
        return { error: itemError(index, `输出比例 ${aspectRatio} 不受支持`) };
      }
    } else if (sourceDimensions) {
      aspectRatio = snapCompanyVideoAspectRatio(sourceDimensions.width, sourceDimensions.height, { tiers: [], ratios: [...specificRatios] });
    } else {
      // 来源图尺寸读不到时按 16:9 兜底（模型不支持则取比例表首项），绝不阻断创建。
      aspectRatio = capability.aspectRatios.includes('16:9') ? '16:9' : (specificRatios[0] ?? null);
    }
    if (!aspectRatio) return { error: itemError(index, '模型没有可用的非自适应输出比例') };
    const resolution = item.resolution ?? capability.defaultResolution;
    if (item.resolution && !capability.resolutions.includes(item.resolution)) {
      return { error: itemError(index, `输出清晰度 ${item.resolution} 不受支持`) };
    }
    return { item, provider, aspectRatio, resolution };
  });
  const preparationError = prepared.find((entry) => 'error' in entry);
  if (preparationError && 'error' in preparationError) return { ok: false, status: 400, error: preparationError.error! };

  const videoJobIds: string[] = [];
  const createResult = db.transaction(() => {
    const referencesByItem: ReferenceAssetRow[][] = [];
    for (const [index, entry] of prepared.entries()) {
      if ('error' in entry) return { ok: false as const, error: entry.error! };
      const { item, provider, aspectRatio, resolution } = entry;
      if (item.generationMode === 'image-to-video') {
        const tail = validateVideoTailFrameAsset({
          db,
          tailImageId: item.tailImageId,
          projectId: shotSet.projectId,
          providerType: provider.type,
          model: provider.model,
        });
        if (!tail.ok) return { ok: false as const, error: tail.error };
        referencesByItem.push([]);
        continue;
      }
      if (new Set(item.referenceAssetIds).size !== item.referenceAssetIds.length) {
        return { ok: false as const, error: itemError(index, '全能参考素材不能重复') };
      }
      const references = item.referenceAssetIds.map((assetId) => {
        const asset = db.prepare(`
          SELECT id, kind, path, mimeType, byteSize, durationSec
          FROM video_reference_assets WHERE id = ? AND projectId = ?
        `).get(assetId, shotSet.projectId) as ReferenceAssetRow | undefined;
        if (!asset) throw new VideoReferenceCreationError(itemError(index, `参考素材 ${assetId} 不存在或不属于当前项目`));
        return asset;
      });
      const effectiveReferences = references.length ? references : [sourceReference!];
      const problems = validateVideoReferenceRequest({
        providerType: provider.type,
        model: provider.model,
        references: effectiveReferences,
        durationSec: item.durationSec,
        aspectRatio: aspectRatio ?? undefined,
        resolution: resolution ?? undefined,
      });
      if (problems.length > 0) return { ok: false as const, error: itemError(index, problems.join('；')) };
      referencesByItem.push(references);
    }

    const versionBase = countVideoJobsForShot(db, shotId);
    const createdAt = new Date().toISOString();
    const insertJob = db.prepare(`
      INSERT INTO video_jobs
        (id, projectId, shotSetId, shotId, sourceImageId, tailImageId, providerId, model, templateId, prompt,
         durationSec, generationMode, aspectRatio, resolution, multiShot, createdAt, displayName, openingCode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertReference = db.prepare(`INSERT INTO video_job_references (jobId, orderIndex, assetId) VALUES (?, ?, ?)`);
    for (const [index, entry] of prepared.entries()) {
      if ('error' in entry) continue;
      const { item, provider, aspectRatio, resolution } = entry;
      const videoJobId = uuidv4();
      const displayName = planVideoJobDisplayName(db, {
        shotId,
        sourceImageId,
        templateId: item.templateId,
        versionNumber: versionBase + index + 1,
      });
      insertJob.run(
        videoJobId, shotSet.projectId, shotSetId, shotId, sourceImageId, item.tailImageId,
        item.providerId, provider.model, item.templateId, item.prompt, item.durationSec,
        item.generationMode, aspectRatio, resolution,
        normalizeVideoMultiShotForStorage(provider.type, provider.model, item.multiShot),
        createdAt, displayName, resolveTemplateOpeningCode(db, item.templateId),
      );
      for (const [orderIndex, asset] of referencesByItem[index].entries()) {
        insertReference.run(videoJobId, orderIndex, asset.id);
      }
      videoJobIds.push(videoJobId);
    }
    return { ok: true as const };
  });
  try {
    const result = createResult();
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    return { ok: true, videoJobIds };
  } catch (error) {
    if (error instanceof VideoReferenceCreationError) return { ok: false, status: 400, error: error.message };
    throw error;
  }
}

class VideoReferenceCreationError extends Error {}
