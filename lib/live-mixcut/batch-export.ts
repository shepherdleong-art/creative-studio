import { productionCodeSuffix, withProductionCodes, type ProductionCodes } from '../media-core/production-codes.ts';
import { formulaExportSuffix, type FormulaExportIdentity } from '../media-core/export-identity.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';
import { assertNoStorageSymlink, resolveStoragePath, toStorageRelativePath } from '../media-core/storage-path.ts';
import { LIVE_MIXCUT_ARCHIVE_FOLDER, liveMixcutExportRelativeDir,
  liveMixcutVersionName, liveMixcutVersionSuffixPattern } from './export-paths.ts';
import { computeFingerprintFromFile } from './fingerprint.ts';

/** Export metadata supplied by the batch integration layer. */
export interface BatchExportIdentity {
  productionCodes?: ProductionCodes;
  formulaIdentity?: FormulaExportIdentity;
  projectId: string;
  batchId: string;
  productCode: string;
  /** Date/time or an already formatted Shanghai date (`YYYYMMDD`). */
  taskDate?: Date | string;
  planSeq: number;
  outputVersion: number;
  /** 任务导出根目录名，由调用方解析后传入。 */
  exportDirName: string;
  /** 生产身份基础名（无「成片-」前缀），来自 `project_export_identities` 冻结身份。缺省回退旧命名。 */
  baseName?: string;
}

export interface BatchExportTarget {
  storageRoot: string;
  /** 同一套导出身份的版本号；1 不带后缀，2 起叫 `-v2`。 */
  exportSequence: number;
  baseName: string;
  /** 不含版本号的导出身份键；同一键的再导出接着排版本号。 */
  exportKey: string;
  videoAbsolutePath: string;
  coverAbsolutePath: string;
  reservationAbsolutePath: string;
  videoRelativePath: string;
  coverRelativePath: string;
  reservationRelativePath: string;
  videoFilename: string;
  coverFilename: string;
}

/** 上一版被挪进「旧版」的文件；发布成功后由集成层同步正式产物的路径。 */
export interface BatchExportArchivedFile {
  fromRelativePath: string;
  toRelativePath: string;
  kind: 'video' | 'cover';
}

export interface BatchExportRenderContract {
  productionCodes?: ProductionCodes;
  formulaIdentity?: FormulaExportIdentity;
  audioMode: 'narration' | 'source' | 'mixed' | 'silent_placeholder';
  productionReady: boolean;
  fullRenderContractHash?: string;
  formulaExecution?: { stageId: string; contentContractHash: string };
  /** 渲染时冻结的成片编辑修订号;旧候选允许缺省并按 0 处理。 */
  editRevision?: number;
  /** 渲染时冻结的封面 arrangement.cover.timeUs;旧候选允许缺省。 */
  coverTimeUs?: number;
}

export interface BatchExportResult {
  videoAbsolutePath: string;
  coverAbsolutePath: string;
  videoRelativePath: string;
  coverRelativePath: string;
  videoChecksum: string;
  coverChecksum: string;
  exportSequence: number;
  /** 这次导出把哪些上一版文件挪进了「旧版」；集成层据此修正正式产物路径。 */
  archived: BatchExportArchivedFile[];
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
 * 与单条模式同一套命名合约：生产身份冻结后使用 `<基础名>-<两位成片序号>`；
 * 旧调用缺省 `baseName` 时回退 `成片-<产品编码>-<YYYYMMDD>-<两位序号>`。
 * 序号与检查页的「成片 01/02」一一对应。
 */
function buildBaseName(identity: BatchExportIdentity): string {
  if (!Number.isInteger(identity.planSeq) || identity.planSeq < 1) throw new Error('plan 序号必须是正整数');
  if (!Number.isInteger(identity.outputVersion) || identity.outputVersion < 1) throw new Error('output version 必须是正整数');
  const sequenceSuffix = String(identity.planSeq).padStart(2, '0');
  if (identity.formulaIdentity !== undefined) {
    const base = identity.baseName || `成片-${safeFilenameSegment(identity.productCode, 'productCode')}-${dateInShanghai(identity.taskDate)}`;
    return `${base}-${formulaExportSuffix(identity.formulaIdentity)}`;
  }
  if (productionCodeSuffix(identity.productionCodes)) {
    const base = identity.baseName || `成片-${safeFilenameSegment(identity.productCode, 'productCode')}-${dateInShanghai(identity.taskDate)}`;
    return withProductionCodes(base, identity.productionCodes);
  }
  if (identity.baseName) {
    return `${identity.baseName}-${sequenceSuffix}`;
  }
  const productCode = safeFilenameSegment(identity.productCode, 'productCode');
  return `成片-${productCode}-${dateInShanghai(identity.taskDate)}-${sequenceSuffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exportedFileMatcher(exportKey: string): RegExp {
  return new RegExp(`^${escapeRegExp(exportKey)}${liveMixcutVersionSuffixPattern()}(?:-封面\\.jpg|\\.mp4)$`, 'u');
}

function reservationMatcher(exportKey: string): RegExp {
  return new RegExp(`^\\.${escapeRegExp(exportKey)}(?:-v(\\d+))?\\.publish\\.lock$`, 'u');
}

function versionOfMatch(match: RegExpExecArray): number {
  return match[1] ? Number(match[1]) : 1;
}

function highestVersionIn(directory: string, matchers: RegExp[]): number {
  let names: string[];
  try { names = fs.readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let highest = 0;
  for (const name of names) {
    for (const matcher of matchers) {
      const match = matcher.exec(name);
      if (match) { highest = Math.max(highest, versionOfMatch(match)); break; }
    }
  }
  return highest;
}

/**
 * Atomically reserves a paired video/cover name in the task's export folder.
 * Version numbers come from the files already in 成片/旧版 plus in-flight locks,
 * so two concurrent reservations of the same identity get -v2 and -v3.
 * The lock file is deliberately separate from the output files.
 */
export function reserveBatchExportTarget(input: BatchExportIdentity & { storageRoot?: string }): BatchExportTarget {
  assertSafePathSegment(input.projectId, '项目标识');
  assertSafePathSegment(input.batchId, '批次标识');
  assertSafePathSegment(input.exportDirName, '导出目录名');
  const storageRoot = path.resolve(input.storageRoot ?? path.join(dataRoot(), 'storage'));
  const exportKey = buildBaseName(input);
  // 一个任务只有一个「成片」文件夹；所有批次按同一套导出身份共用版本号。
  const relativeDir = liveMixcutExportRelativeDir(input.exportDirName);
  const exportDir = ensureDirectory(storageRoot, relativeDir);
  const archiveDir = path.join(path.dirname(exportDir), LIVE_MIXCUT_ARCHIVE_FOLDER);
  const fileMatcher = exportedFileMatcher(exportKey);
  const lockMatcher = reservationMatcher(exportKey);

  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const highest = Math.max(
      highestVersionIn(exportDir, [fileMatcher, lockMatcher]),
      highestVersionIn(archiveDir, [fileMatcher]),
    );
    const version = highest + 1;
    const candidateBase = liveMixcutVersionName(exportKey, version);
    const videoFilename = `${candidateBase}.mp4`;
    const coverFilename = `${candidateBase}-封面.jpg`;
    const reservationFilename = `.${candidateBase}.publish.lock`;
    const videoAbsolutePath = path.join(exportDir, videoFilename);
    const coverAbsolutePath = path.join(exportDir, coverFilename);
    const reservationAbsolutePath = path.join(exportDir, reservationFilename);
    if (lstatExists(videoAbsolutePath) || lstatExists(coverAbsolutePath)) continue;
    assertNoStorageSymlink(storageRoot, relativeDir);
    try {
      const fd = fs.openSync(reservationAbsolutePath, 'wx');
      fs.closeSync(fd);
      return {
        storageRoot,
        exportSequence: version,
        baseName: candidateBase,
        exportKey,
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

/** 「旧版」里同一个版本号不能覆盖已有文件；重名时往后加 -2、-3。 */
function archivedBaseFor(archiveDir: string, exportKey: string, version: number): string {
  const base = liveMixcutVersionName(exportKey, version);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    if (!lstatExists(path.join(archiveDir, `${candidate}.mp4`))
      && !lstatExists(path.join(archiveDir, `${candidate}-封面.jpg`))) return candidate;
  }
  throw new Error('旧版文件名预留次数已耗尽');
}

/**
 * 新版本发布后，把「成片」里同一条旧版本的视频和封面挪到旁边的「旧版」。
 * 「成片」只留当前这一套；旧版本文件不删除，只换位置。
 */
async function archiveEarlierExports(storageRoot: string, target: BatchExportTarget): Promise<BatchExportArchivedFile[]> {
  const exportDir = path.dirname(target.videoAbsolutePath);
  const matcher = exportedFileMatcher(target.exportKey);
  const groups = new Map<number, string[]>();
  for (const name of fs.readdirSync(exportDir)) {
    const match = matcher.exec(name);
    if (!match) continue;
    const version = versionOfMatch(match);
    if (version >= target.exportSequence) continue;
    groups.set(version, [...(groups.get(version) ?? []), name]);
  }
  if (groups.size === 0) return [];
  const archiveDir = ensureDirectory(storageRoot, toStorageRelativePath(storageRoot, path.join(path.dirname(exportDir), LIVE_MIXCUT_ARCHIVE_FOLDER)));
  const moves: BatchExportArchivedFile[] = [];
  try {
    for (const version of [...groups.keys()].sort((left, right) => left - right)) {
      const destBase = archivedBaseFor(archiveDir, target.exportKey, version);
      // 视频先挪，封面后挪；失败时整体退回，避免只过去一半。
      const names = [...groups.get(version)!].sort((left, right) => Number(right.endsWith('.mp4')) - Number(left.endsWith('.mp4')));
      for (const name of names) {
        const extension = name.endsWith('.mp4') ? '.mp4' : '-封面.jpg';
        const source = path.join(exportDir, name);
        const destination = path.join(archiveDir, `${destBase}${extension}`);
        if (lstatExists(destination)) throw new Error('旧版目标已存在,不得覆盖');
        await fsp.link(source, destination);
        try {
          await fsp.unlink(source);
        } catch (error) {
          await fsp.unlink(destination).catch(() => undefined);
          throw error;
        }
        moves.push({
          fromRelativePath: toStorageRelativePath(storageRoot, source),
          toRelativePath: toStorageRelativePath(storageRoot, destination),
          kind: extension === '.mp4' ? 'video' : 'cover',
        });
      }
    }
    return moves;
  } catch (error) {
    try { restoreArchivedBatchExportMoves(storageRoot, moves); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

/** 把已经挪进「旧版」的文件退回原处；注册事务失败或并发重复发布时用。 */
export function restoreArchivedBatchExportMoves(storageRoot: string, moves: readonly BatchExportArchivedFile[]): void {
  for (const move of [...moves].reverse()) {
    const source = resolveStoragePath(storageRoot, move.fromRelativePath);
    const archived = resolveStoragePath(storageRoot, move.toRelativePath);
    assertNoStorageSymlink(storageRoot, move.fromRelativePath);
    assertNoStorageSymlink(storageRoot, move.toRelativePath);
    fs.linkSync(archived, source);
    fs.unlinkSync(archived);
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
  const rendered = input.renderResult;
  const verifiedFormulaSound = rendered && (rendered.audioMode === 'source' || rendered.audioMode === 'mixed')
    && typeof rendered.formulaExecution?.stageId === 'string'
    && /^rnd_[0-9a-f]{32}$/.test(rendered.formulaExecution.contentContractHash)
    && /^rnd_[0-9a-f]{32}$/.test(rendered.fullRenderContractHash ?? '');
  if (input.productionReady !== true || !rendered || (rendered.audioMode !== 'narration' && !verifiedFormulaSound) || rendered.productionReady !== true) {
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
  let archived: BatchExportArchivedFile[] = [];
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
    archived = await archiveEarlierExports(storageRoot, target);
    await Promise.all([fsp.unlink(videoTemp), fsp.unlink(coverTemp), fsp.unlink(target.reservationAbsolutePath)]);
    return {
      videoAbsolutePath: target.videoAbsolutePath,
      coverAbsolutePath: target.coverAbsolutePath,
      videoRelativePath: target.videoRelativePath,
      coverRelativePath: target.coverRelativePath,
      videoChecksum,
      coverChecksum,
      exportSequence: target.exportSequence,
      archived,
    };
  } catch (error) {
    await Promise.allSettled([fsp.unlink(videoTemp), fsp.unlink(coverTemp)]);
    if (archived.length) {
      try { restoreArchivedBatchExportMoves(storageRoot, archived); } catch { /* 保留原始错误 */ }
    }
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
