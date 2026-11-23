import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymlinkPath, assertSafeRelativePath, safeMaintenanceId, sha256File } from './paths.ts';
import type { TeamBackupFileEntry, TeamBackupManifest } from './backup.ts';

const HASH = /^[a-f0-9]{64}$/;
const mediaRoot = (backupRoot: string, deploymentId: string) =>
  path.join(backupRoot, 'daily-media-v1', safeMaintenanceId(deploymentId, 'deploymentId'));

function objectPath(backupRoot: string, deploymentId: string, sha256: string): string {
  if (!HASH.test(sha256)) throw new Error('媒体清单 SHA-256 无效');
  const target = path.join(mediaRoot(backupRoot, deploymentId), sha256.slice(0, 2), sha256);
  assertNoSymlinkPath(target);
  return target;
}

export function backupMediaPath(directory: string, manifest: TeamBackupManifest, file: TeamBackupFileEntry): string {
  const relative = assertSafeRelativePath(file.relativePath);
  if (manifest.schemaVersion === 2) {
    if (manifest.type !== 'daily' || path.basename(path.dirname(directory)) !== 'daily') throw new Error('每日还原点目录无效');
    return objectPath(path.dirname(path.dirname(directory)), manifest.deploymentId, file.sha256);
  }
  const target = path.join(directory, 'files', ...relative.split('/'));
  assertNoSymlinkPath(target);
  return target;
}

async function matches(filePath: string, file: TeamBackupFileEntry): Promise<boolean> {
  const stat = await fs.lstat(filePath);
  return stat.isFile() && stat.size === file.byteSize && await sha256File(filePath) === file.sha256;
}

/** 共享库只发布校验后的文件。临时文件由当前 staging 的成功/失败清理负责。 */
export async function storeDailyMedia(options: {
  backupRoot: string; deploymentId: string; staging: string; source: string; file: TeamBackupFileEntry;
  copy: (source: string, destination: string) => Promise<void>;
}): Promise<number> {
  const { file, source } = options;
  const target = objectPath(options.backupRoot, options.deploymentId, file.sha256);
  const reusable = await matches(target, file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (reusable) {
    // 文件登记后不可原位改写。不能用昨天的正确副本掩盖生产文件丢失或损坏。
    if (!await matches(source, file)) throw new Error(`媒体备份校验失败：${file.fileId}`);
    return 0;
  }
  const temporary = path.join(options.staging, 'media-object.tmp');
  await options.copy(source, temporary);
  if (!await matches(temporary, file)) throw new Error(`媒体备份校验失败：${file.fileId}`);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.rename(temporary, target);
  return file.byteSize;
}

/** 调用方持有备份盘写锁，且已核清所有已发布还原点的引用。未知目录和文件原样保留。 */
export async function pruneDailyMedia(backupRoot: string, deploymentId: string, retained: ReadonlySet<string>) {
  const root = mediaRoot(backupRoot, deploymentId);
  assertNoSymlinkPath(root);
  const shards = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    const entries = await fs.readdir(path.join(root, shard.name), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && HASH.test(entry.name) && entry.name.startsWith(shard.name) && !retained.has(entry.name)) {
        await fs.unlink(objectPath(backupRoot, deploymentId, entry.name));
      }
    }
  }
}
