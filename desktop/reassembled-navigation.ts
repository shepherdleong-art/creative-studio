import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** storage/run/reassembled-navigation.json 的收件箱条目结构。 */
interface ReassembledNavigationItem {
  instanceId: string;
  createdAt: number;
  projectId: string;
  groupId: string;
  shotSetId: string;
  deliveryVersion: number;
}

/** Narrow navigation inbox; accepts identities, never an arbitrary URL or path. */
export function consumeFilmNavigation(root: string, instanceId: string, now: number = Date.now()): string | null {
  const file = join(root, 'storage/run/reassembled-navigation.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const item = JSON.parse(raw) as ReassembledNavigationItem;
    if (item.instanceId !== instanceId || typeof item.createdAt !== 'number' || now - item.createdAt < 0 || now - item.createdAt > 30_000) return null;
    if (![item.projectId, item.groupId, item.shotSetId].every((v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v))) return null;
    if (!Number.isSafeInteger(item.deliveryVersion) || Number(item.deliveryVersion) < 1) return null;
    return `/projects/${item.projectId}?${new URLSearchParams({ tab: 'final-edit', filmGroup: String(item.groupId), filmShotSet: String(item.shotSetId), deliveryVersion: String(item.deliveryVersion) })}`;
  } catch {
    return null;
  } finally {
    try {
      if (readFileSync(file, 'utf8') === raw) unlinkSync(file);
    } catch { /* another navigation or shutdown won */ }
  }
}