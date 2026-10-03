import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { dataRoot } from '../data-root.ts';
import { ScriptStudioError } from './errors.ts';

export const DIRECTORY_IMPORT_LIMITS = { files: 200, fileBytes: 32 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, pixels: 120_000_000 };

/** 只读取用户指定目录的直接图片子文件，复制进项目存储，原文件不改动。 */
export async function importImageDirectory(db: Database.Database, projectId: string, directoryPath: string, signal?: AbortSignal) {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new ScriptStudioError('not_found', '项目不存在');
  const requested = directoryPath.trim().replace(/^"(.*)"$/, '$1');
  if (!requested || !path.isAbsolute(requested)) throw new ScriptStudioError('invalid_input', '请输入图片文件夹的完整绝对路径');
  let directory: string;
  let names: string[];
  try {
    directory = await fs.realpath(requested);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.(jpe?g|png|webp)$/i.test(entry.name))
      .map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }) || a.localeCompare(b));
  } catch {
    throw new ScriptStudioError('invalid_input', '无法读取该文件夹，请检查路径、网络盘连接及工作台的访问权限');
  }
  if (!names.length) throw new ScriptStudioError('invalid_input', '该文件夹中没有 JPG、PNG 或 WebP 图片（不读取子文件夹）');
  if (names.length > DIRECTORY_IMPORT_LIMITS.files) throw new ScriptStudioError('resource_limit', `一次最多导入 ${DIRECTORY_IMPORT_LIMITS.files} 张图片，请拆分文件夹`);
  const storageRoot = path.join(dataRoot(), 'storage');
  const targetDir = path.join(storageRoot, 'originals', 'inputs');
  await fs.mkdir(targetDir, { recursive: true });
  const created: string[] = [];
  const files: Array<{ id: string; filename: string; imageUrl: string; role: string; usage: string; mimeType: string; originalWidth: number; originalHeight: number; size: number; originalPath: string }> = [];
  let totalBytes = 0;
  try {
    for (const filename of names) {
      if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError');
      const inputPath = path.join(directory, filename);
      const stat = await fs.lstat(inputPath);
      const resolved = await fs.realpath(inputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(resolved) !== directory) throw new ScriptStudioError('invalid_input', `文件已变化，请重新导入：${filename}`);
      totalBytes += stat.size;
      if (stat.size > DIRECTORY_IMPORT_LIMITS.fileBytes || totalBytes > DIRECTORY_IMPORT_LIMITS.totalBytes) throw new ScriptStudioError('resource_limit', '图片过大：单张最多 32 MB，单次导入最多 512 MB');
      const buffer = await fs.readFile(resolved);
      if (buffer.length !== stat.size) throw new ScriptStudioError('invalid_input', `图片正在变化，请稍后导入：${filename}`);
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(buffer, { limitInputPixels: DIRECTORY_IMPORT_LIMITS.pixels, failOn: 'error' }).metadata();
        if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || (metadata.orientation ?? 1) !== 1) throw new Error('invalid dimensions or orientation');
        // 真正解码以拒绝截断文件；小预览只用来校验，不保存、不替换原字节。
        await sharp(buffer, { limitInputPixels: DIRECTORY_IMPORT_LIMITS.pixels, failOn: 'error' }).resize({ width: 32, height: 32, fit: 'inside' }).raw().toBuffer();
      } catch {
        throw new ScriptStudioError('invalid_input', `图片损坏、尺寸过大、不是静态图片或带旋转标记（请先转正导出）：${filename}`);
      }
      const format = metadata.format;
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp') throw new ScriptStudioError('invalid_input', `不支持的图片格式：${filename}`);
      const id = randomUUID();
      const originalPath = path.join(targetDir, `${id}.${format === 'jpeg' ? 'jpg' : format}`);
      created.push(originalPath);
      await fs.writeFile(originalPath, buffer, { flag: 'wx' });
      files.push({ id, filename, originalPath, imageUrl: `/api/images/${path.relative(storageRoot, originalPath).split(path.sep).join('/')}`,
        role: 'input', usage: 'detail_page', mimeType: `image/${format}`, originalWidth: metadata.width!, originalHeight: metadata.height!, size: buffer.length });
    }
    if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError');
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO image_assets
        (id, projectId, role, filename, path, originalPath, mimeType, originalWidth, originalHeight, originalSizeBytes, preprocessingEnabled, usage, createdAt)
        VALUES (?, ?, 'input', ?, ?, ?, ?, ?, ?, ?, 0, 'detail_page', ?)`);
      const createdAt = new Date().toISOString();
      for (const file of files) insert.run(file.id, projectId, file.filename, file.originalPath, file.originalPath, file.mimeType, file.originalWidth, file.originalHeight, file.size, createdAt);
    })();
    return { files: files.map((file) => ({ id: file.id, filename: file.filename, imageUrl: file.imageUrl,
      role: file.role, usage: file.usage, mimeType: file.mimeType, originalWidth: file.originalWidth, originalHeight: file.originalHeight, size: file.size })), totalBytes };
  } catch (error) {
    await Promise.allSettled(created.map((file) => fs.unlink(file)));
    if (error instanceof ScriptStudioError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new ScriptStudioError('invalid_input', '导入失败，请确认图片可读、磁盘空间充足后重试');
  }
}
