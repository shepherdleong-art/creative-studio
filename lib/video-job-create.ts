import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db.ts';
import { snapCompanyVideoAspectRatio } from './company-gateway-size.ts';
import { resolveTemplateOpeningCode } from './media-core/production-code-reader.ts';
import { getVideoProviderConfigState } from './video-auth.ts';
import { parseVideoDuration, videoDurationError } from './video-duration.ts';
import { normalizeVideoMultiShotForStorage } from './video-multi-shot.ts';
import {
  decideVideoGenerationMode,
  isVideoAutoModeTarget,
  type VideoTailFrameDraftState,
} from './video-auto-mode.ts';
import { countVideoJobsForShot, planVideoJobDisplayName } from './video-output-filenames.ts';
import { validateVideoReferenceRequest, videoReferenceCapability, type VideoReferenceKind } from './video-reference-contract.ts';
import {
  prepareVideoJobImage,
  videoPreprocessErrorCode,
  type VideoImageRole,
} from './video-reference-preprocess.ts';
import { validateVideoTailFrameAsset } from './video-tail-frame.ts';
import { readVideoSourceReference } from './video-source-reference.ts';
import { requireAccessContext } from './media-core/access-context.ts';

export type VideoJobGenerationMode = 'image-to-video' | 'reference-to-video';

/**
 * 模式意图标记（向后兼容的新增字段，规格 §6「需要自动意图标记时由实现者定义」）。
 *
 * - `'auto'`：受控工作台（H3/Wan）请求，服务端按**已授权尾帧素材**自行确定模式，
 *   并与前端声明核对；不一致或矛盾直接拒绝，不静默纠正。
 * - `'explicit'`（缺省）：显式 API / 画布 / 外部集成的既有合同，模式由调用方指定，
 *   行为与本次改动前完全一致——这条边界保证不全局改写所有 API 请求。
 */
export type VideoJobModeIntent = 'auto' | 'explicit';

export interface VideoJobCreationItem {
  prompt: string;
  templateId: string | null;
  providerId: string;
  durationSec: number;
  tailImageId: string | null;
  multiShot: unknown;
  generationMode: VideoJobGenerationMode;
  /** 缺省视为 `'explicit'`，兼容直接构造条目的内部/历史调用方。 */
  modeIntent?: VideoJobModeIntent;
  /**
   * 自动模式草稿的尾帧三态（`none` / `ready` / `pending`）。
   * 前端才看得到「上传中/删除中/失败」，服务端凭它拒绝未完成的尾帧操作；
   * 缺省由 `tailImageId` 是否存在推导。非自动模式忽略此字段。
   */
  autoTailState?: VideoTailFrameDraftState | null;
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
  const modeIntent = body.modeIntent ?? 'explicit';
  if (modeIntent !== 'auto' && modeIntent !== 'explicit') {
    return { ok: false, error: 'modeIntent 必须是 auto 或 explicit' };
  }
  const rawAutoTailState = body.autoTailState;
  if (rawAutoTailState !== undefined && rawAutoTailState !== null
    && !['none', 'ready', 'pending'].includes(String(rawAutoTailState))) {
    return { ok: false, error: 'autoTailState 必须是 none、ready 或 pending' };
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
      modeIntent,
      ...(rawAutoTailState === undefined || rawAutoTailState === null
        ? {}
        : { autoTailState: String(rawAutoTailState) as VideoTailFrameDraftState }),
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

/**
 * 服务端自动模式核对（规格 §6）。返回**已核对**的条目：自动模式条目的
 * `generationMode` 由服务端按库里的真实尾帧素材重算，前端声明只用来发现矛盾。
 *
 * 这里不读取任何前端装饰性字段作为模式依据；`autoTailState` 仅用于把
 * 「尾帧上传中/删除中/失败」这一**前端才可见**的操作状态显式带过来，
 * 声明成 pending 时直接拒绝（否则 tailImageId 暂空会被读成「没有尾帧」，
 * 正好是规格禁止的偷偷降级）。
 */
function reconcileAutoModeItems(input: {
  db: Database.Database;
  items: VideoJobCreationItem[];
  providerCache: Map<string, VideoProviderRow & { model: string }>;
  projectId: string;
  itemError: (index: number, error: string) => string;
}): { ok: true; items: VideoJobCreationItem[] } | { ok: false; error: string } {
  const { db, items, providerCache, projectId, itemError } = input;
  const reconciled: VideoJobCreationItem[] = [];
  for (const [index, item] of items.entries()) {
    if (item.modeIntent !== 'auto') {
      reconciled.push(item);
      continue;
    }
    const provider = providerCache.get(item.providerId)!;
    if (!isVideoAutoModeTarget(provider.type, provider.model)) {
      return {
        ok: false,
        error: itemError(index, `自动模式只适用于公司 MiniMax H3 / Wan 3.0，模型 ${provider.model} 必须显式指定生成模式`),
      };
    }
    // 三态必须由前端显式声明：`pending`（上传中/删除中/失败）只有前端看得见。
    // 缺字段时**不能**按 tailImageId 猜成 none——「尾帧上传中」恰好暂时没有 id，
    // 猜成 none 就会静默退回单图，正是规格 §6 行2 禁止的行为。缺声明即拒绝。
    const declared = item.autoTailState ?? null;
    if (!declared) {
      return {
        ok: false,
        error: itemError(index, '自动模式请求必须声明尾帧状态（autoTailState：none/ready/pending）'),
      };
    }
    // pending 一律阻止提交；ready/none 仍以**库里真实存在的尾帧 id** 为准复核，
    // 服务端不采信前端自称的 ready——否则「声明 ready 却不带尾帧」可绕过核对。
    const draftState: VideoTailFrameDraftState = declared === 'pending'
      ? 'pending'
      : item.tailImageId ? 'ready' : 'none';
    const decision = decideVideoGenerationMode({
      providerType: provider.type,
      model: provider.model,
      tailFrameState: draftState,
      explicitMode: item.generationMode,
    });
    if (decision.blocked) {
      return { ok: false, error: itemError(index, '尾帧正在上传或移除、或上一次上传失败，请等待完成或先移除尾帧再提交') };
    }
    // 自动模式只用当前冻结分镜图作唯一参考，不接受显式参考素材列表，
    // 也不接受把尾帧当参考素材的混合草稿。
    if (item.referenceAssetIds.length > 0) {
      return { ok: false, error: itemError(index, '自动模式只使用当前分镜图作为唯一参考，不能携带参考素材') };
    }
    // 用库里真实素材核对尾帧（归属、用途、模型能力）；任一不合法都在 POST 前失败。
    const tail = validateVideoTailFrameAsset({
      db,
      tailImageId: item.tailImageId,
      projectId,
      providerType: provider.type,
      model: provider.model,
    });
    if (!tail.ok) return { ok: false, error: itemError(index, tail.error) };
    const verifiedMode = decision.generationMode;
    if (item.generationMode !== verifiedMode) {
      const detail = verifiedMode === 'reference-to-video'
        ? '自动模式请求声明为首尾帧，但服务端没有找到有效尾帧，请刷新尾帧状态后重试'
        : '自动模式请求声明为单图参考，但该尾帧有效，应提交首尾帧（FirstFrame/LastFrame）';
      return { ok: false, error: itemError(index, detail) };
    }
    reconciled.push({ ...item, generationMode: verifiedMode });
  }
  return { ok: true, items: reconciled };
}

export async function createVideoJobsForShot(input: {
  shotSetId: string;
  shotId: string;
  items: VideoJobCreationItem[];
  batch?: boolean;
  db?: Database.Database;
}): Promise<VideoJobCreationResult> {
  const db = input.db ?? getDb();
  const access = requireAccessContext();
  const { shotSetId, shotId, items } = input;
  if (access.kind === 'team') access.assertAccess('shot_set', shotSetId, 'write');
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
  if (access.kind === 'team') {
    access.assertAccess('shot', shotId, 'read');
    access.assertAccess('image', sourceImageId, 'read');
    for (const item of items) {
      if (item.tailImageId) access.assertAccess('image', item.tailImageId, 'read');
      if (item.templateId) access.assertAccess('video_prompt_template', item.templateId, 'read');
      for (const assetId of item.referenceAssetIds) access.assertAccess('video_reference_asset', assetId, 'read');
    }
  }

  // ── H3/Wan 自动模式核对（规格 §6）────────────────────────────────────────
  // 服务端不能只信前端 generationMode：受控工作台用 `modeIntent='auto'` 声明
  // 「按模型与已授权尾帧状态核对模式」。这里用**库里的真实素材**重算一次：
  //   · 有合法尾帧 → image-to-video（FileInfos FirstFrame/LastFrame）
  //   · 没有尾帧   → reference-to-video（冻结首图作唯一 Reference）
  // 与前端声明矛盾、给自动模式带显式参考素材/比例档位、或把尾帧操作中的草稿
  // 当成单图提交，全部在付费 POST 与落任务前 400 拒绝，绝不静默纠正。
  // 缺省 `modeIntent='explicit'` 的显式 API / 画布 / 外部集成完全不走这段，
  // 既有合同与历史任务行为不变。
  const reconciled = reconcileAutoModeItems({ db, items, providerCache, projectId: shotSet.projectId, itemError });
  if (!reconciled.ok) return { ok: false, status: 400, error: reconciled.error };
  const effectiveItems = reconciled.items;

  let sourceReference: Awaited<ReturnType<typeof readVideoSourceReference>> | null = null;
  if (effectiveItems.some((item) => item.generationMode === 'reference-to-video' && item.referenceAssetIds.length === 0)) {
    try { sourceReference = await readVideoSourceReference(db, sourceImageId, shotSet.projectId); }
    catch (error) { return { ok: false, status: 400, error: (error as Error).message }; }
  }

  let sourceDimensions: { width: number; height: number } | null = null;
  // 只有参考模式在未显式指定比例时才需要按分镜来源图吸附；
  // 读取失败不阻断创建，改用 16:9 或模型比例表首项兜底。
  if (effectiveItems.some((item) => item.generationMode === 'reference-to-video' && !item.aspectRatio)) {
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

  const prepared = effectiveItems.map((item, index) => {
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

  // ── 图片预处理（创建阶段）──────────────────────────────────────────────
  // 规格 §7：创建阶段不能按「原图上游上限」直接拒绝，也不能为了绕过检查伪造
  // byteSize。这里先按统一预算物化/复用派生副本，再把**实测的交付事实**交给
  // 共享校验函数。原图字节与 image_assets 身份完全不变。
  //
  // 为什么在创建阶段就物化：预算可达性是创建契约的一部分（不可达必须在落任务
  // 前拒绝），而且派生副本按 (源图内容, 预算) 内容寻址，执行阶段直接复用同一份
  // 文件，不会二次编码；进程内去重避免并发重复压缩。
  const deliveryByAssetId = new Map<string, { mimeType: string; byteSize: number }>();
  const deliveryBySourceImageId = new Map<string, { mimeType: string; byteSize: number }>();
  // 逐条预处理：错误信息必须指向真正失败的那一条运镜，不能统一报第 1 条。
  const preprocessError = async (
    index: number,
    run: () => Promise<void>,
  ): Promise<string | null> => {
    try {
      await run();
      return null;
    } catch (error) {
      // 按错误码判，不用跨模块 instanceof（预处理模块导出的判码函数两者都兼容）。
      if (videoPreprocessErrorCode(error)) return itemError(index, (error as Error).message);
      throw error;
    }
  };
  for (const [index, entry] of prepared.entries()) {
    if ('error' in entry) continue;
    const { item, provider } = entry;
    if (item.generationMode === 'reference-to-video') {
      const assetIds = item.referenceAssetIds;
      const error = await preprocessError(index, async () => {
        if (assetIds.length > 0) {
          for (const assetId of new Set(assetIds)) {
            const row = db.prepare(`SELECT id, path, mimeType FROM video_reference_assets WHERE id = ? AND projectId = ?`)
              .get(assetId, shotSet.projectId) as { id: string; path: string; mimeType: string } | undefined;
            if (!row) continue; // 归属错误留给下面的事务内校验报中文错误。
            const preparedImage = await prepareVideoJobImage({
              providerType: provider.type,
              model: provider.model,
              role: 'reference' satisfies VideoImageRole,
              absolutePath: row.path,
            });
            if (preparedImage) {
              deliveryByAssetId.set(row.id, {
                mimeType: preparedImage.prepared.mimeType,
                byteSize: preparedImage.prepared.byteSize,
              });
            }
          }
          return;
        }
        if (!sourceReference) return;
        const preparedImage = await prepareVideoJobImage({
          providerType: provider.type,
          model: provider.model,
          role: 'reference',
          absolutePath: sourceReference.path,
        });
        if (preparedImage) {
          deliveryBySourceImageId.set(sourceImageId, {
            mimeType: preparedImage.prepared.mimeType,
            byteSize: preparedImage.prepared.byteSize,
          });
        }
      });
      if (error) return { ok: false, status: 400, error };
      continue;
    }
    // 首尾帧：首帧与尾帧预算不同（腾讯 FileInfos ≤10M / LastFrameUrl <5M）。
    const frameAsset = db.prepare(`
      SELECT originalPath, processedPath, path FROM image_assets WHERE id = ?
    `).get(sourceImageId) as { originalPath: string | null; processedPath: string | null; path: string } | undefined;
    const firstFramePath = frameAsset ? (frameAsset.originalPath || frameAsset.processedPath || frameAsset.path) : null;
    if (!firstFramePath) return { ok: false, status: 400, error: itemError(index, '当前分镜图不存在或不属于当前项目') };
    const tailAsset = item.tailImageId
      ? db.prepare(`SELECT originalPath, processedPath, path FROM image_assets WHERE id = ?`)
        .get(item.tailImageId) as { originalPath: string | null; processedPath: string | null; path: string } | undefined
      : undefined;
    const frameError = await preprocessError(index, async () => {
      await prepareVideoJobImage({
        providerType: provider.type, model: provider.model, role: 'first-frame', absolutePath: firstFramePath,
      });
      if (!tailAsset) return;
      await prepareVideoJobImage({
        providerType: provider.type,
        model: provider.model,
        role: 'last-frame',
        absolutePath: tailAsset.originalPath || tailAsset.processedPath || tailAsset.path,
      });
    });
    if (frameError) return { ok: false, status: 400, error: frameError };
  }

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
      // 校验按**反而实际上游交付物**：有派生副本时用副本实测的 MIME/字节，
      // 否则用原图；原图的 byteSize 保持真实值，绝不为绕过检查而改写或置空。
      const validationReferences = effectiveReferences.map((reference) => {
        const delivery = deliveryByAssetId.get(reference.id)
          ?? (reference.id === sourceImageId ? deliveryBySourceImageId.get(sourceImageId) : undefined)
          ?? null;
        return { ...reference, ...(delivery ? { delivery } : {}) };
      });
      const problems = validateVideoReferenceRequest({
        providerType: provider.type,
        model: provider.model,
        references: validationReferences,
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
      access.registerInheritedScope({
        resourceType: 'video_job', resourceId: videoJobId,
        parent: { resourceType: 'project', resourceId: shotSet.projectId },
      });
      access.registerTaskPrincipal({
        module: 'video', taskId: videoJobId,
        scope: { resourceType: 'project', resourceId: shotSet.projectId },
        creationSnapshot: { shotSetId, shotId, sourceImageId, model: provider.model },
      });
      videoJobIds.push(videoJobId);
    }
    return { ok: true as const };
  });
  try {
    const result = createResult.immediate();
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    return { ok: true, videoJobIds };
  } catch (error) {
    if (error instanceof VideoReferenceCreationError) return { ok: false, status: 400, error: error.message };
    throw error;
  }
}

class VideoReferenceCreationError extends Error {}
