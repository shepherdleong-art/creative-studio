import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import { probeDurationSec } from '../ffmpeg.ts';
import {
  FINAL_EDIT_BGM_EXTENSIONS,
  finalEditBgmFilename,
} from './bgm.ts';
import { FinalEditError } from './errors.ts';
import { assertNoStorageSymlink } from './storage-path.ts';
import type { BgmImportResponse, FinalEditBgmTrackView } from './types.ts';

export interface BgmUpload {
  filename: string;
  mimeType: string;
  temporaryPath: string;
  size: number;
}

export interface BgmImportBatchResult {
  firstSuccessfulTrackId: string | null;
  imported: FinalEditBgmTrackView[];
  reused: FinalEditBgmTrackView[];
  errors: BgmImportResponse['errors'];
}

export interface BgmImportDependencies {
  db: Database.Database;
  storageRoot: string;
  probeDurationSec?: (filePath: string) => Promise<number>;
}

let importTail: Promise<void> = Promise.resolve();

function withBgmImportLock<T>(work: () => Promise<T>): Promise<T> {
  const scheduled = importTail.then(work, work);
  importTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function safeUploadedFilename(original: string): string {
  const filename = original.split(/[\\/]/).filter(Boolean).at(-1) || '';
  const stem = path.parse(filename).name;
  if (
    !filename
    || filename === '.'
    || filename === '..'
    || filename.includes('\0')
    || /[<>:"/\\|?*\u0000-\u001f]/.test(filename)
    || /[ .]$/.test(filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
    || !stem
  ) {
    throw new FinalEditError('invalid_filename', `无法安全保存音乐文件"${original || '未命名'}"`);
  }
  return filename;
}

function numberedFilename(filename: string, index: number): string {
  if (index === 0) return filename;
  const extension = path.extname(filename);
  return `${filename.slice(0, -extension.length)}(${index})${extension}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function placeReadableFile(
  sourcePath: string,
  bgmRoot: string,
  filename: string,
): Promise<{ filename: string; absolutePath: string }> {
  const temporaryPath = path.join(bgmRoot, `.import-${crypto.randomUUID()}.tmp`);
  await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
  try {
    for (let index = 0; ; index += 1) {
      const candidate = numberedFilename(filename, index);
      const absolutePath = path.join(bgmRoot, candidate);
      try {
        await fs.promises.link(temporaryPath, absolutePath);
        return { filename: candidate, absolutePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
}

async function importSingleFile(
  deps: BgmImportDependencies,
  upload: BgmUpload,
): Promise<{ imported?: FinalEditBgmTrackView; reused?: FinalEditBgmTrackView; error?: BgmImportResponse['errors'][number] }> {
  const { db, storageRoot } = deps;
  const probe = deps.probeDurationSec ?? probeDurationSec;

  let safeName: string;
  try {
    safeName = safeUploadedFilename(upload.filename);
  } catch (error) {
    return {
      error: {
        filename: upload.filename,
        code: 'invalid_filename',
        message: error instanceof Error ? error.message : '文件名无效',
      },
    };
  }

  const extension = path.extname(safeName).toLowerCase();
  if (!FINAL_EDIT_BGM_EXTENSIONS.has(extension)) {
    return {
      error: {
        filename: upload.filename,
        code: 'unsupported_audio_format',
        message: `"${upload.filename}" 不是支持的音频格式（.mp3/.wav/.m4a/.aac/.flac/.ogg）`,
      },
    };
  }
  const format = extension.slice(1);

  let durationSec: number;
  try {
    durationSec = await probe(upload.temporaryPath);
  } catch {
    return {
      error: {
        filename: upload.filename,
        code: 'invalid_audio',
        message: `无法识别"${upload.filename}"的音频内容，请检查文件是否损坏`,
      },
    };
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      error: {
        filename: upload.filename,
        code: 'invalid_audio',
        message: `"${upload.filename}"的音频时长为零或无效`,
      },
    };
  }
  const durationUs = Math.round(durationSec * 1_000_000);

  let fingerprint: string;
  try {
    fingerprint = await sha256File(upload.temporaryPath);
  } catch {
    return {
      error: {
        filename: upload.filename,
        code: 'bgm_write_failed',
        message: `无法读取"${upload.filename}"`,
      },
    };
  }

  const existing = db.prepare(`
    SELECT id, relativePath, fileFingerprint, durationUs
    FROM final_edit_bgm_tracks
    WHERE fileFingerprint = ? AND status = 'ready'
  `).get(fingerprint) as { id: string; relativePath: string; fileFingerprint: string; durationUs: number } | undefined;

  if (existing) {
    const existingPath = path.resolve(storageRoot, existing.relativePath);
    if (fs.existsSync(existingPath)) {
      return {
        reused: {
          id: existing.id,
          filename: finalEditBgmFilename(existing.relativePath),
          relativePath: existing.relativePath,
          durationUs: existing.durationUs,
        },
      };
    }
  }

  const bgmRoot = path.join(storageRoot, 'bgm');
  try {
    if (!fs.existsSync(bgmRoot)) {
      fs.mkdirSync(bgmRoot, { recursive: true });
    }
    assertNoStorageSymlink(storageRoot, 'bgm');
  } catch (error) {
    throw new FinalEditError('bgm_write_failed', `无法准备音乐库目录：${error instanceof Error ? error.message : String(error)}`);
  }

  let placed: { filename: string; absolutePath: string };
  try {
    placed = await placeReadableFile(upload.temporaryPath, bgmRoot, safeName);
  } catch (error) {
    throw new FinalEditError('bgm_write_failed', `无法写入音乐文件"${safeName}"：${error instanceof Error ? error.message : String(error)}`);
  }

  const relativePath = `bgm/${placed.filename}`;
  const id = existing?.id || crypto.randomUUID();

  try {
    db.prepare(`INSERT INTO final_edit_bgm_tracks
      (id, relativePath, fileFingerprint, durationUs, format, status, errorMessage, scannedAt)
      VALUES (?, ?, ?, ?, ?, 'ready', NULL, ?)
      ON CONFLICT(fileFingerprint) DO UPDATE SET
        relativePath=excluded.relativePath,
        durationUs=excluded.durationUs,
        format=excluded.format,
        status='ready',
        errorMessage=NULL,
        scannedAt=excluded.scannedAt`).run(
      id,
      relativePath,
      fingerprint,
      durationUs,
      format,
      new Date().toISOString(),
    );

    const row = db.prepare(`
      SELECT id, relativePath, durationUs
      FROM final_edit_bgm_tracks
      WHERE fileFingerprint = ?
    `).get(fingerprint) as { id: string; relativePath: string; durationUs: number } | undefined;

    if (!row) {
      try { fs.unlinkSync(placed.absolutePath); } catch { /* best effort */ }
      throw new FinalEditError('bgm_index_failed', `无法索引"${safeName}"`);
    }

    if (row.relativePath !== relativePath) {
      try { fs.unlinkSync(placed.absolutePath); } catch { /* best effort */ }
      return {
        reused: {
          id: row.id,
          filename: finalEditBgmFilename(row.relativePath),
          relativePath: row.relativePath,
          durationUs: row.durationUs,
        },
      };
    }

    return {
      imported: {
        id: row.id,
        filename: finalEditBgmFilename(row.relativePath),
        relativePath: row.relativePath,
        durationUs: row.durationUs,
      },
    };
  } catch (error) {
    try { fs.unlinkSync(placed.absolutePath); } catch { /* best effort */ }
    if (error instanceof FinalEditError) throw error;
    throw new FinalEditError('bgm_index_failed', `无法索引"${safeName}"：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function importFinalEditBgmFiles(
  deps: BgmImportDependencies,
  uploads: BgmUpload[],
): Promise<BgmImportBatchResult> {
  return withBgmImportLock(async () => {
    const imported: FinalEditBgmTrackView[] = [];
    const reused: FinalEditBgmTrackView[] = [];
    const errors: BgmImportResponse['errors'] = [];
    let firstSuccessfulTrackId: string | null = null;

    for (const upload of uploads) {
      try {
        const result = await importSingleFile(deps, upload);
        if (result.imported) {
          imported.push(result.imported);
          if (firstSuccessfulTrackId === null) {
            firstSuccessfulTrackId = result.imported.id;
          }
        } else if (result.reused) {
          reused.push(result.reused);
          if (firstSuccessfulTrackId === null) {
            firstSuccessfulTrackId = result.reused.id;
          }
        } else if (result.error) {
          errors.push(result.error);
        }
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        throw new FinalEditError('bgm_write_failed', `导入中断：${err}`);
      }
    }

    return { firstSuccessfulTrackId, imported, reused, errors };
  });
}
