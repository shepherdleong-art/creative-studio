import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TransferError } from './errors.ts';
import { displayNameFromRelativePath, normalizeRelativeName } from './names.ts';

function candidatePath(directory: string, displayName: string, index: number): string {
  if (index === 0) return path.join(directory, displayName);
  const extension = path.extname(displayName);
  const stem = displayName.slice(0, displayName.length - extension.length);
  return path.join(directory, `${stem} (${index})${extension}`);
}

/** 主进程本地落盘辅助：先校验 .part，再用硬链接原子发布；EEXIST 时换名，绝不覆盖。 */
export async function publishVerifiedTeamDownload(input: {
  partPath: string;
  directory: string;
  displayName: string;
  expectedSize: number;
  expectedSha256: string;
  spaceProbe?: (requiredBytes: number) => void | Promise<void>;
}): Promise<{ absolutePath: string; byteSize: number; sha256: string }> {
  const displayName = displayNameFromRelativePath(normalizeRelativeName(input.displayName));
  const stat = fs.statSync(input.partPath);
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of fs.createReadStream(input.partPath)) {
    const buffer = chunk as Buffer;
    byteSize += buffer.length;
    if (byteSize > input.expectedSize) throw new TransferError('receipt_conflict', '下载字节超过固定 manifest 大小。');
    hash.update(buffer);
  }
  const digest = hash.digest('hex');
  if (!stat.isFile() || byteSize !== input.expectedSize || digest !== input.expectedSha256) {
    throw new TransferError('receipt_conflict', '下载文件大小或 SHA-256 校验失败，不能发布完成回执。');
  }
  await input.spaceProbe?.(byteSize);
  fs.mkdirSync(input.directory, { recursive: true });
  for (let index = 0; index < 10_000; index += 1) {
    const destination = candidatePath(input.directory, displayName, index);
    try {
      fs.linkSync(input.partPath, destination);
      fs.unlinkSync(input.partPath);
      return { absolutePath: destination, byteSize, sha256: digest };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new TransferError('insufficient_storage', '本机空间不足，下载未发布。');
      }
      throw error;
    }
  }
  throw new TransferError('receipt_conflict', '同名文件过多，无法选择不覆盖的目标名。');
}
