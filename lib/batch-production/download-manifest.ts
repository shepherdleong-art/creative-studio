import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink } from '../media-core/storage-path.ts';
import { registerManagedFile, requireAccessContext } from '../media-core/access-context.ts';
import { getBatchWorkspace, type BatchOutputCardView } from './batch-workspace.ts';
import { BatchDomainError } from './errors.ts';

/**
 * 本批次「可下载文件清单」（11 号票）。
 *
 * 规格「导出预览与一键下载全部」：
 * - 只列**当前正式产物**（`batch_output_plans.currentArtifactId` 指向的视频 + 同一导出对的封面），
 *   从没导出过的成片不出现；
 * - 修改未重新导出时给**上一版正式产物**（正式产物只在导出时新增，编辑不会覆盖它）；
 * - 按选项筛视频和封面（成片和封面 / 只要成片 / 只要封面）；
 * - 每项带文件名和大小；
 * - 身份与归属由调用路由通过 `withTeamRoute` 检查，本模块只做纯数据。
 *
 * ZIP 路由与轻客户端交付共用**同一个 builder** —— 这是「ZIP 内容与清单一致」
 * 的结构性保证：ZIP 分支不允许自己再查一遍产物。
 */

export const BATCH_DOWNLOAD_SCOPES = ['both', 'video', 'cover'] as const;
export type BatchDownloadScope = typeof BATCH_DOWNLOAD_SCOPES[number];

export const BATCH_NO_EXPORTED_FILMS_MESSAGE = '还没有导出过的成片';

export interface BatchDownloadItem {
  planId: string;
  seq: number;
  scriptTitle: string;
  kind: 'video' | 'cover';
  /** 正式产物文件名（导出命名合约生成，服务端是唯一来源）。 */
  filename: string;
  /**
   * 下载根下的相对名：`<导出身份目录>/<两位序号>-v<成片版本>/<文件名>`。
   * 按项目与导出版本分目录，重名天然不冲突；同名不覆盖仍由落盘端保证。
   */
  relativeName: string;
  /** 字节数（现场 lstat，不信任数据库登记值）。 */
  byteSize: number;
  /** 裸 sha256（64 位小写 hex），轻客户端校验用。 */
  sha256: string;
  /** 正式产物登记的 `sha256:<hex>` 指纹。 */
  checksum: string;
  /** 这套产物属于第几版成片（成片版本号，不是第几次导出）。 */
  outputVersionNumber: number;
  /** true = 「改过但还没重新导出」，给的是上一版正式产物。 */
  outdated: boolean;
}

export interface BatchDownloadManifest {
  batchId: string;
  projectId: string;
  scope: BatchDownloadScope;
  /** 下载根下按项目分的目录名（导出身份目录名）。 */
  exportDirName: string;
  /** 清单里每一条都是「修改未导出」的上一版正式产物时为 true。 */
  outdated: boolean;
  items: BatchDownloadItem[];
  totalBytes: number;
}

export interface BatchDownloadManifestOptions {
  scope?: BatchDownloadScope | string | null;
  /** 覆盖 storage 根（测试与隔离运行用）。 */
  storageRoot?: string;
}

/** 受管文件登记角色：主动下载（ZIP）/ 轻客户端交付 / 两者。 */
export type BatchDownloadReferenceMode = 'export' | 'delivery' | 'both';

/** 清单项的内部扩展：storage 路径与 artifact 身份绝不进 HTTP 响应。 */
interface ResolvedDownloadItem {
  item: BatchDownloadItem;
  storageRelativePath: string;
  artifactId: string;
}

const HEX64 = /^[a-f0-9]{64}$/;

export function normalizeBatchDownloadScope(value: unknown): BatchDownloadScope {
  if (value === undefined || value === null || value === '') return 'both';
  if (typeof value === 'string' && (BATCH_DOWNLOAD_SCOPES as readonly string[]).includes(value)) {
    return value as BatchDownloadScope;
  }
  throw new BatchDomainError('invalid_input', '下载范围只能是 both / video / cover');
}

/** `sha256:<hex>` 或裸 hex → 裸 hex；损坏的指纹按域错误拒绝，不静默放行。 */
function sha256FromChecksum(checksum: string): string {
  const value = checksum.includes(':') ? checksum.slice(checksum.indexOf(':') + 1) : checksum;
  if (!HEX64.test(value)) throw new BatchDomainError('conflict', '正式产物的内容指纹已损坏');
  return value;
}

function fileByteSize(storageRoot: string, relativePath: string): number {
  const absolute = assertNoStorageSymlink(storageRoot, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new BatchDomainError('not_found', '正式产物文件不存在或不可读');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new BatchDomainError('not_found', '正式产物文件不存在或不可读');
  }
  return stat.size;
}

function readOutputVersionNumber(db: Database.Database, outputVersionId: string): number {
  const row = db.prepare(`SELECT versionNumber FROM batch_output_versions WHERE id = ?`)
    .get(outputVersionId) as { versionNumber: number } | undefined;
  return row?.versionNumber ?? 0;
}

function itemsForCard(
  db: Database.Database,
  storageRoot: string,
  exportDirName: string,
  card: BatchOutputCardView,
  scope: BatchDownloadScope,
): ResolvedDownloadItem[] {
  const formal = card.currentFormalArtifact;
  if (!formal) return [];
  const wanted: Array<'video' | 'cover'> = scope === 'both' ? ['video', 'cover'] : [scope];
  const resolved: ResolvedDownloadItem[] = [];
  for (const kind of wanted) {
    const artifact = kind === 'video' ? formal.video : formal.cover;
    if (!artifact) continue;
    const filename = path.posix.basename(artifact.relativePath.split(path.sep).join('/'));
    const outputVersionNumber = readOutputVersionNumber(db, artifact.outputVersionId);
    resolved.push({
      storageRelativePath: artifact.relativePath,
      artifactId: artifact.id,
      item: {
        planId: card.planId,
        seq: card.seq,
        scriptTitle: card.scriptTitle,
        kind,
        filename,
        relativeName: `${exportDirName}/${String(card.seq).padStart(2, '0')}-v${outputVersionNumber}/${filename}`,
        byteSize: fileByteSize(storageRoot, artifact.relativePath),
        sha256: sha256FromChecksum(artifact.checksum),
        checksum: artifact.checksum,
        outputVersionNumber,
        outdated: card.formalOutdated,
      },
    });
  }
  return resolved;
}

function resolveBatchDownloadItems(
  db: Database.Database,
  projectId: string,
  batchId: string,
  options: BatchDownloadManifestOptions,
): { manifest: BatchDownloadManifest; resolved: ResolvedDownloadItem[] } {
  const scope = normalizeBatchDownloadScope(options.scope);
  const storageRoot = path.resolve(options.storageRoot ?? path.join(dataRoot(), 'storage'));
  // 复用工作区聚合：formalOutdated / currentFormalArtifact / 序号 / 脚本名只在这里算一次，
  // 清单与页面卡片不会出现两套口径。
  const workspace = getBatchWorkspace(db, projectId, batchId);
  const exportDirName = workspace.exportDirName || workspace.batch.id;
  const resolved: ResolvedDownloadItem[] = [];
  for (const card of workspace.cards) {
    resolved.push(...itemsForCard(db, storageRoot, exportDirName, card, scope));
  }
  const items = resolved.map((entry) => entry.item);
  return {
    manifest: {
      batchId,
      projectId,
      scope,
      exportDirName,
      outdated: items.length > 0 && items.every((item) => item.outdated),
      items,
      totalBytes: items.reduce((sum, item) => sum + item.byteSize, 0),
    },
    resolved,
  };
}

/**
 * 构建本批次可下载文件清单。没有任何当前正式产物时返回空 `items`
 * （路由据此给「还没有导出过的成片」，而不是 500）。
 */
export function buildBatchDownloadManifest(
  db: Database.Database,
  projectId: string,
  batchId: string,
  options: BatchDownloadManifestOptions = {},
): BatchDownloadManifest {
  return resolveBatchDownloadItems(db, projectId, batchId, options).manifest;
}

/**
 * ZIP 用：清单 + 每项在 storage 里的确切绝对路径。
 * 与 HTTP 清单走同一个 builder，所以「ZIP 内容与清单一致」是结构性的，
 * 不靠两份查询各自维护。
 */
export function resolveBatchDownloadFiles(
  db: Database.Database,
  projectId: string,
  batchId: string,
  options: BatchDownloadManifestOptions = {},
): { manifest: BatchDownloadManifest; files: Array<{ absolutePath: string; filename: string }> } {
  const { manifest, resolved } = resolveBatchDownloadItems(db, projectId, batchId, options);
  const storageRoot = path.resolve(options.storageRoot ?? path.join(dataRoot(), 'storage'));
  return {
    manifest,
    files: resolved.map((entry) => ({
      absolutePath: assertNoStorageSymlink(storageRoot, entry.storageRelativePath),
      filename: entry.item.relativeName,
    })),
  };
}

/**
 * 把清单里的正式产物登记为受管文件（11 号票）。
 *
 * 两条链路共用这一个登记入口，与 `lib/creative-canvas/export.ts` 的 ZIP 先例一致：
 * - `export`   —— 用户主动下载（浏览器 ZIP）。`buildGenericZipStream` 只认已登记受管文件，
 *                 所以 ZIP 之前必须先登记；这一条不进入设备的自动交付清单。
 * - `delivery` —— 轻客户端一键下载全部：现有交付下载（`/api/team/downloads`）会接手，
 *                 不另造下载链路。「本机已下载成功跳过」由设备回执保证
 *                 （completed / suppressed 不再出现在清单里）；「失败只补下载、
 *                 不重新渲染」由 `state='failed'` 回执重新出现保证。
 *
 * 登记是幂等的：同一文件重复登记只补引用，不新增文件版本。
 * 这里只登记**已存在**的正式产物，绝不触发任何渲染。
 */
export async function registerBatchDownloadFiles(
  db: Database.Database,
  projectId: string,
  batchId: string,
  options: BatchDownloadManifestOptions & { references?: BatchDownloadReferenceMode } = {},
): Promise<{
  manifest: BatchDownloadManifest;
  files: Array<{ absolutePath: string; filename: string }>;
  registeredFileIds: string[];
}> {
  const mode: BatchDownloadReferenceMode = options.references ?? 'both';
  const { manifest, resolved } = resolveBatchDownloadItems(db, projectId, batchId, options);
  const storageRoot = path.resolve(options.storageRoot ?? path.join(dataRoot(), 'storage'));
  const files = resolved.map((entry) => ({
    absolutePath: assertNoStorageSymlink(storageRoot, entry.storageRelativePath),
    filename: entry.item.relativeName,
  }));
  const access = requireAccessContext();
  if (access.kind !== 'team' || resolved.length === 0) {
    return { manifest, files, registeredFileIds: [] };
  }
  const roles: Array<'export' | 'delivery'> = mode === 'both' ? ['export', 'delivery'] : [mode];
  const registeredFileIds: string[] = [];
  for (const [index, entry] of resolved.entries()) {
    const fileId = registerManagedFile({
      absolutePath: files[index].absolutePath,
      mimeType: entry.item.kind === 'video' ? 'video/mp4' : 'image/jpeg',
      references: roles.map((role) => ({
        resourceType: 'batch_artifact', resourceId: entry.artifactId, role, pinKind: 'export' as const,
      })),
    });
    if (fileId) registeredFileIds.push(fileId);
  }
  return { manifest, files, registeredFileIds };
}
