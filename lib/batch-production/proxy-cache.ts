import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath } from '../media-core/storage-path.ts';
import { resolveColorSnapshot } from './lut-catalog.ts';
import { cancelTask } from './scheduler.ts';
import { createBatchTask } from './tasks.ts';
import { colorSnapshotIdentity, type ColorSnapshotV1, upgradeColorSnapshot } from './color-pipeline.ts';
import { fingerprintHex, fingerprintsEqual } from './fingerprint.ts';
import type { BatchColorSnapshot } from './versions.ts';

/** 兼容类型:接受旧格式 {lutId} 或新格式完整 ColorSnapshotV1,内部自动升级 */
export type ColorSnapshotInput = BatchColorSnapshot | ColorSnapshotV1;

function toColorSnapshotV1(input: ColorSnapshotInput): ColorSnapshotV1 {
  return upgradeColorSnapshot(input);
}

export type BatchProxyCacheStatus = 'pending' | 'ready' | 'failed';

export interface BatchProxyCacheItemRow {
  id: string;
  proxyKey: string;
  projectId: string;
  assetId: string;
  profileVersion: string;
  colorJson: string;
  relativePath: string;
  status: BatchProxyCacheStatus;
  mediaJson: string;
  fileSizeBytes: number;
  checksum: string | null;
  pendingDeleteAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 持久化代理请求:稳定业务身份,cache 可删除但请求不能悬空。 */
export type BatchProxyRequestStatus = 'requested' | 'generating' | 'ready' | 'failed' | 'cancelled';

export interface BatchProxyRequestRow {
  id: string;
  projectId: string;
  batchId: string;
  batchVersionId: string;
  assetId: string;
  contentFingerprint: string;
  colorJson: string;
  profileVersion: string;
  colorPipelineVersion: string;
  proxyKey: string;
  currentCacheItemId: string | null;
  status: BatchProxyRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ComputeProxyKeyInput {
  assetId: string;
  /** 原片完整内容指纹(不是路径);指纹变化必须产生不同的 key */
  contentFingerprint: string;
  /** 代理规格版本(分辨率/codec/pixel format/GOP 等一起归入一个版本号) */
  profileVersion: string;
  /** 完整色彩快照(包含 LUT 指纹、色彩链版本、插值策略、SDR 合同) */
  colorSnapshot: ColorSnapshotInput;
  /** 色彩处理链实现版本(ColorPipeline 的版本号,不是 LUT 内容本身) */
  colorPipelineVersion: string;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 代理身份 = 项目与素材身份 + 原片完整内容指纹 + 代理规格版本 + 完整色彩快照(包括 LUT 指纹)。
 * 文件名、原路径和显示名称都不参与身份判断;任意一项变化都必须产生不同的 key,
 * 旧代理只会成为清理候选,不会被新请求误用。纯函数,不接触数据库或文件系统。
 */
export function computeProxyKey(input: ComputeProxyKeyInput): string {
  const snapshot = toColorSnapshotV1(input.colorSnapshot);
  const colorIdentity = colorSnapshotIdentity(snapshot);
  const canonical = JSON.stringify({
    assetId: input.assetId,
    contentFingerprint: input.contentFingerprint,
    profileVersion: input.profileVersion,
    colorIdentity,
    colorPipelineVersion: input.colorPipelineVersion,
  });
  return `${'sha256:'}${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * 代理文件名:proxyKey 的身份本身保留规范 sha256:hex 格式(identity 不降级),
 * 但落到文件系统时使用纯 hex 编码——冒号在 Windows 上是非法文件名字符,
 * 任何平台都不允许把冒号写进文件名。非规范 key(测试脏数据)回退为 key 的 sha256。
 */
export function proxyFileName(proxyKey: string): string {
  try {
    return fingerprintHex(proxyKey);
  } catch {
    return createHash('sha256').update(proxyKey).digest('hex');
  }
}

/** 代理文件的受控相对路径:dataRoot()/storage/cache/proxies/<projectId>/<assetId>/<hex>.mp4 */
export function proxyRelativePath(projectId: string, assetId: string, proxyKey: string): string {
  return path.join('storage', 'cache', 'proxies', projectId, assetId, `${proxyFileName(proxyKey)}.mp4`);
}

function insertCacheItem(
  db: Database.Database,
  projectId: string,
  input: {
    assetId: string;
    proxyKey: string;
    profileVersion: string;
    colorSnapshot: ColorSnapshotInput;
    now?: () => Date;
  },
): BatchProxyCacheItemRow {
  const createdAt = nowIso(input.now);
  const id = randomUUID();
  const relativePath = proxyRelativePath(projectId, input.assetId, input.proxyKey);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', 0, NULL, NULL, ?, ?)
  `).run(
    id,
    input.proxyKey,
    projectId,
    input.assetId,
    input.profileVersion,
    JSON.stringify(input.colorSnapshot),
    relativePath,
    createdAt,
    createdAt,
  );
  return db.prepare(`SELECT * FROM batch_proxy_cache_items WHERE id = ?`).get(id) as BatchProxyCacheItemRow;
}

/**
 * 取或建一个 pending 代理缓存项(供 proxy_generate 任务引用)。
 * 同一 proxyKey 只会存在一份缓存项(UNIQUE 约束);重复请求幂等返回既有行,
 * 不产生重复文件或重复生成任务的目标。
 */
export function getOrCreatePendingProxyCacheItem(
  db: Database.Database,
  projectId: string,
  input: {
    assetId: string;
    proxyKey: string;
    profileVersion: string;
    colorSnapshot: ColorSnapshotInput;
    now?: () => Date;
  },
): BatchProxyCacheItemRow {
  const existing = db.prepare(`
    SELECT * FROM batch_proxy_cache_items WHERE proxyKey = ?
  `).get(input.proxyKey) as BatchProxyCacheItemRow | undefined;
  if (existing) {
    return existing;
  }
  return insertCacheItem(db, projectId, input);
}

/** 请求行是否存在且引用着一个真实存在的 cache 行(清理后 currentCacheItemId 被 SET NULL)。 */
export function isProxyRequestCacheAlive(db: Database.Database, requestId: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM batch_proxy_requests r
    JOIN batch_proxy_cache_items c ON c.id = r.currentCacheItemId
    WHERE r.id = ?
  `).get(requestId);
  return Boolean(row);
}

function getOrCreateProxyRequest(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: {
    batchVersionId: string;
    assetId: string;
    contentFingerprint: string;
    colorSnapshot: ColorSnapshotInput;
    profileVersion: string;
    colorPipelineVersion: string;
    proxyKey: string;
    now?: () => Date;
  },
): BatchProxyRequestRow {
  const createdAt = nowIso(input.now);
  const existing = db.prepare(`
    SELECT * FROM batch_proxy_requests
    WHERE batchVersionId = ? AND assetId = ? AND proxyKey = ?
  `).get(input.batchVersionId, input.assetId, input.proxyKey) as BatchProxyRequestRow | undefined;
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'requested', ?, ?)
  `).run(
    id,
    projectId,
    batchId,
    input.batchVersionId,
    input.assetId,
    input.contentFingerprint,
    JSON.stringify(input.colorSnapshot),
    input.profileVersion,
    input.colorPipelineVersion,
    input.proxyKey,
    createdAt,
    createdAt,
  );
  return db.prepare(`SELECT * FROM batch_proxy_requests WHERE id = ?`).get(id) as BatchProxyRequestRow;
}

/**
 * ProxyMediaCache 对外的主入口:为明确选择的素材与色彩快照请求(或恢复)一个代理任务。
 * 一次调用原子完成"取或建请求 + 取或建 pending 缓存项 + 建立幂等任务"。
 *
 * 生命周期:
 * - 请求是稳定身份(UNIQUE(batchVersionId, assetId, proxyKey)),清理后保留;
 * - 清理把请求收敛为 cancelled 并删除/延后删除 cache;用户再次明确请求时,
 *   同一请求身份重新获得新 cache 引用与新任务(旧 succeeded/failed/cancelled
 *   任务不会被 requestKey 永久卡住,见 createBatchTask 的失效释放);
 * - 清理绝不会自动重建代理:只有用户再次显式调用本函数才会生成新任务。
 */
export function requestProxy(
  db: Database.Database,
  projectId: string,
  batchId: string,
  input: {
    assetId: string;
    contentFingerprint: string;
    colorSnapshot: ColorSnapshotInput;
    profileVersion: string;
    colorPipelineVersion: string;
    /** 代理归属的批次版本;缺省回退到批次当前版本(旧测试/旧调用兼容) */
    batchVersionId?: string;
    now?: () => Date;
  },
): { taskId: string; requestId: string; cacheItemId: string; proxyKey: string } {
  return db.transaction(() => {
    const batchVersionId = input.batchVersionId ?? (db.prepare(`
      SELECT currentVersionId FROM batch_productions WHERE id = ?
    `).get(batchId) as { currentVersionId: string | null } | undefined)?.currentVersionId ?? '';
    if (!batchVersionId) {
      throw new Error('代理请求必须归属于一个真实批次版本');
    }
    const lineage = db.prepare(`
      SELECT assets.contentFingerprint AS contentFingerprint, pool.colorJson AS colorJson
      FROM batch_production_versions version
      JOIN batch_productions batch ON batch.id = version.batchId
      JOIN batch_asset_pool_items pool ON pool.batchVersionId = version.id
      JOIN batch_assets assets ON assets.id = pool.assetId
      WHERE version.id = ? AND batch.id = ? AND batch.projectId = ?
        AND batch.deletedAt IS NULL AND pool.assetId = ? AND assets.projectId = ?
    `).get(batchVersionId, batchId, projectId, input.assetId, projectId) as {
      contentFingerprint: string;
      colorJson: string;
    } | undefined;
    if (!lineage) {
      throw new Error('代理请求的素材不属于该批次版本素材池');
    }
    if (!fingerprintsEqual(input.contentFingerprint, lineage.contentFingerprint)) {
      throw new Error('代理请求的原片指纹与项目素材身份不一致');
    }

    // 服务端按项目内受管 LUT 构建完整色彩快照:调用方只提交 lutId 时,
    // 指纹/色彩链版本/插值/SDR 合同在这里补齐;lutId 非空时指纹不可能为空。
    const colorSnapshot = resolveColorSnapshot(db, projectId, input.colorSnapshot);
    const frozenColorSnapshot = upgradeColorSnapshot(JSON.parse(lineage.colorJson));
    if (JSON.stringify(colorSnapshotIdentity(colorSnapshot)) !== JSON.stringify(colorSnapshotIdentity(frozenColorSnapshot))) {
      throw new Error('代理请求的色彩快照与批次版本冻结输入不一致');
    }
    const proxyKey = computeProxyKey({
      assetId: input.assetId,
      contentFingerprint: input.contentFingerprint,
      profileVersion: input.profileVersion,
      colorSnapshot,
      colorPipelineVersion: input.colorPipelineVersion,
    });

    const request = getOrCreateProxyRequest(db, projectId, batchId, {
      batchVersionId,
      assetId: input.assetId,
      contentFingerprint: input.contentFingerprint,
      colorSnapshot,
      profileVersion: input.profileVersion,
      colorPipelineVersion: input.colorPipelineVersion,
      proxyKey,
      now: input.now,
    });

    // 任务幂等键属于稳定请求，而不是全局 cache：两个批次版本可以共享同一份
    // 派生文件，但必须各自拥有可见、可暂停/取消/重试的任务。执行器在取得全局
    // 写槽后会复用已经 ready 的 cache，因此不会重复编码同一文件。
    const requestKey = `proxy_generate:${projectId}:${request.id}`;
    let cacheItem = getOrCreatePendingProxyCacheItem(db, projectId, {
      assetId: input.assetId,
      proxyKey,
      profileVersion: input.profileVersion,
      colorSnapshot,
      now: input.now,
    });

    // ready cache 是全局可复用的派生内容。同一 proxyKey 在另一个批次版本出现时，
    // 只建立该版本自己的稳定请求并直接收敛为 ready；绝不能把 ready 降级为 pending，
    // 也不能制造第二条 FFmpeg 任务去覆盖同一文件。
    if (cacheItem.status === 'ready') {
      if (cacheItem.pendingDeleteAt) {
        db.prepare(`UPDATE batch_proxy_cache_items SET pendingDeleteAt = NULL, updatedAt = ? WHERE id = ?`)
          .run(nowIso(input.now), cacheItem.id);
        cacheItem = { ...cacheItem, pendingDeleteAt: null };
      }
      db.prepare(`
        UPDATE batch_proxy_requests
        SET currentCacheItemId = ?, status = 'ready', updatedAt = ?
        WHERE id = ?
      `).run(cacheItem.id, nowIso(input.now), request.id);
    } else if (cacheItem.status === 'failed' || cacheItem.pendingDeleteAt) {
      db.prepare(`
        UPDATE batch_proxy_cache_items
        SET status = 'pending', mediaJson = '{}', fileSizeBytes = 0, checksum = NULL,
            pendingDeleteAt = NULL, updatedAt = ?
        WHERE id = ?
      `).run(nowIso(input.now), cacheItem.id);
      cacheItem = {
        ...cacheItem,
        status: 'pending',
        mediaJson: '{}',
        fileSizeBytes: 0,
        checksum: null,
        pendingDeleteAt: null,
      };
    }

    db.prepare(`
      UPDATE batch_proxy_requests
      SET currentCacheItemId = ?, status = ?, updatedAt = ?
      WHERE id = ?
    `).run(cacheItem.id, cacheItem.status === 'ready' ? 'ready' : 'requested', nowIso(input.now), request.id);

    const taskId = createBatchTask(db, projectId, {
      batchId,
      workType: 'proxy_generate',
      targetKind: 'proxy_request',
      targetId: request.id,
      requestKey,
      now: input.now,
    });
    return { taskId, requestId: request.id, cacheItemId: cacheItem.id, proxyKey };
  })();
}

export function getProxyRequest(
  db: Database.Database,
  projectId: string,
  requestId: string,
): BatchProxyRequestRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_proxy_requests WHERE id = ? AND projectId = ?
  `).get(requestId, projectId) as BatchProxyRequestRow | undefined;
}

export function listBatchVersionProxyRequests(
  db: Database.Database,
  batchVersionId: string,
): BatchProxyRequestRow[] {
  return db.prepare(`
    SELECT * FROM batch_proxy_requests WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as BatchProxyRequestRow[];
}

export function getProxyCacheItem(
  db: Database.Database,
  projectId: string,
  id: string,
): BatchProxyCacheItemRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_proxy_cache_items WHERE id = ? AND projectId = ?
  `).get(id, projectId) as BatchProxyCacheItemRow | undefined;
}

export function listProjectProxyCacheItems(db: Database.Database, projectId: string): BatchProxyCacheItemRow[] {
  return db.prepare(`
    SELECT * FROM batch_proxy_cache_items WHERE projectId = ? ORDER BY createdAt, id
  `).all(projectId) as BatchProxyCacheItemRow[];
}

/** 项目(或全局)代理缓存占用:只统计 ready 状态、尚未标记 pending-delete 的有效缓存。 */
export function getProxyCacheUsage(
  db: Database.Database,
  projectId?: string,
): { count: number; totalBytes: number } {
  const row = projectId
    ? db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(fileSizeBytes), 0) AS totalBytes
        FROM batch_proxy_cache_items WHERE projectId = ? AND status = 'ready' AND pendingDeleteAt IS NULL
      `).get(projectId) as { count: number; totalBytes: number }
    : db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(fileSizeBytes), 0) AS totalBytes
        FROM batch_proxy_cache_items WHERE status = 'ready' AND pendingDeleteAt IS NULL
      `).get() as { count: number; totalBytes: number };
  return row;
}

// 使用锁:Phase D 只承诺单进程内不会一边使用一边删除(§7),用进程内引用计数
// 实现即可;跨进程第二实例的占用协调是 Phase G 的范围。
// 读租约:预览等读取者持有;写租约:executor 从准备临时文件到原子发布 +
// ready 数据库更新完成期间持有。最后一个租约释放后,若该 cache 已标记
// pending-delete,则自动完成真正的删除(文件 + 记录),不需要用户再点一次清理。
const proxyLeaseRefCounts = new Map<string, { read: number; write: number }>();

function proxyLeaseState(cacheItemId: string): { read: number; write: number } {
  return proxyLeaseRefCounts.get(cacheItemId) ?? { read: 0, write: 0 };
}

function isProxyCacheItemInUse(cacheItemId: string): boolean {
  const state = proxyLeaseState(cacheItemId);
  return state.read > 0 || state.write > 0;
}

/**
 * 释放租约;若这是最后一个租约且缓存行已标记 pending-delete,立即完成真正的删除。
 * 自动完成是"释放后清理不要求用户再点一次"的关键:release 带着 db 句柄,
 * 在引用计数归零的瞬间执行受控删除。
 */
function releaseProxyLease(cacheItemId: string, kind: 'read' | 'write', db?: Database.Database): void {
  const state = proxyLeaseState(cacheItemId);
  if (kind === 'read') state.read = Math.max(0, state.read - 1);
  else state.write = Math.max(0, state.write - 1);
  if (state.read <= 0 && state.write <= 0) {
    proxyLeaseRefCounts.delete(cacheItemId);
    if (db) completePendingProxyDeletion(db, cacheItemId);
  } else {
    proxyLeaseRefCounts.set(cacheItemId, state);
  }
}

/** 预览等读取者持有一个代理缓存项的读取租约;清理会跳过并延后到释放后处理。 */
export function acquireProxyReadLease(cacheItemId: string, db?: Database.Database): () => void {
  const state = proxyLeaseState(cacheItemId);
  state.read += 1;
  proxyLeaseRefCounts.set(cacheItemId, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseProxyLease(cacheItemId, 'read', db);
  };
}

/** 生成/写入者持有写租约:从准备临时文件到原子发布与 ready 更新完成期间。 */
export function acquireProxyWriteLease(cacheItemId: string, db?: Database.Database): () => void {
  const state = proxyLeaseState(cacheItemId);
  state.write += 1;
  proxyLeaseRefCounts.set(cacheItemId, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseProxyLease(cacheItemId, 'write', db);
  };
}

/** 删除受控根下的正式文件与任何残留临时文件；失败时保留数据库行供下次重试。 */
function deleteControlledCacheFiles(relativePath: string): boolean {
  try {
    const absolute = resolveControlledProxyPath(relativePath);
    if (fs.existsSync(absolute)) {
      fs.unlinkSync(absolute);
    }
    // 清理 executor 崩溃/取消可能残留的同前缀临时文件(.tmp-<uuid>)
    const dir = path.dirname(absolute);
    const base = path.basename(absolute);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${base}.tmp-`)) {
          try {
            fs.unlinkSync(path.join(dir, entry));
          } catch {
            return false;
          }
        }
      }
    }
    return true;
  } catch {
    // 相对路径越界、符号链接、文件占用等异常：不删数据库行，留给排查/重试。
    return false;
  }
}

/**
 * 完成一次持久化 pending-delete:只删除仍标记 pendingDeleteAt 且当前没有
 * 任何租约的缓存项(文件 + 残留临时文件 + 记录)。返回是否真正删除。
 */
export function completePendingProxyDeletion(db: Database.Database, cacheItemId: string): boolean {
  if (isProxyCacheItemInUse(cacheItemId)) return false;
  const row = db.prepare(`
    SELECT * FROM batch_proxy_cache_items WHERE id = ?
  `).get(cacheItemId) as BatchProxyCacheItemRow | undefined;
  if (!row || !row.pendingDeleteAt) return false;
  if (!deleteControlledCacheFiles(row.relativePath)) return false;
  db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ? AND pendingDeleteAt IS NOT NULL`).run(cacheItemId);
  return true;
}

/**
 * 进程启动后的持久化清理恢复：进程内租约不会跨重启存活，因此重新打开数据库后
 * 可以逐条尝试完成 pending-delete。文件删除失败时记录仍保留，供下次启动/清理重试。
 */
export function completePendingProxyDeletions(db: Database.Database): number {
  const pendingIds = db.prepare(`
    SELECT id FROM batch_proxy_cache_items
    WHERE pendingDeleteAt IS NOT NULL
    ORDER BY pendingDeleteAt, id
  `).all() as Array<{ id: string }>;
  let deletedCount = 0;
  for (const { id } of pendingIds) {
    if (completePendingProxyDeletion(db, id)) deletedCount += 1;
  }
  return deletedCount;
}

/**
 * 把受管相对路径解析成文件系统绝对路径,复用与素材库同一套安全规则
 * (拒绝 `..`、绝对路径输入、越界和符号链接),并额外确认真的落在
 * storage/cache/proxies 根目录下——即使调用方传入的相对路径本身合法,
 * 也不允许指向代理根之外的任何受控 storage 子目录。
 */
export function resolveControlledProxyPath(relativePath: string): string {
  const root = dataRoot();
  const resolved = resolveStoragePath(root, relativePath);
  assertNoStorageSymlink(root, relativePath);
  const proxiesRoot = path.resolve(root, 'storage', 'cache', 'proxies');
  if (resolved !== proxiesRoot && !resolved.startsWith(proxiesRoot + path.sep)) {
    throw new Error('代理路径不在受控代理根目录下');
  }
  return resolved;
}

export interface CleanupProxyCacheResult {
  deletedCount: number;
  freedBytes: number;
  skippedCount: number;
}

/** 清理时找出引用这些缓存项的请求,并只取消相关的 proxy_generate 任务(不动批次)。 */
function cancelProxyTasksForRequests(db: Database.Database, projectId: string, requestIds: string[]): void {
  if (requestIds.length === 0) return;
  const placeholders = requestIds.map(() => '?').join(',');
  const tasks = db.prepare(`
    SELECT id FROM batch_tasks
    WHERE projectId = ? AND workType = 'proxy_generate' AND targetKind = 'proxy_request'
      AND targetId IN (${placeholders})
      AND status IN ('queued', 'running', 'failed')
  `).all(projectId, ...requestIds) as Array<{ id: string }>;
  for (const { id } of tasks) {
    try {
      cancelTask(db, projectId, id);
    } catch {
      // 竞态:任务刚好已进入终态,跳过即可(历史 requestKey 由 createBatchTask 失效释放)
    }
  }
}

/**
 * 清理代理缓存(按素材范围,或整个项目)。
 *
 * - 只删除受控代理根目录中的已核验缓存文件,拒绝符号链接、越界路径和任意绝对路径。
 * - 正在被读取或写入租约占用的缓存跳过并标记 pending-delete(持久化);
 *   最后一个租约释放时自动完成真正删除(见 releaseProxyLease),不需要用户再点一次。
 * - 被清理的请求收敛为 cancelled,相关 proxy_generate 任务被取消;
 *   清理绝不自动重建代理,用户再次显式请求时才重新生成。
 * - 返回实际删除数量、实际释放空间与跳过数量。
 */
export function cleanupProxyCache(
  db: Database.Database,
  projectId: string,
  options: { assetIds?: string[]; now?: () => Date } = {},
): CleanupProxyCacheResult {
  const updatedAt = nowIso(options.now);
  const candidates = (options.assetIds && options.assetIds.length > 0
    ? db.prepare(`
        SELECT * FROM batch_proxy_cache_items
        WHERE projectId = ? AND assetId IN (${options.assetIds.map(() => '?').join(',')})
      `).all(projectId, ...options.assetIds)
    : db.prepare(`SELECT * FROM batch_proxy_cache_items WHERE projectId = ?`).all(projectId)
  ) as BatchProxyCacheItemRow[];

  // 引用被清理 cache 的请求统一收敛为 cancelled,并只取消这些请求的代理任务
  const requestIds = (db.prepare(`
    SELECT id FROM batch_proxy_requests
    WHERE projectId = ? AND currentCacheItemId IN (${candidates.map(() => '?').join(',') || "''"})
  `).all(projectId, ...candidates.map(({ id }) => id)) as Array<{ id: string }>).map(({ id }) => id);
  if (requestIds.length > 0) {
    db.prepare(`
      UPDATE batch_proxy_requests SET status = 'cancelled', updatedAt = ? WHERE id IN (${requestIds.map(() => '?').join(',')})
    `).run(updatedAt, ...requestIds);
    cancelProxyTasksForRequests(db, projectId, requestIds);
  }

  let deletedCount = 0;
  let freedBytes = 0;
  let skippedCount = 0;

  for (const item of candidates) {
    if (isProxyCacheItemInUse(item.id)) {
      skippedCount += 1;
      if (!item.pendingDeleteAt) {
        db.prepare(`UPDATE batch_proxy_cache_items SET pendingDeleteAt = ? WHERE id = ?`).run(updatedAt, item.id);
      }
      continue;
    }
    if (!deleteControlledCacheFiles(item.relativePath)) {
      skippedCount += 1;
      continue;
    }
    db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(item.id);
    deletedCount += 1;
    freedBytes += item.fileSizeBytes;
  }

  return { deletedCount, freedBytes, skippedCount };
}

/**
 * 设置页"清理全部代理"入口:对每个当前拥有代理缓存的项目分别调用 cleanupProxyCache
 * 并汇总结果,而不是绕过项目作用域直接扫描文件系统——受控根目录之外的东西永远不碰,
 * 每个项目内部仍然遵守同样的使用锁与路径安全规则。
 */
export function cleanupAllProjectsProxyCache(
  db: Database.Database,
  options: { now?: () => Date } = {},
): CleanupProxyCacheResult {
  const projectIds = (db.prepare(`
    SELECT DISTINCT projectId FROM batch_proxy_cache_items
  `).all() as Array<{ projectId: string }>).map(({ projectId }) => projectId);

  let deletedCount = 0;
  let freedBytes = 0;
  let skippedCount = 0;
  for (const projectId of projectIds) {
    const result = cleanupProxyCache(db, projectId, { now: options.now });
    deletedCount += result.deletedCount;
    freedBytes += result.freedBytes;
    skippedCount += result.skippedCount;
  }
  return { deletedCount, freedBytes, skippedCount };
}

/** 测试专用:清空进程内使用锁状态,避免测试之间互相影响。 */
export function resetProxyLeasesForTests(): void {
  proxyLeaseRefCounts.clear();
}
