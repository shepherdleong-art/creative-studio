import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath, toStorageRelativePath } from '../media-core/storage-path.ts';
import { computeFingerprintFromFile } from './fingerprint.ts';

/** Export metadata supplied by the batch integration layer. */
export interface BatchExportIdentity {
  projectId: string;
  batchId: string;
  productCode: string;
  /** Date/time or an already formatted Shanghai date (`YYYYMMDD`). */
  taskDate?: Date | string;
  planSeq: number;
  outputVersion: number;
  /** 成片导出目录名(`<产品编码>-<YYYYMMDD>`),由调用方解析后传入。 */
  exportDirName: string;
}

export interface BatchExportTarget {
  storageRoot: string;
  exportSequence: number;
  baseName: string;
  videoAbsolutePath: string;
  coverAbsolutePath: string;
  reservationAbsolutePath: string;
  videoRelativePath: string;
  coverRelativePath: string;
  reservationRelativePath: string;
  videoFilename: string;
  coverFilename: string;
}

export interface BatchExportRenderContract {
  audioMode: 'narration' | 'silent_placeholder';
  productionReady: boolean;
}

export interface BatchExportResult {
  videoAbsolutePath: string;
  coverAbsolutePath: string;
  videoRelativePath: string;
  coverRelativePath: string;
  videoChecksum: string;
  coverChecksum: string;
  exportSequence: number;
}

function assertSafePathSegment(value: string, label: string): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} 不能包含路径分隔符或路径穿越`);
  }
}

function safeFilenameSegment(raw: string, label: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${label} 不能为空`);
  const normalized = raw.normalize('NFKC').trim();
  const cleaned = normalized
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Filename-only fields are sanitized, matching the existing export
    // naming contract. Path-owned fields (projectId/batchId) remain strict
    // segments and are checked by assertSafePathSegment below.
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`${label} 不能为空`);
  return cleaned;
}

function dateInShanghai(value?: Date | string): string {
  if (typeof value === 'string' && /^\d{8}$/.test(value)) return value;
  const date = value == null ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('任务日期无效');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new Error('任务日期无效');
  return `${year}${month}${day}`;
}

function ensureDirectory(root: string, relativePath: string): string {
  const absolute = resolveStoragePath(root, relativePath);
  assertNoStorageSymlink(root, relativePath);
  fs.mkdirSync(absolute, { recursive: true });
  assertNoStorageSymlink(root, relativePath);
  return absolute;
}

function lstatExists(filePath: string): fs.Stats | null {
  try { return fs.lstatSync(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertRegularFile(filePath: string, label: string): fs.Stats {
  const stat = lstatExists(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} 必须是非空普通文件且不能是符号链接`);
  }
  return stat;
}

function resolveSourcePath(storageRoot: string, source: string): string {
  const absolute = resolveStoragePath(storageRoot, source, { allowAbsolute: true });
  assertNoStorageSymlink(storageRoot, source, { allowAbsolute: true });
  return absolute;
}

function assertTargetPathsUnderStorage(storageRoot: string, target: BatchExportTarget): void {
  const pairs: Array<[string, string, string]> = [
    [target.videoRelativePath, target.videoAbsolutePath, '视频目标'],
    [target.coverRelativePath, target.coverAbsolutePath, '封面目标'],
    [target.reservationRelativePath, target.reservationAbsolutePath, '导出预留'],
  ];
  for (const [relativePath, absolutePath, label] of pairs) {
    const expected = resolveStoragePath(storageRoot, relativePath);
    if (path.resolve(absolutePath) !== expected) throw new Error(`${label} 路径与 storage 相对路径不一致`);
  }
}

/**
 * 与单条模式同一套命名合约(`lib/final-edit/export-naming.ts` 的
 * `成片-<产品编码>-<YYYYMMDD>`),后面接两位成片序号以区分同批次的多条成片。
 * 序号与检查页的「成片 01/02」一一对应。
 */
function buildBaseName(identity: BatchExportIdentity): string {
  if (!Number.isInteger(identity.planSeq) || identity.planSeq < 1) throw new Error('plan 序号必须是正整数');
  if (!Number.isInteger(identity.outputVersion) || identity.outputVersion < 1) throw new Error('output version 必须是正整数');
  const productCode = safeFilenameSegment(identity.productCode, 'productCode');
  return `成片-${productCode}-${dateInShanghai(identity.taskDate)}-${String(identity.planSeq).padStart(2, '0')}`;
}

/**
 * Atomically reserves a paired video/cover name in the batch export folder.
 * The lock file is deliberately separate from the output files, so a failed
 * render never makes an old formal artifact appear to be a new one.
 */
export function reserveBatchExportTarget(input: BatchExportIdentity & { storageRoot?: string }): BatchExportTarget {
  assertSafePathSegment(input.projectId, '项目标识');
  assertSafePathSegment(input.batchId, '批次标识');
  assertSafePathSegment(input.exportDirName, '导出目录名');
  const storageRoot = path.resolve(input.storageRoot ?? path.join(dataRoot(), 'storage'));
  const baseName = buildBaseName(input);
  // 与单条模式同一个成品目录:一个项目的成片(不论单条还是批量)集中存放。
  // 重名由下面的占位循环 + .lock 独占创建保证不会互相覆盖。
  const relativeDir = path.join('projects', input.exportDirName, '成片');
  const exportDir = ensureDirectory(storageRoot, relativeDir);

  for (let exportSequence = 1; exportSequence < 100_000; exportSequence += 1) {
    // 首次导出不带后缀;重复导出同一条成片才往后排 -02、-03(与单条一致)
    const sequenceSuffix = exportSequence === 1 ? '' : `-${String(exportSequence).padStart(2, '0')}`;
    const candidateBase = `${baseName}${sequenceSuffix}`;
    const videoFilename = `${candidateBase}.mp4`;
    const coverFilename = `${candidateBase}-封面.jpg`;
    const reservationFilename = `.${candidateBase}.publish.lock`;
    const videoAbsolutePath = path.join(exportDir, videoFilename);
    const coverAbsolutePath = path.join(exportDir, coverFilename);
    const reservationAbsolutePath = path.join(exportDir, reservationFilename);
    if (lstatExists(videoAbsolutePath) || lstatExists(coverAbsolutePath) || lstatExists(reservationAbsolutePath)) continue;
    assertNoStorageSymlink(storageRoot, relativeDir);
    try {
      const fd = fs.openSync(reservationAbsolutePath, 'wx');
      fs.closeSync(fd);
      return {
        storageRoot,
        exportSequence,
        baseName: candidateBase,
        videoAbsolutePath,
        coverAbsolutePath,
        reservationAbsolutePath,
        videoRelativePath: toStorageRelativePath(storageRoot, videoAbsolutePath),
        coverRelativePath: toStorageRelativePath(storageRoot, coverAbsolutePath),
        reservationRelativePath: toStorageRelativePath(storageRoot, reservationAbsolutePath),
        videoFilename,
        coverFilename,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('批量导出文件名预留次数已耗尽');
}

export function releaseBatchExportReservation(storageRoot: string, target: BatchExportTarget): void {
  const reservation = resolveStoragePath(storageRoot, target.reservationRelativePath);
  assertNoStorageSymlink(storageRoot, target.reservationRelativePath);
  try { fs.unlinkSync(reservation); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function copyAndHash(source: string, destination: string, label: string): Promise<string> {
  assertRegularFile(source, label);
  const sourceFingerprint = await computeFingerprintFromFile(source);
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  try {
    const copiedStat = assertRegularFile(destination, `${label} 发布临时文件`);
    const copiedFingerprint = await computeFingerprintFromFile(destination);
    if (copiedStat.size <= 0 || copiedFingerprint !== sourceFingerprint) {
      throw new Error(`${label} 发布前指纹校验失败`);
    }
    return copiedFingerprint;
  } catch (error) {
    await fsp.unlink(destination).catch(() => undefined);
    throw error;
  }
}

/**
 * Publishes both files using copy-to-temp + hard-link (no-replace) semantics.
 * Existing output files are never overwritten, even when a concurrent caller
 * races the reservation loop. No artifact database row is written here.
 */
export async function publishBatchExportTarget(input: {
  storageRoot?: string;
  target: BatchExportTarget;
  videoSource: string;
  coverSource: string;
  renderResult?: BatchExportRenderContract;
  /** Kept as an explicit call-site assertion; formal publishing is always gated. */
  productionReady?: boolean;
  expectedVideoChecksum?: string;
  expectedCoverChecksum?: string;
}): Promise<BatchExportResult> {
  const storageRoot = path.resolve(input.storageRoot ?? input.target.storageRoot ?? path.join(dataRoot(), 'storage'));
  if (input.productionReady !== true || !input.renderResult || input.renderResult.audioMode !== 'narration' || input.renderResult.productionReady !== true) {
    throw new Error('正式批量发布必须提供 productionReady=true 且已核验 narration;静音占位不能发布');
  }
  const target = input.target;
  assertTargetPathsUnderStorage(storageRoot, target);
  assertNoStorageSymlink(storageRoot, target.reservationRelativePath);
  assertNoStorageSymlink(storageRoot, target.videoRelativePath);
  assertNoStorageSymlink(storageRoot, target.coverRelativePath);
  const reservationStat = lstatExists(target.reservationAbsolutePath);
  if (!reservationStat || reservationStat.isSymbolicLink() || !reservationStat.isFile()) throw new Error('批量导出预留已失效');
  const videoSource = resolveSourcePath(storageRoot, input.videoSource);
  const coverSource = resolveSourcePath(storageRoot, input.coverSource);
  assertRegularFile(videoSource, '视频源');
  assertRegularFile(coverSource, '封面源');
  if (lstatExists(target.videoAbsolutePath) || lstatExists(target.coverAbsolutePath)) throw new Error('正式导出目标已存在,不得覆盖');

  const unique = crypto.randomUUID();
  const videoTemp = `${target.videoAbsolutePath}.${unique}.tmp`;
  const coverTemp = `${target.coverAbsolutePath}.${unique}.tmp`;
  let videoPublished = false;
  let coverPublished = false;
  try {
    const [videoChecksum, coverChecksum] = await Promise.all([
      copyAndHash(videoSource, videoTemp, '视频'),
      copyAndHash(coverSource, coverTemp, '封面'),
    ]);
    if (input.expectedVideoChecksum && input.expectedVideoChecksum !== videoChecksum) throw new Error('视频源指纹与渲染结果不一致');
    if (input.expectedCoverChecksum && input.expectedCoverChecksum !== coverChecksum) throw new Error('封面源指纹与渲染结果不一致');
    assertNoStorageSymlink(storageRoot, target.videoRelativePath);
    assertNoStorageSymlink(storageRoot, target.coverRelativePath);
    if (lstatExists(target.videoAbsolutePath) || lstatExists(target.coverAbsolutePath)) throw new Error('正式导出目标已存在,不得覆盖');
    await fsp.link(videoTemp, target.videoAbsolutePath);
    videoPublished = true;
    await fsp.link(coverTemp, target.coverAbsolutePath);
    coverPublished = true;
    await Promise.all([fsp.unlink(videoTemp), fsp.unlink(coverTemp), fsp.unlink(target.reservationAbsolutePath)]);
    return {
      videoAbsolutePath: target.videoAbsolutePath,
      coverAbsolutePath: target.coverAbsolutePath,
      videoRelativePath: target.videoRelativePath,
      coverRelativePath: target.coverRelativePath,
      videoChecksum,
      coverChecksum,
      exportSequence: target.exportSequence,
    };
  } catch (error) {
    await Promise.allSettled([fsp.unlink(videoTemp), fsp.unlink(coverTemp)]);
    if (videoPublished) await fsp.unlink(target.videoAbsolutePath).catch(() => undefined);
    if (coverPublished) await fsp.unlink(target.coverAbsolutePath).catch(() => undefined);
    throw error;
  }
}

// Descriptive aliases keep the integration seam discoverable without adding a
// second implementation or changing the no-overwrite contract.
export const reserveBatchExportPath = reserveBatchExportTarget;
export const publishBatchExport = publishBatchExportTarget;
export const releaseBatchExport = releaseBatchExportReservation;
