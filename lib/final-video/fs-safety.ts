// lib/final-video/fs-safety.ts
// Canonical "is this path strictly inside that root" check. Every final-video
// module that resolves a storage/draft/narration path from database- or
// user-derived input must run it before touching disk.
import path from 'node:path';

export function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertPathWithinRoot(root: string, target: string, message: string): string {
  if (!isPathWithinRoot(root, target)) throw new Error(message);
  return target;
}
