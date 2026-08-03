import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { probeVideoMedia, runFfmpeg } from '../ffmpeg.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../final-edit/storage-path.ts';
import { buildColorFilterFragments, COLOR_PIPELINE_VERSION, upgradeColorSnapshot, type ColorSnapshotV1 } from './color-pipeline.ts';
import { computeFingerprintFromFile, fingerprintsEqual } from './fingerprint.ts';
import { resolveSourceFilePath } from './media-catalog.ts';
import {
  acquireProxyWriteLease,
  resolveControlledProxyPath,
  type BatchProxyCacheItemRow,
  type BatchProxyRequestRow,
} from './proxy-cache.ts';
import type { BatchTaskExecutor } from './executors.ts';

/**
 * 首个代理规格(profile 版本 proxy-v1,与 §5.4 要求对应)。参数不是永远不变的产品合同,
 * 变化必须推进 PROXY_PROFILE_VERSION——旧 proxyKey 会随之失效,不会被新参数悄悄复用。
 *
 * - 分辨率:高度不超过 720(scale=-2:min(720,ih)),只下采样不放大,保持原始宽高比。
 * - codec/pixfmt:H.264 + yuv420p——安装包内置浏览器/Electron 都能稳定解码,兼容性优先。
 * - GOP:固定 50 帧、关闭场景切换自适应关键帧(-sc_threshold 0),换取规律可预测的拖动体验,
 *   而不是 x264 默认的自适应关键帧间距。
 * - preset veryfast + crf 26:代理只服务预览,优先生成速度,不追求最佳压缩。
 * - 音轨转码为 AAC 128k,避免源音频编码在浏览器里不可播放。
 * - 容器:mp4 + faststart,本地文件服务不需要等完整下载才能开始播放/拖动。
 * - 已用本机合成素材证明可解码、可拖动、时长误差达标(见 scripts/batch-proxy-generation.test.ts)。
 */
export const PROXY_PROFILE_VERSION = 'proxy-v1';

// 占位安全阈值,尚未在目标机型上校准(§5.4 明确本阶段只做窄资源合同);
// 真实提醒窗口和安全红线属于后续验证矩阵范围。
const MIN_FREE_BYTES_FOR_PROXY = 512 * 1024 * 1024;

async function assertEnoughDiskSpaceForProxy(directory: string): Promise<void> {
  const stat = await fsPromises.statfs(directory);
  const availableBytes = stat.bavail * stat.bsize;
  if (availableBytes < MIN_FREE_BYTES_FOR_PROXY) {
    const availableMb = Math.floor(availableBytes / (1024 * 1024));
    throw new Error(`磁盘剩余空间不足(可用 ${availableMb}MB),已阻塞代理生成;请清理空间或代理缓存后重试`);
  }
}

function resolveManagedDataRootPath(relativePath: string): string {
  const root = dataRoot();
  const resolved = resolveStoragePath(root, relativePath);
  assertNoStorageSymlink(root, relativePath);
  return resolved;
}

// proxy executor 是重本地任务,默认单并发(§5.4):进程内一条 FIFO 互斥链,
// 不占用调度并发槽等待,只序列化真正的 FFmpeg 编码本身。
let proxyGenerationLock: Promise<void> = Promise.resolve();
async function withProxyGenerationSlot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = proxyGenerationLock;
  let release!: () => void;
  proxyGenerationLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('任务已中止');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function markCacheFailed(
  db: Parameters<BatchTaskExecutor['execute']>[0]['db'],
  cacheItemId: string,
  requestId: string,
): void {
  db.prepare(`
    UPDATE batch_proxy_cache_items SET status = 'failed', updatedAt = ? WHERE id = ?
  `).run(nowIso(), cacheItemId);
  db.prepare(`
    UPDATE batch_proxy_requests
    SET status = 'failed', updatedAt = ?
    WHERE id = ? AND currentCacheItemId = ? AND status <> 'cancelled'
  `).run(nowIso(), requestId, cacheItemId);
}

function shouldMarkCacheFailed(
  db: Parameters<BatchTaskExecutor['execute']>[0]['db'],
  requestId: string,
  cacheItemId: string,
): boolean {
  const live = db.prepare(`
    SELECT r.status AS requestStatus, r.currentCacheItemId,
           c.pendingDeleteAt
    FROM batch_proxy_requests r
    LEFT JOIN batch_proxy_cache_items c ON c.id = r.currentCacheItemId
    WHERE r.id = ?
  `).get(requestId) as {
    requestStatus: BatchProxyRequestRow['status'];
    currentCacheItemId: string | null;
    pendingDeleteAt: string | null;
  } | undefined;
  return Boolean(
    live
    && live.currentCacheItemId === cacheItemId
    && live.requestStatus !== 'cancelled'
    && live.pendingDeleteAt === null
  );
}

function assertRequestPublishable(
  db: Parameters<BatchTaskExecutor['execute']>[0]['db'],
  requestId: string,
  cacheItemId: string,
  signal: AbortSignal,
): void {
  assertNotAborted(signal);
  const liveRequest = db.prepare(`
    SELECT currentCacheItemId, status FROM batch_proxy_requests WHERE id = ?
  `).get(requestId) as {
    currentCacheItemId: string | null;
    status: BatchProxyRequestRow['status'];
  } | undefined;
  if (
    !liveRequest
    || liveRequest.currentCacheItemId !== cacheItemId
    || liveRequest.status === 'cancelled'
    || liveRequest.status === 'failed'
  ) {
    throw new Error('代理请求已被取消、重新定向或失效,放弃发布');
  }
  const liveCache = db.prepare(`
    SELECT pendingDeleteAt FROM batch_proxy_cache_items WHERE id = ?
  `).get(cacheItemId) as { pendingDeleteAt: string | null } | undefined;
  if (!liveCache || liveCache.pendingDeleteAt) {
    throw new Error('代理缓存正在被清理,放弃发布');
  }
}

/**
 * 重新核验冻结快照引用的受管 LUT 文件:
 * 1. 按 batch_luts 目录记录解析受管路径(拒绝越界/符号链接);
 * 2. 重新计算完整 SHA-256;
 * 3. 必须同时匹配冻结 snapshot.lutFingerprint 与 batch_luts.contentFingerprint。
 * 任一不匹配、文件缺失或路径非法都抛出明确错误,调用方收敛为失败状态且不留下临时文件。
 */
async function verifyFrozenLutFile(
  db: Parameters<BatchTaskExecutor['execute']>[0]['db'],
  snapshot: ColorSnapshotV1,
): Promise<string> {
  const lut = db.prepare(`
    SELECT relativePath, contentFingerprint FROM batch_luts WHERE id = ?
  `).get(snapshot.lutId) as { relativePath: string; contentFingerprint: string } | undefined;
  if (!lut) {
    throw new Error('冻结快照引用的 LUT 记录不存在,无法生成色彩代理');
  }
  let absolutePath: string;
  try {
    absolutePath = resolveManagedDataRootPath(lut.relativePath);
  } catch {
    throw new Error('冻结快照引用的 LUT 受管路径非法,无法生成色彩代理');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error('冻结快照引用的 LUT 受管文件缺失,无法生成色彩代理');
  }
  const actual = await computeFingerprintFromFile(absolutePath);
  if (
    !snapshot.lutFingerprint
    || snapshot.lutFingerprint.startsWith('unresolved:')
    || !fingerprintsEqual(actual, snapshot.lutFingerprint)
    || !fingerprintsEqual(actual, lut.contentFingerprint)
  ) {
    throw new Error('冻结快照引用的 LUT 文件内容与冻结指纹或目录记录不一致,无法生成色彩代理');
  }
  return absolutePath;
}

/**
 * 代理生成执行器(proxy_generate):任务的目标是稳定代理请求(batch_proxy_requests.id),
 * 通过请求的 currentCacheItemId 解析缓存项,在开始编码前重新核验原片来源和 LUT 文件
 * 内容指纹,然后从原片解码 -> 按需应用 LUT -> 缩放 -> 编码,写入受控代理缓存目录。
 *
 * 重新核验要求(§3):
 * - 遍历允许来源,重新计算完整 SHA-256,选择与请求冻结指纹一致的来源。
 * - 路径存在但内容被替换时必须失败,不能把新内容发布到旧 proxyKey。
 * - 应用 LUT 前重新核验受管 LUT 文件指纹;缺失或变化必须失败。
 * - 从准备临时文件到原子发布与 ready 数据库更新完成期间持有写租约;
 *   清理并发运行时只标记 pending-delete,不会一边写一边删。
 * - rename 前重新检查 AbortSignal、请求仍有效、cache 行仍存在且没有待删除。
 * - 失败/取消/清理竞争时删除自己的临时文件,不留正式半成品或孤儿文件。
 */
export const proxyGenerateExecutor: BatchTaskExecutor = {
  workTypes: ['proxy_generate'],
  async execute(context) {
    const { db, claim, signal } = context;
    if (claim.task.targetKind !== 'proxy_request') {
      throw new Error('代理生成任务的目标必须是 proxy_request');
    }
    const request = db.prepare(`
      SELECT * FROM batch_proxy_requests WHERE id = ?
    `).get(claim.task.targetId) as BatchProxyRequestRow | undefined;
    if (!request) {
      throw new Error('代理请求不存在');
    }
    if (!request.currentCacheItemId) {
      throw new Error('代理请求的缓存已被清理,任务失效;请重新请求代理');
    }
    const cacheItem = db.prepare(`
      SELECT * FROM batch_proxy_cache_items WHERE id = ?
    `).get(request.currentCacheItemId) as BatchProxyCacheItemRow | undefined;
    if (!cacheItem) {
      throw new Error('代理缓存项不存在,任务失效;请重新请求代理');
    }

    if (
      request.assetId !== cacheItem.assetId
      || request.projectId !== cacheItem.projectId
      || request.proxyKey !== cacheItem.proxyKey
    ) {
      markCacheFailed(db, cacheItem.id, request.id);
      throw new Error('代理请求与缓存项的身份或项目谱系不一致');
    }

    context.reportProgress({ phase: 'locating', description: '定位原片来源并重新核验内容指纹', percent: null });
    assertNotAborted(signal);

    // §3: 遍历允许来源,重新计算完整 SHA-256,选择与请求冻结指纹一致的来源。
    // 路径存在但内容被替换时必须失败。
    const sources = db.prepare(`
      SELECT id, locationJson FROM batch_asset_sources WHERE assetId = ?
      ORDER BY createdAt, id
    `).all(cacheItem.assetId) as Array<{ id: string; locationJson: string }>;

    let verifiedSourcePath: string | null = null;
    for (const source of sources) {
      try {
        const filePath = resolveSourceFilePath(JSON.parse(source.locationJson));
        if (!fs.existsSync(filePath)) continue;
        const actualFingerprint = await computeFingerprintFromFile(filePath);
        if (fingerprintsEqual(actualFingerprint, request.contentFingerprint)) {
          verifiedSourcePath = filePath;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!verifiedSourcePath) {
      markCacheFailed(db, cacheItem.id, request.id);
      throw new Error('所有原片来源均已离线、内容已变化或无法重新核验,代理生成失败');
    }

    return withProxyGenerationSlot(async () => {
      // 写租约:从准备临时文件开始,到原子发布与 ready 数据库更新完成为止。
      const releaseWriteLease = acquireProxyWriteLease(cacheItem.id, db);
      let tempAbsolutePath = '';
      try {
        const liveCache = db.prepare(`
          SELECT * FROM batch_proxy_cache_items WHERE id = ?
        `).get(cacheItem.id) as BatchProxyCacheItemRow | undefined;
        if (!liveCache) {
          throw new Error('代理缓存项已被清理,任务失效;请重新请求代理');
        }

        // 每个批次版本拥有自己的可控任务，但相同 proxyKey 仍只保留一份文件。
        // 若先到的任务已把 cache 发布为 ready，后到任务在全局写槽内直接复用，
        // 不再启动第二次 FFmpeg；这样取消批次 A 也不会让批次 B 失去自己的任务。
        if (liveCache.status === 'ready' && !liveCache.pendingDeleteAt) {
          assertRequestPublishable(db, request.id, liveCache.id, signal);
          const readyPath = resolveControlledProxyPath(liveCache.relativePath);
          if (fs.existsSync(readyPath) && fs.statSync(readyPath).size > 0) {
            db.prepare(`
              UPDATE batch_proxy_requests SET status = 'ready', updatedAt = ? WHERE id = ?
            `).run(nowIso(), request.id);
            context.reportProgress({ phase: 'ready', description: '复用已就绪代理', percent: 1 });
            return {
              resultJson: {
                requestId: request.id,
                cacheItemId: liveCache.id,
                fileSizeBytes: liveCache.fileSizeBytes,
                profileVersion: PROXY_PROFILE_VERSION,
                colorPipelineVersion: COLOR_PIPELINE_VERSION,
                reused: true,
              },
            };
          }
          // ready 元数据对应的文件已丢失，降回 pending 后由本任务重建。
          db.prepare(`
            UPDATE batch_proxy_cache_items
            SET status = 'pending', mediaJson = '{}', fileSizeBytes = 0,
                checksum = NULL, updatedAt = ?
            WHERE id = ?
          `).run(nowIso(), liveCache.id);
        }

        context.reportProgress({ phase: 'preflight', description: '检查磁盘空间', percent: null });
        assertNotAborted(signal);
        await assertEnoughDiskSpaceForProxy(dataRoot());

        // 色彩快照以持久化请求为准(与素材池冻结快照同源)
        const colorSnapshot = upgradeColorSnapshot(JSON.parse(request.colorJson));
        let verifiedLutAbsolutePath: string | null = null;
        if (colorSnapshot.lutId !== null) {
          context.reportProgress({ phase: 'verifying_lut', description: '重新核验 LUT 文件指纹', percent: null });
          assertNotAborted(signal);
          verifiedLutAbsolutePath = await verifyFrozenLutFile(db, colorSnapshot);
        }
        const colorFilters = buildColorFilterFragments({
          colorSnapshot,
          resolveLutAbsolutePath: (lutId) => {
            if (!verifiedLutAbsolutePath) {
              throw new Error(`LUT 未通过重新核验,不能用于生成色彩代理(${lutId})`);
            }
            return verifiedLutAbsolutePath;
          },
        });
        const vf = ['scale=-2:min(720\\,ih)', ...colorFilters, 'format=yuv420p'].join(',');

        context.reportProgress({ phase: 'probing', description: '探测原片时长', percent: null });
        assertNotAborted(signal);
        const probe = await probeVideoMedia(verifiedSourcePath);
        if (probe.errorMessage || probe.durationUs <= 0) {
          markCacheFailed(db, cacheItem.id, request.id);
          throw new Error('无法读取原片媒体信息,无法生成代理');
        }

        // 进入写租约保护段:临时文件准备从这一刻开始
        const finalAbsolutePath = resolveControlledProxyPath(cacheItem.relativePath);
        tempAbsolutePath = `${finalAbsolutePath}.tmp-${randomUUID()}`;
        fs.mkdirSync(path.dirname(finalAbsolutePath), { recursive: true });

        const totalSec = probe.durationUs / 1_000_000;
        context.reportProgress({ phase: 'encoding', description: '生成代理', completed: 0, total: totalSec, percent: 0 });
        db.prepare(`
          UPDATE batch_proxy_requests
          SET status = 'generating', updatedAt = ?
          WHERE currentCacheItemId = ? AND status = 'requested'
        `).run(nowIso(), cacheItem.id);
        await runFfmpeg([
          '-i', verifiedSourcePath,
          '-vf', vf,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
          '-g', '50', '-sc_threshold', '0',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
          '-movflags', '+faststart',
          '-f', 'mp4',
          '-progress', 'pipe:1',
          '-y', tempAbsolutePath,
        ], {
          signal,
          onProgressSec: (sec) => {
            const percent = totalSec > 0 ? Math.min(1, Math.max(0, sec / totalSec)) : null;
            context.reportProgress({
              phase: 'encoding',
              description: '生成代理',
              completed: Math.round(sec),
              total: Math.round(totalSec),
              percent,
            });
          },
        });

        context.reportProgress({ phase: 'verifying', description: '核验代理产物', percent: null });
        assertNotAborted(signal);
        const proxyProbe = await probeVideoMedia(tempAbsolutePath);
        if (proxyProbe.errorMessage || proxyProbe.durationUs <= 0) {
          markCacheFailed(db, cacheItem.id, request.id);
          throw new Error('代理产物校验失败(无法解码或时长异常)');
        }

        // rename 前重新检查:信号未中止、请求仍有效、cache 行仍存在且没有被清理标记。
        // 并发清理会把 pendingDeleteAt 写进 cache 行,这里检测到就必须放弃发布,
        // 否则清理过的文件又会被正式落盘。
        const fileSizeBytes = fs.statSync(tempAbsolutePath).size;
        const checksum = await computeFingerprintFromFile(tempAbsolutePath);

        // checksum 是异步 IO，清理/取消可能在此期间发生；因此必须在它完成后、
        // 紧贴 rename 再检查一次信号、请求与 cache，不能依赖哈希前的陈旧检查。
        assertRequestPublishable(db, request.id, cacheItem.id, signal);

        // 原子发布:先写临时文件、探测校验通过后再改名,避免半成品被当作可用代理提供预览。
        fs.renameSync(tempAbsolutePath, finalAbsolutePath);
        tempAbsolutePath = '';

        db.prepare(`
          UPDATE batch_proxy_cache_items
          SET status = 'ready', mediaJson = ?, fileSizeBytes = ?, checksum = ?, updatedAt = ?
          WHERE id = ?
        `).run(
          JSON.stringify({ durationUs: proxyProbe.durationUs, width: proxyProbe.width, height: proxyProbe.height }),
          fileSizeBytes,
          checksum,
          nowIso(),
          cacheItem.id,
        );
        db.prepare(`
          UPDATE batch_proxy_requests
          SET status = 'ready', updatedAt = ?
          WHERE currentCacheItemId = ? AND status <> 'cancelled'
        `).run(nowIso(), cacheItem.id);

        context.reportProgress({ phase: 'ready', description: '代理已就绪', percent: 1 });
        return {
          resultJson: {
            requestId: request.id,
            cacheItemId: cacheItem.id,
            fileSizeBytes,
            profileVersion: PROXY_PROFILE_VERSION,
            colorPipelineVersion: COLOR_PIPELINE_VERSION,
          },
        };
      } catch (error) {
        // abort/失败/清理竞争都不能留下半成品临时文件占用受控目录空间;
        // 只有失败(非取消/清理)才落 failed 状态,取消由调度器按任务语义收敛。
        if (tempAbsolutePath) {
          try { fs.unlinkSync(tempAbsolutePath); } catch { /* 可能从未成功创建,忽略 */ }
        }
        if (!signal.aborted && shouldMarkCacheFailed(db, request.id, cacheItem.id)) {
          markCacheFailed(db, cacheItem.id, request.id);
        }
        throw error;
      } finally {
        releaseWriteLease();
      }
    });
  },
};
