import path from 'node:path';

export function resolveStoragePath(storageRoot: string, relativeOrAbsolute: string, options: { allowAbsolute?: boolean } = {}): string {
  if (!relativeOrAbsolute || relativeOrAbsolute.split(/[\\/]/).includes('..')) throw new Error('不安全的 storage 路径');
  if (path.isAbsolute(relativeOrAbsolute) && !options.allowAbsolute) throw new Error('storage 相对路径不能是绝对路径');
  const root = path.resolve(storageRoot);
  const resolved = path.isAbsolute(relativeOrAbsolute) ? path.resolve(relativeOrAbsolute) : path.resolve(root, relativeOrAbsolute);
  if (!resolved.startsWith(root + path.sep)) throw new Error('storage 路径越界');
  return resolved;
}
export function toStorageRelativePath(storageRoot: string, relativeOrAbsolute: string): string {
  return path.relative(path.resolve(storageRoot), resolveStoragePath(storageRoot, relativeOrAbsolute, { allowAbsolute: true }));
}
