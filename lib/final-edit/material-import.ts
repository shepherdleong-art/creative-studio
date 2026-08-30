import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { runFfmpeg, type VideoMediaProbe } from '../ffmpeg.ts';
import {
  isDetectedVideoContainerCompatible,
  SUPPORTED_VIDEO_MIME_BY_EXTENSION,
} from '../video-file-format.ts';
import { resolveStoragePath } from './storage-path.ts';
import type { FinalEditExternalAssetView } from './types.ts';

interface ExternalAssetUploadMetadata {
  filename: string;
  mimeType: string;
}

type BufferedExternalAssetUpload = ExternalAssetUploadMetadata & {
  data: Buffer;
};

type StagedExternalAssetUpload = ExternalAssetUploadMetadata & {
  temporaryPath: string;
  size: number;
};

export type ExternalAssetUpload = BufferedExternalAssetUpload | StagedExternalAssetUpload;

export interface ExternalAssetImportFailure {
  filename: string;
  error: string;
  message: string;
}

export interface ImportedExternalAsset extends FinalEditExternalAssetView {
  reused: boolean;
}

export interface ExternalAssetImportResult {
  assets: ImportedExternalAsset[];
  errors: ExternalAssetImportFailure[];
}

export interface ShotSetExternalAssetImportInput {
  projectId: string;
  shotSetId: string;
  files: ExternalAssetUpload[];
  signal?: AbortSignal;
}

export interface MaterialImportDependencies {
  db: Database.Database;
  storageRoot: string;
  probeVideo(input: { filePath: string; videoJobId: string }): Promise<VideoMediaProbe>;
  materializeThumbnail(input: {
    sourcePath: string;
    cacheNamespace: string;
    cacheKey: string;
    frameUs: number;
  }): Promise<{ absolutePath: string; relativePath: string }>;
}

export class MaterialImportError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'MaterialImportError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ShotSetMaterialScope {
  projectId: string;
  shotSetId: string;
}

interface ExternalAssetRow {
  id: string;
  projectId: string;
  shotSetId: string;
  originalFilename: string;
  relativePath: string;
  thumbnailRelativePath: string | null;
  mimeType: string;
  mediaKind: 'video' | 'image';
  durationUs: number;
  width: number | null;
  height: number | null;
  fileFingerprint: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

interface PendingAssetWrite {
  row: ExternalAssetRow;
  videoAbsolutePath: string;
  thumbnailAbsolutePath: string | null;
  videoExistedBefore: boolean;
  thumbnailExistedBefore: boolean;
}

function currentTime(): string {
  return new Date().toISOString();
}

function getShotSetMaterialScope(db: Database.Database, projectId: string, shotSetId: string): ShotSetMaterialScope {
  const scope = db.prepare(`
    SELECT ss.projectId, ss.id AS shotSetId
    FROM shot_sets ss JOIN projects p ON p.id=ss.projectId
    WHERE ss.projectId=? AND ss.id=?
  `).get(projectId, shotSetId) as ShotSetMaterialScope | undefined;
  if (!scope) throw new MaterialImportError('shot_set_not_found', '分镜组不存在或不属于当前项目', 404);
  return scope;
}

function safeIdSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new MaterialImportError('unsafe_path', `${label} 不能用于素材存储路径`);
  return value;
}

function materialsRelativeDirectory(scope: ShotSetMaterialScope): string {
  return path.join(
    'final-edits',
    'projects',
    safeIdSegment(scope.projectId, 'projectId'),
    'groups',
    safeIdSegment(scope.shotSetId, 'shotSetId'),
    'materials',
  );
}

function cleanOriginalFilename(filename: string, extension: string): string {
  const slashNormalized = filename.replace(/\\/g, '/');
  const base = path.posix.basename(slashNormalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base || `upload${extension}`;
}

function uploadSize(upload: ExternalAssetUpload): number {
  return 'data' in upload ? upload.data.length : upload.size;
}

function validateUpload(upload: ExternalAssetUpload): {
  extension: string;
  storedExtension: string;
  mimeType: string;
  originalFilename: string;
  transcodeGif: boolean;
} {
  const extension = path.extname(upload.filename.replace(/\\/g, '/')).toLowerCase();
  const isGif = extension === '.gif';
  if (!isGif && (upload.mimeType.toLowerCase().startsWith('image/') || ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(extension))) {
    throw new MaterialImportError('unsupported_media_kind', 'V1 只支持视频素材，不支持静态图片');
  }
  const mimeType = isGif ? 'video/mp4' : SUPPORTED_VIDEO_MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new MaterialImportError('unsupported_video_format', '仅支持 MP4、MOV、AVI、WebM、GIF 视频');
  const suppliedMime = upload.mimeType.trim().toLowerCase();
  if (isGif) {
    if (suppliedMime && suppliedMime !== 'application/octet-stream' && suppliedMime !== 'image/gif') {
      throw new MaterialImportError('unsupported_video_mime', 'GIF 文件的 MIME 类型无效');
    }
  } else if (suppliedMime && suppliedMime !== 'application/octet-stream' && !suppliedMime.startsWith('video/')) {
    throw new MaterialImportError('unsupported_video_mime', '上传文件的 MIME 类型不是视频');
  }
  if (!uploadSize(upload)) throw new MaterialImportError('empty_upload', '上传文件为空');
  return {
    extension,
    storedExtension: isGif ? '.mp4' : extension,
    mimeType,
    originalFilename: cleanOriginalFilename(upload.filename, extension),
    transcodeGif: isGif,
  };
}

function assertTemporaryUploadFile(upload: StagedExternalAssetUpload): void {
  const stat = fs.lstatSync(upload.temporaryPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== upload.size) {
    throw new MaterialImportError('unsafe_upload_source', '上传暂存文件无效');
  }
}

async function fingerprintUpload(upload: ExternalAssetUpload): Promise<string> {
  if ('data' in upload) return crypto.createHash('sha256').update(upload.data).digest('hex');
  assertTemporaryUploadFile(upload);
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(upload.temporaryPath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('hex');
}

function validateDetectedContainer(extension: string, detectedFormat: string | undefined): void {
  if (!isDetectedVideoContainerCompatible(extension, detectedFormat)) {
    throw new MaterialImportError('video_format_mismatch', '视频内容与文件扩展名不一致');
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isWithinOrEqual(parent: string, child: string): boolean {
  return parent === child || isWithin(parent, child);
}

function ensureSafeRelativeDirectory(storageRoot: string, relativeDirectory: string, create: boolean): string {
  const logicalRoot = path.resolve(storageRoot);
  const realRoot = fs.realpathSync(logicalRoot);
  const segments = relativeDirectory.split(/[\\/]+/).filter(Boolean);
  let current = logicalRoot;
  let missing = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      missing = true;
      if (create) fs.mkdirSync(current);
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MaterialImportError('unsafe_path', '素材目录包含不安全的链接或文件');
    if (!missing) {
      const realCurrent = fs.realpathSync(current);
      if (!isWithinOrEqual(realRoot, realCurrent)) throw new MaterialImportError('unsafe_path', '素材目录越过 storage 边界');
    }
  }
  return current;
}

export function resolveImportedExternalAssetVideoPath(storageRoot: string, scope: ShotSetMaterialScope, relativePath: string, createDirectory = false): string {
  if (!SUPPORTED_VIDEO_MIME_BY_EXTENSION[path.extname(relativePath).toLowerCase()]) {
    throw new MaterialImportError('unsafe_path', '外部素材路径扩展名不在视频白名单内');
  }
  const expectedDirectory = ensureSafeRelativeDirectory(storageRoot, materialsRelativeDirectory(scope), createDirectory);
  const absolutePath = resolveStoragePath(storageRoot, relativePath);
  if (!isWithin(expectedDirectory, absolutePath)) throw new MaterialImportError('unsafe_path', '外部素材路径不在当前分镜组 materials 目录内');
  if (fs.existsSync(absolutePath)) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new MaterialImportError('unsafe_path', '外部素材不是安全的普通文件');
    const realDirectory = fs.realpathSync(expectedDirectory);
    if (!isWithin(realDirectory, fs.realpathSync(absolutePath))) throw new MaterialImportError('unsafe_path', '外部素材真实路径越界');
  }
  return absolutePath;
}

function thumbnailRelativeDirectory(scope: ShotSetMaterialScope): string {
  return path.join('final-edits', 'previews', 'external-assets', safeIdSegment(scope.projectId, 'projectId'), safeIdSegment(scope.shotSetId, 'shotSetId'));
}

function resolveThumbnailPath(storageRoot: string, scope: ShotSetMaterialScope, relativePath: string, createDirectory = false): string {
  if (path.extname(relativePath).toLowerCase() !== '.jpg') throw new MaterialImportError('unsafe_path', '缩略图扩展名无效');
  const expectedDirectory = ensureSafeRelativeDirectory(storageRoot, thumbnailRelativeDirectory(scope), createDirectory);
  const absolutePath = resolveStoragePath(storageRoot, relativePath);
  if (!isWithin(expectedDirectory, absolutePath)) throw new MaterialImportError('unsafe_path', '缩略图路径不属于当前分镜组');
  if (fs.existsSync(absolutePath)) {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new MaterialImportError('unsafe_path', '缩略图不是安全的普通文件');
    if (!isWithin(fs.realpathSync(expectedDirectory), fs.realpathSync(absolutePath))) throw new MaterialImportError('unsafe_path', '缩略图真实路径越界');
  }
  return absolutePath;
}

function assetView(storageRoot: string, row: ExternalAssetRow): FinalEditExternalAssetView {
  if (row.mediaKind !== 'video') throw new MaterialImportError('unsupported_media_kind', 'V1 不支持读取图片素材');
  const scope = { projectId: row.projectId, shotSetId: row.shotSetId };
  const absolutePath = resolveImportedExternalAssetVideoPath(storageRoot, scope, row.relativePath);
  let status: FinalEditExternalAssetView['status'] = row.status === 'failed' ? 'failed' : 'ready';
  let errorMessage = row.errorMessage;
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    status = 'missing';
    errorMessage = '素材文件已丢失，请重新导入';
  } else if (status === 'ready' && (!row.thumbnailRelativePath || !fs.existsSync(resolveThumbnailPath(storageRoot, scope, row.thumbnailRelativePath)))) {
    status = 'failed';
    errorMessage = '素材缩略图已丢失，请重新导入';
  }
  return {
    id: row.id,
    assetKey: `external:${row.id}`,
    projectId: row.projectId,
    shotSetId: row.shotSetId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    mediaKind: 'video',
    durationUs: Number(row.durationUs) || 0,
    width: Number(row.width) || 0,
    height: Number(row.height) || 0,
    status,
    errorMessage,
    previewUrl: `/api/projects/${encodeURIComponent(row.projectId)}/final-edit/shot-sets/${encodeURIComponent(row.shotSetId)}/external-assets/${encodeURIComponent(row.id)}/media`,
    thumbnailUrl: row.thumbnailRelativePath
      ? `/api/projects/${encodeURIComponent(row.projectId)}/final-edit/shot-sets/${encodeURIComponent(row.shotSetId)}/external-assets/${encodeURIComponent(row.id)}/thumbnail`
      : null,
    source: 'external',
    createdAt: row.createdAt,
  };
}

function writeUploadAtomic(absolutePath: string, upload: ExternalAssetUpload): void {
  const temporaryPath = `${absolutePath}.${uuidv4()}.tmp`;
  try {
    if ('data' in upload) {
      fs.writeFileSync(temporaryPath, upload.data, { flag: 'wx' });
    } else {
      assertTemporaryUploadFile(upload);
      fs.copyFileSync(upload.temporaryPath, temporaryPath, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(temporaryPath, absolutePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function errorResult(filename: string, error: unknown): ExternalAssetImportFailure {
  if (error instanceof MaterialImportError) return { filename, error: error.code, message: error.message };
  return { filename, error: 'external_asset_import_failed', message: '外部素材导入失败，请重试' };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

// GIF can carry transparent pixels, while the MP4 output format cannot carry
// alpha. Flatten onto white before converting to yuv420p; otherwise ffmpeg's
// implicit alpha removal turns transparent areas into black blocks.
const GIF_WHITE_BACKGROUND_FILTER = [
  'fps=24',
  'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  'format=rgba',
  "geq=r='r(X,Y)*alpha(X,Y)/255+255*(1-alpha(X,Y)/255)':g='g(X,Y)*alpha(X,Y)/255+255*(1-alpha(X,Y)/255)':b='b(X,Y)*alpha(X,Y)/255+255*(1-alpha(X,Y)/255)'",
  'format=yuv420p',
].join(',');

async function transcodeGifUpload(
  upload: ExternalAssetUpload,
  signal?: AbortSignal,
): Promise<{ upload: StagedExternalAssetUpload; cleanup: () => void }> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-gif-'));
  const inputPath = path.join(temporaryDirectory, 'input.gif');
  const outputPath = path.join(temporaryDirectory, 'output.mp4');
  let keepDirectory = false;
  try {
    if ('data' in upload) {
      fs.writeFileSync(inputPath, upload.data, { flag: 'wx' });
    } else {
      assertTemporaryUploadFile(upload);
      fs.copyFileSync(upload.temporaryPath, inputPath, fs.constants.COPYFILE_EXCL);
    }
    await runFfmpeg([
      '-i', inputPath,
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', GIF_WHITE_BACKGROUND_FILTER,
      '-c:v', 'libx264',
      '-crf', '20',
      '-an',
      '-y', outputPath,
    ], { timeoutMs: 120_000, signal });
    if (signal?.aborted) throw createAbortError('GIF 转码已取消');
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size <= 0) {
      throw new Error('GIF 转码没有生成有效的 MP4 文件');
    }
    keepDirectory = true;
    const filename = `${path.basename(upload.filename, path.extname(upload.filename))}.mp4`;
    return {
      upload: { filename, mimeType: 'video/mp4', temporaryPath: outputPath, size: fs.statSync(outputPath).size },
      cleanup: () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error instanceof Error && error.name === 'AbortError' ? error : createAbortError('GIF 转码已取消');
    }
    throw new MaterialImportError('gif_transcode_failed', 'GIF 转码失败，请检查文件后重试');
  } finally {
    if (!keepDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function listShotSetExternalAssets(
  deps: Pick<MaterialImportDependencies, 'db' | 'storageRoot'>,
  projectId: string,
  shotSetId: string,
): FinalEditExternalAssetView[] {
  const scope = getShotSetMaterialScope(deps.db, projectId, shotSetId);
  const rows = deps.db.prepare(`
    SELECT * FROM final_edit_external_assets
    WHERE projectId=? AND shotSetId=? ORDER BY createdAt, id
  `).all(scope.projectId, scope.shotSetId) as ExternalAssetRow[];
  return rows.map((row) => assetView(deps.storageRoot, row));
}

async function importExternalAssetsForScope(
  deps: MaterialImportDependencies,
  scope: ShotSetMaterialScope,
  files: ExternalAssetUpload[],
  signal?: AbortSignal,
): Promise<ExternalAssetImportResult> {
  if (!files.length) throw new MaterialImportError('files_required', '请选择至少一个视频文件');

  const pending = new Map<string, PendingAssetWrite>();
  const results: Array<{ assetId: string; fingerprint: string; reused: boolean }> = [];
  const errors: ExternalAssetImportFailure[] = [];

  for (const upload of files) {
    if (signal?.aborted) throw createAbortError('素材导入已取消');
    let writtenVideoPath: string | null = null;
    let thumbnailAbsolutePath: string | null = null;
    let videoExistedBefore = false;
    let thumbnailExistedBefore = false;
    let existingThumbnailWasPresent = false;
    let valid: ReturnType<typeof validateUpload> | null = null;
    let fingerprint = '';
    let existing: ExternalAssetRow | undefined;
    let assetId = '';
    let relativePath = '';
    let media: VideoMediaProbe | null = null;
    let preparedUpload = upload;
    let cleanupPreparedUpload: (() => void) | null = null;
    try {
      valid = validateUpload(upload);
      if (valid.transcodeGif) {
        const transcoded = await transcodeGifUpload(upload, signal);
        preparedUpload = transcoded.upload;
        cleanupPreparedUpload = transcoded.cleanup;
      }
      fingerprint = await fingerprintUpload(preparedUpload);
      const stagedDuplicate = pending.get(fingerprint);
      if (stagedDuplicate) {
        results.push({ assetId: stagedDuplicate.row.id, fingerprint, reused: true });
        continue;
      }
      existing = deps.db.prepare(`
        SELECT * FROM final_edit_external_assets WHERE shotSetId=? AND fileFingerprint=?
      `).get(scope.shotSetId, fingerprint) as ExternalAssetRow | undefined;
      if (existing && existing.projectId !== scope.projectId) {
        throw new MaterialImportError('external_asset_ownership_invalid', '外部素材归属数据不一致', 409);
      }
      if (existing) {
        const existingPath = resolveImportedExternalAssetVideoPath(deps.storageRoot, scope, existing.relativePath);
        const thumbnailExists = Boolean(existing.thumbnailRelativePath)
          && fs.existsSync(resolveThumbnailPath(deps.storageRoot, scope, existing.thumbnailRelativePath!));
        existingThumbnailWasPresent = thumbnailExists;
        if (existing.status === 'ready' && fs.existsSync(existingPath) && fs.statSync(existingPath).isFile() && thumbnailExists) {
          results.push({ assetId: existing.id, fingerprint, reused: true });
          continue;
        }
      }

      assetId = existing?.id || uuidv4();
      relativePath = existing?.relativePath || path.join(materialsRelativeDirectory(scope), `${assetId}${valid.storedExtension}`);
      const absolutePath = resolveImportedExternalAssetVideoPath(deps.storageRoot, scope, relativePath, true);
      videoExistedBefore = fs.existsSync(absolutePath);
      writeUploadAtomic(absolutePath, preparedUpload);
      writtenVideoPath = absolutePath;

      media = await deps.probeVideo({ filePath: absolutePath, videoJobId: assetId });
      if (media.durationUs <= 0 || media.width <= 0 || media.height <= 0) {
        if (media.errorMessage) console.error('[final-edit] external video probe failed:', media.errorMessage.replaceAll(path.resolve(deps.storageRoot), '<storage>').replaceAll(absolutePath, '<material>'));
        throw new MaterialImportError('video_probe_failed', '无法读取视频时长或分辨率');
      }
      validateDetectedContainer(valid.storedExtension, media.format);
      const lastSafeFrameUs = Math.max(0, media.durationUs - Math.max(50_000, Math.ceil(1_000_000 / Math.max(1, media.fps || 24))));
      const frameUs = Math.min(lastSafeFrameUs, Math.max(0, Math.min(100_000, Math.round(media.durationUs / 10))));
      ensureSafeRelativeDirectory(deps.storageRoot, thumbnailRelativeDirectory(scope), true);
      const thumbnail = await deps.materializeThumbnail({
        sourcePath: absolutePath,
        cacheNamespace: path.join('external-assets', safeIdSegment(scope.projectId, 'projectId'), safeIdSegment(scope.shotSetId, 'shotSetId')),
        cacheKey: `${assetId}:${fingerprint}:${frameUs}`,
        frameUs,
      });
      thumbnailAbsolutePath = resolveThumbnailPath(deps.storageRoot, scope, thumbnail.relativePath);
      if (path.resolve(thumbnail.absolutePath) !== path.resolve(thumbnailAbsolutePath)) throw new MaterialImportError('unsafe_path', '缩略图返回了不一致的路径');
      thumbnailExistedBefore = existingThumbnailWasPresent && existing?.thumbnailRelativePath === thumbnail.relativePath;
      const row: ExternalAssetRow = {
        id: assetId,
        projectId: scope.projectId,
        shotSetId: scope.shotSetId,
        originalFilename: valid.originalFilename,
        relativePath,
        thumbnailRelativePath: thumbnail.relativePath,
        mimeType: valid.mimeType,
        mediaKind: 'video',
        durationUs: media.durationUs,
        width: media.width,
        height: media.height,
        fileFingerprint: fingerprint,
        status: 'ready',
        errorMessage: null,
        createdAt: existing?.createdAt || currentTime(),
      };
      pending.set(fingerprint, {
        row,
        videoAbsolutePath: absolutePath,
        thumbnailAbsolutePath,
        videoExistedBefore,
        thumbnailExistedBefore,
      });
      results.push({ assetId, fingerprint, reused: false });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        if (writtenVideoPath && !videoExistedBefore && fs.existsSync(writtenVideoPath)) fs.unlinkSync(writtenVideoPath);
        throw error instanceof Error && error.name === 'AbortError'
          ? error
          : createAbortError('素材导入已取消');
      }
      if (!(error instanceof MaterialImportError)) {
        const diagnostic = error instanceof Error ? error.message : String(error);
        console.error('[final-edit] external asset import failed:', diagnostic.replaceAll(path.resolve(deps.storageRoot), '<storage>'));
      }
      const failure = errorResult(upload.filename, error);
      errors.push(failure);
      const unsafeFailure = error instanceof MaterialImportError
        && ['unsafe_path', 'external_asset_ownership_invalid'].includes(error.code);
      if (writtenVideoPath && valid && fingerprint && assetId && relativePath && !unsafeFailure) {
        const row: ExternalAssetRow = {
          id: assetId,
          projectId: scope.projectId,
          shotSetId: scope.shotSetId,
          originalFilename: valid.originalFilename,
          relativePath,
          thumbnailRelativePath: existing?.thumbnailRelativePath || null,
          mimeType: valid.mimeType,
          mediaKind: 'video',
          durationUs: media?.durationUs || 0,
          width: media?.width || null,
          height: media?.height || null,
          fileFingerprint: fingerprint,
          status: 'failed',
          errorMessage: failure.message,
          createdAt: existing?.createdAt || currentTime(),
        };
        pending.set(fingerprint, {
          row,
          videoAbsolutePath: writtenVideoPath,
          thumbnailAbsolutePath,
          videoExistedBefore,
          thumbnailExistedBefore,
        });
        results.push({ assetId, fingerprint, reused: false });
      } else if (writtenVideoPath && !videoExistedBefore && fs.existsSync(writtenVideoPath)) {
        fs.unlinkSync(writtenVideoPath);
      }
    } finally {
      cleanupPreparedUpload?.();
    }
  }

  if (pending.size > 0) {
    const cleanupPending = (item: PendingAssetWrite) => {
      if (!item.videoExistedBefore && fs.existsSync(item.videoAbsolutePath)) fs.unlinkSync(item.videoAbsolutePath);
      if (item.thumbnailAbsolutePath && !item.thumbnailExistedBefore && fs.existsSync(item.thumbnailAbsolutePath)) fs.unlinkSync(item.thumbnailAbsolutePath);
    };
    for (const [fingerprint, item] of pending) {
      try {
        deps.db.transaction(() => {
          const { row } = item;
          deps.db.prepare(`
            INSERT INTO final_edit_external_assets (
              id, projectId, shotSetId, originalFilename, relativePath, thumbnailRelativePath,
              mimeType, mediaKind, durationUs, width, height, fileFingerprint, status,
              errorMessage, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              originalFilename=excluded.originalFilename,
              relativePath=excluded.relativePath,
              thumbnailRelativePath=excluded.thumbnailRelativePath,
              mimeType=excluded.mimeType,
              durationUs=excluded.durationUs,
              width=excluded.width,
              height=excluded.height,
              status=excluded.status,
              errorMessage=excluded.errorMessage
          `).run(
            row.id, row.projectId, row.shotSetId, row.originalFilename, row.relativePath,
            row.thumbnailRelativePath, row.mimeType, row.mediaKind, row.durationUs,
            row.width, row.height, row.fileFingerprint, row.status, row.errorMessage, row.createdAt,
          );
        })();
      } catch (error) {
        const constraint = (error as { code?: string })?.code?.startsWith('SQLITE_CONSTRAINT');
        const winner = constraint
          ? deps.db.prepare(`SELECT * FROM final_edit_external_assets WHERE shotSetId=? AND fileFingerprint=?`).get(scope.shotSetId, fingerprint) as ExternalAssetRow | undefined
          : undefined;
        if (winner?.projectId === scope.projectId) {
          cleanupPending(item);
          for (const result of results) {
            if (result.fingerprint === fingerprint && result.assetId !== winner.id) {
              result.assetId = winner.id;
              result.reused = true;
            }
          }
        } else {
          cleanupPending(item);
          results.splice(0, results.length, ...results.filter((result) => result.fingerprint !== fingerprint));
          errors.push({
            filename: item.row.originalFilename,
            error: 'external_asset_persist_failed',
            message: '外部素材保存失败，请重试',
          });
        }
      }
    }
  }

  const rowsById = new Map((deps.db.prepare(`
    SELECT * FROM final_edit_external_assets WHERE projectId=? AND shotSetId=?
  `).all(scope.projectId, scope.shotSetId) as ExternalAssetRow[]).map((row) => [row.id, row]));
  return {
    assets: results.flatMap(({ assetId, reused }) => {
      const row = rowsById.get(assetId);
      return row ? [{ ...assetView(deps.storageRoot, row), reused }] : [];
    }),
    errors,
  };
}

export async function importShotSetExternalAssets(
  deps: MaterialImportDependencies,
  input: ShotSetExternalAssetImportInput,
): Promise<ExternalAssetImportResult> {
  // JUDGMENT CALL: Step 1 permits import before a revision-bearing
  // final_edit_group exists. The canonical project+shot-set API therefore
  // validates both ownership keys but intentionally has no expectedRevision;
  // importing bytes must never manufacture a placeholder group/scriptDraftId.
  // If Phase 2 later needs a group-scoped compatibility route, it must be a
  // real atomic group command with revision CAS, not a wrapper around this
  // pre-group operation.
  const scope = getShotSetMaterialScope(deps.db, input.projectId, input.shotSetId);
  return importExternalAssetsForScope(deps, scope, input.files, input.signal);
}

function objectReferencesAsset(value: unknown, assetId: string): boolean {
  if (typeof value === 'string') return value === assetId || value === `external:${assetId}`;
  if (Array.isArray(value)) return value.some((item) => objectReferencesAsset(item, assetId));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((item) => objectReferencesAsset(item, assetId));
}

function jsonReferencesAsset(value: string | null, assetId: string): boolean {
  if (!value) return false;
  try { return objectReferencesAsset(JSON.parse(value), assetId); } catch { return false; }
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table));
}

function assertAssetNotReferenced(db: Database.Database, scope: ShotSetMaterialScope, asset: ExternalAssetRow): void {
  const variants = db.prepare(`
    SELECT v.timelineJson, v.coverJson
    FROM final_edit_variants v
    JOIN final_edit_groups g ON g.id=v.groupId
    WHERE g.projectId=? AND g.shotSetId=?
  `).all(scope.projectId, scope.shotSetId) as Array<{ timelineJson: string; coverJson: string }>;
  if (variants.some((row) => jsonReferencesAsset(row.timelineJson, asset.id) || jsonReferencesAsset(row.coverJson, asset.id))) {
    throw new MaterialImportError('external_asset_in_use', '外部素材正在被草稿引用，不能删除', 409);
  }
  const jobs = db.prepare(`
    SELECT inputSnapshotJson, outputJson FROM final_edit_jobs WHERE projectId=?
  `).all(scope.projectId) as Array<{ inputSnapshotJson: string; outputJson: string | null }>;
  if (jobs.some((row) => jsonReferencesAsset(row.inputSnapshotJson, asset.id)
    || jsonReferencesAsset(row.outputJson, asset.id)
    || jsonReferencesAsset(row.inputSnapshotJson, asset.relativePath)
    || jsonReferencesAsset(row.outputJson, asset.relativePath))) {
    throw new MaterialImportError('external_asset_in_use', '外部素材正在被任务产物引用，不能删除', 409);
  }
  if (tableExists(db, 'project_artifacts')) {
    const artifact = db.prepare(`
      SELECT 1 FROM project_artifacts WHERE projectId=? AND relativePath IN (?, ?) LIMIT 1
    `).get(scope.projectId, asset.relativePath, asset.thumbnailRelativePath || '');
    if (artifact) throw new MaterialImportError('external_asset_in_use', '外部素材正在被项目产物引用，不能删除', 409);
  }
}

export function resolveShotSetExternalAssetMedia(
  deps: Pick<MaterialImportDependencies, 'db' | 'storageRoot'>,
  projectId: string,
  shotSetId: string,
  assetId: string,
  kind: 'video' | 'thumbnail',
): { relativePath: string; mimeType: string } {
  const scope = getShotSetMaterialScope(deps.db, projectId, shotSetId);
  const row = deps.db.prepare(`
    SELECT * FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=?
  `).get(assetId, scope.projectId, scope.shotSetId) as ExternalAssetRow | undefined;
  if (!row) throw new MaterialImportError('external_asset_not_found', '外部素材不存在或不属于当前分镜组', 404);
  if (row.status !== 'ready') throw new MaterialImportError('external_asset_not_ready', '外部素材尚不可用', 409);
  if (kind === 'video') {
    const absolutePath = resolveImportedExternalAssetVideoPath(deps.storageRoot, scope, row.relativePath);
    if (!fs.existsSync(absolutePath)) throw new MaterialImportError('external_asset_missing', '外部素材文件已丢失', 404);
    return { relativePath: row.relativePath, mimeType: row.mimeType };
  }
  if (!row.thumbnailRelativePath) throw new MaterialImportError('external_asset_thumbnail_missing', '外部素材缩略图不存在', 404);
  const thumbnailPath = resolveThumbnailPath(deps.storageRoot, scope, row.thumbnailRelativePath);
  if (!fs.existsSync(thumbnailPath)) throw new MaterialImportError('external_asset_thumbnail_missing', '外部素材缩略图不存在', 404);
  return { relativePath: row.thumbnailRelativePath, mimeType: 'image/jpeg' };
}

function deleteExternalAssetForScope(
  deps: Pick<MaterialImportDependencies, 'db' | 'storageRoot'>,
  scope: ShotSetMaterialScope,
  assetId: string,
): { deleted: true } {
  const asset = deps.db.prepare(`
    SELECT * FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=?
  `).get(assetId, scope.projectId, scope.shotSetId) as ExternalAssetRow | undefined;
  if (!asset) throw new MaterialImportError('external_asset_not_found', '外部素材不存在或不属于当前分镜组', 404);
  const videoPath = resolveImportedExternalAssetVideoPath(deps.storageRoot, scope, asset.relativePath);
  const thumbnailPath = asset.thumbnailRelativePath ? resolveThumbnailPath(deps.storageRoot, scope, asset.thumbnailRelativePath) : null;
  assertAssetNotReferenced(deps.db, scope, asset);

  const moved: Array<{ original: string; quarantine: string }> = [];
  try {
    for (const original of [videoPath, thumbnailPath].filter((value): value is string => Boolean(value))) {
      if (!fs.existsSync(original)) continue;
      const quarantine = `${original}.${uuidv4()}.deleting`;
      fs.renameSync(original, quarantine);
      moved.push({ original, quarantine });
    }
    deps.db.transaction(() => {
      const deleted = deps.db.prepare(`
        DELETE FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=?
      `).run(asset.id, scope.projectId, scope.shotSetId);
      if (deleted.changes !== 1) throw new MaterialImportError('external_asset_not_found', '外部素材不存在或不属于当前分镜组', 404);
    })();
    for (const item of moved) {
      try { fs.unlinkSync(item.quarantine); } catch { /* inaccessible quarantine is no longer addressable by any DB row */ }
    }
    return { deleted: true };
  } catch (error) {
    for (const item of moved.reverse()) {
      if (fs.existsSync(item.quarantine) && !fs.existsSync(item.original)) fs.renameSync(item.quarantine, item.original);
    }
    throw error;
  }
}

export function deleteShotSetExternalAsset(
  deps: Pick<MaterialImportDependencies, 'db' | 'storageRoot'>,
  input: { projectId: string; shotSetId: string; assetId: string },
): { deleted: true } {
  const scope = getShotSetMaterialScope(deps.db, input.projectId, input.shotSetId);
  return deleteExternalAssetForScope(deps, scope, input.assetId);
}
