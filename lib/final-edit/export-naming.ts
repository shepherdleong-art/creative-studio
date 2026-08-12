import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FinalEditError } from './errors.ts';
import { previewExportBaseName } from './export-identity.ts';
import { assertSafeExportDirName } from '../project-export-dir.ts';
import { assertNoStorageSymlink } from './storage-path.ts';
import type { ExportIdentity } from './types.ts';

export interface ReservedPath {
  absolutePath: string;
  relativePath: string;
  filename: string;
}

export interface ReservedProjectExportTarget {
  videoRelativePath: string;
  coverRelativePath: string;
  reservationRelativePath: string;
  videoFilename: string;
  coverFilename: string;
  displayDirectory: string;
}

function assertSafeProjectId(projectId: string): void {
  if (!projectId || !/^[A-Za-z0-9._-]+$/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new FinalEditError('unsafe_path', '项目标识不能用于导出路径');
  }
}

function normalizeExtension(extension: string): string {
  if (!/^\.[A-Za-z0-9]{1,10}$/.test(extension)) {
    throw new FinalEditError('unsafe_path', '导出文件扩展名无效');
  }
  return extension.toLowerCase();
}

function storagePath(storageRoot: string, relativePath: string): string {
  try {
    return assertNoStorageSymlink(storageRoot, relativePath);
  } catch {
    throw new FinalEditError('unsafe_path', '导出路径不在 storage 内');
  }
}

export function buildExportBaseName(identity: ExportIdentity): string {
  if (!identity.productCode.trim()) throw new FinalEditError('product_code_required', '请先填写商品编码');
  const baseName = previewExportBaseName(identity.productCode, identity.taskDate);
  if (!baseName) {
    if (!/^\d{8}$/.test(identity.taskDate)) throw new FinalEditError('invalid_task_date', '任务日期格式无效');
    throw new FinalEditError('product_code_required', '请先填写商品编码');
  }
  return baseName;
}

export function reserveExportPath(storageRoot: string, identity: ExportIdentity, extension: string): ReservedPath {
  assertSafeProjectId(identity.projectId);
  assertSafeExportDirName(identity.exportDirName || identity.projectId);
  const normalizedExtension = normalizeExtension(extension);
  const resolvedStorageRoot = path.resolve(storageRoot);
  const exportDir = path.resolve(resolvedStorageRoot, 'projects', identity.exportDirName || identity.projectId, '成片');
  if (!exportDir.startsWith(`${resolvedStorageRoot}${path.sep}`)) {
    throw new FinalEditError('unsafe_path', '导出目录不在 storage 内');
  }
  assertNoStorageSymlink(resolvedStorageRoot, exportDir, { allowAbsolute: true });
  fs.mkdirSync(exportDir, { recursive: true });
  assertNoStorageSymlink(resolvedStorageRoot, exportDir, { allowAbsolute: true });
  const baseName = buildExportBaseName(identity);

  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const suffix = sequence === 1 ? '' : `-${String(sequence).padStart(2, '0')}`;
    const filename = `${baseName}${suffix}${normalizedExtension}`;
    const absolutePath = path.join(exportDir, filename);
    try {
      const descriptor = fs.openSync(absolutePath, 'wx');
      fs.closeSync(descriptor);
      return {
        absolutePath,
        relativePath: path.relative(resolvedStorageRoot, absolutePath),
        filename,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new FinalEditError('export_name_exhausted', '同名成片数量过多，无法预留导出路径');
}

export function reserveProjectExportTarget(storageRoot: string, identity: ExportIdentity, options: { blockedRelativePaths?: ReadonlySet<string> } = {}): ReservedProjectExportTarget {
  assertSafeProjectId(identity.projectId);
  assertSafeExportDirName(identity.exportDirName || identity.projectId);
  const resolvedStorageRoot = path.resolve(storageRoot);
  const exportDir = path.resolve(resolvedStorageRoot, 'projects', identity.exportDirName || identity.projectId, '成片');
  if (!exportDir.startsWith(`${resolvedStorageRoot}${path.sep}`)) throw new FinalEditError('unsafe_path', '导出目录不在 storage 内');
  assertNoStorageSymlink(resolvedStorageRoot, exportDir, { allowAbsolute: true });
  fs.mkdirSync(exportDir, { recursive: true });
  assertNoStorageSymlink(resolvedStorageRoot, exportDir, { allowAbsolute: true });
  const baseName = buildExportBaseName(identity);

  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const suffix = sequence === 1 ? '' : `-${String(sequence).padStart(2, '0')}`;
    const candidateBase = `${baseName}${suffix}`;
    const videoFilename = `${candidateBase}.mp4`;
    const coverFilename = `${candidateBase}-封面.jpg`;
    const reservationFilename = `.${candidateBase}.publish.lock`;
    const videoAbsolutePath = path.join(exportDir, videoFilename);
    const coverAbsolutePath = path.join(exportDir, coverFilename);
    const reservationAbsolutePath = path.join(exportDir, reservationFilename);
    let reservationDescriptor: number | null = null;
    const videoRelativePath = path.relative(resolvedStorageRoot, videoAbsolutePath);
    const coverRelativePath = path.relative(resolvedStorageRoot, coverAbsolutePath);
    if (options.blockedRelativePaths?.has(videoRelativePath) || options.blockedRelativePaths?.has(coverRelativePath)) continue;
    if (fs.existsSync(videoAbsolutePath) || fs.existsSync(coverAbsolutePath)) continue;
    try {
      reservationDescriptor = fs.openSync(reservationAbsolutePath, 'wx');
      fs.closeSync(reservationDescriptor);
      return {
        videoRelativePath,
        coverRelativePath,
        reservationRelativePath: path.relative(resolvedStorageRoot, reservationAbsolutePath),
        videoFilename,
        coverFilename,
        displayDirectory: `工作台/${identity.taskName}/成片/`,
      };
    } catch (error) {
      const ownsReservation = reservationDescriptor != null;
      if (reservationDescriptor != null) fs.closeSync(reservationDescriptor);
      if (ownsReservation) {
        try { fs.unlinkSync(reservationAbsolutePath); } catch { /* already absent */ }
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new FinalEditError('export_name_exhausted', '同名成片数量过多，无法预留导出路径');
}

export function releaseReservedExportTarget(storageRoot: string, target: ReservedProjectExportTarget): void {
  const reservationPath = storagePath(storageRoot, target.reservationRelativePath);
  try { fs.unlinkSync(reservationPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function publishReservedExportTarget(input: {
  storageRoot: string;
  target: ReservedProjectExportTarget;
  internalVideoRelativePath: string;
  internalCoverRelativePath: string;
}): Promise<ReservedProjectExportTarget> {
  const videoSource = storagePath(input.storageRoot, input.internalVideoRelativePath);
  const coverSource = storagePath(input.storageRoot, input.internalCoverRelativePath);
  const videoTarget = storagePath(input.storageRoot, input.target.videoRelativePath);
  const coverTarget = storagePath(input.storageRoot, input.target.coverRelativePath);
  const reservation = storagePath(input.storageRoot, input.target.reservationRelativePath);
  const videoSourceStat = await fs.promises.stat(videoSource);
  const coverSourceStat = await fs.promises.stat(coverSource);
  if (!videoSourceStat.isFile() || !coverSourceStat.isFile() || videoSourceStat.size <= 0 || coverSourceStat.size <= 0) {
    throw new FinalEditError('render_artifact_invalid', '内部渲染产物缺失或为空');
  }
  const targetReady = (targetPath: string, sourceSize: number) => {
    try { return fs.lstatSync(targetPath).isFile() && fs.statSync(targetPath).size === sourceSize; }
    catch { return false; }
  };
  if (!fs.existsSync(reservation) && targetReady(videoTarget, videoSourceStat.size) && targetReady(coverTarget, coverSourceStat.size)) {
    return input.target;
  }
  if (!fs.existsSync(reservation)) throw new FinalEditError('export_reservation_lost', '导出路径预留已失效');

  const unique = crypto.randomUUID();
  const videoTemporary = `${videoTarget}.${unique}.tmp`;
  const coverTemporary = `${coverTarget}.${unique}.tmp`;
  let videoPublished = false;
  let coverPublished = false;
  try {
    await Promise.all([
      fs.promises.copyFile(videoSource, videoTemporary, fs.constants.COPYFILE_EXCL),
      fs.promises.copyFile(coverSource, coverTemporary, fs.constants.COPYFILE_EXCL),
    ]);
    if ((await fs.promises.stat(videoTemporary)).size !== videoSourceStat.size || (await fs.promises.stat(coverTemporary)).size !== coverSourceStat.size) {
      throw new FinalEditError('render_artifact_invalid', '发布产物大小校验失败');
    }
    await fs.promises.link(videoTemporary, videoTarget);
    videoPublished = true;
    await fs.promises.link(coverTemporary, coverTarget);
    coverPublished = true;
    await Promise.all([fs.promises.unlink(videoTemporary), fs.promises.unlink(coverTemporary), fs.promises.unlink(reservation)]);
    return input.target;
  } catch (error) {
    await Promise.allSettled([fs.promises.unlink(videoTemporary), fs.promises.unlink(coverTemporary)]);
    if (videoPublished) await fs.promises.unlink(videoTarget).catch(() => undefined);
    if (coverPublished) await fs.promises.unlink(coverTarget).catch(() => undefined);
    throw error;
  }
}

export async function restorePublishedExportReservation(storageRoot: string, target: ReservedProjectExportTarget): Promise<void> {
  const videoPath = storagePath(storageRoot, target.videoRelativePath);
  const coverPath = storagePath(storageRoot, target.coverRelativePath);
  const reservationPath = storagePath(storageRoot, target.reservationRelativePath);
  await Promise.allSettled([fs.promises.unlink(videoPath), fs.promises.unlink(coverPath)]);
  try { await fs.promises.writeFile(reservationPath, '', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
