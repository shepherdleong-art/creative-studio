import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export function safeMaintenanceId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) {
    throw new Error(`${label} 无效`);
  }
  return value;
}

export function assertSafeRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('维护清单包含非法路径');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('维护清单包含越界路径');
  return parts.join('/');
}

export function assertPathInside(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('维护路径必须位于指定根目录内且不能是根目录');
  }
  return resolvedTarget;
}

export function assertNoSymlinkPath(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('维护路径不得包含符号链接或目录链接');
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function dataRootIdentity(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex');
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  assertNoSymlinkPath(path.dirname(filePath));
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fsPromises.rename(temporary, filePath);
  } catch (error) {
    await fsPromises.rm(temporary, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as T;
}

export async function removeDirectorySafely(root: string, target: string): Promise<void> {
  const resolved = assertPathInside(root, target);
  assertNoSymlinkPath(root);
  assertNoSymlinkPath(resolved);
  await fsPromises.rm(resolved, { recursive: true, force: false });
}

export async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('备份目录不得包含链接');
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) total += (await fsPromises.stat(absolute)).size;
      else throw new Error('备份目录只允许普通文件');
    }
  }
  return total;
}
