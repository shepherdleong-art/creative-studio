import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Narrow navigation inbox; accepts identities, never an arbitrary URL or path. */
export function consumeFilmNavigationRequest(root: string, instanceId: string, now = Date.now()): { url: string; requestId?: string; bindingId?: string; deliveryVersion: number } | null {
  const file = join(root, 'storage/run/reassembled-navigation.json');
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const item = JSON.parse(raw) as Record<string, unknown>;
    if (item.instanceId !== instanceId || typeof item.createdAt !== 'number' || now - item.createdAt < 0 || now - item.createdAt > 30_000) return null;
    if (![item.projectId, item.groupId, item.shotSetId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v))) return null;
    if (!Number.isSafeInteger(item.deliveryVersion) || Number(item.deliveryVersion) < 1) return null;
    if (item.requestId !== undefined && (typeof item.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(item.requestId) || typeof item.bindingId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.bindingId))) return null;
    return { url: `/projects/${item.projectId}?${new URLSearchParams({ tab: 'final-edit', filmGroup: String(item.groupId), filmShotSet: String(item.shotSetId), deliveryVersion: String(item.deliveryVersion) })}`,
      requestId: item.requestId as string | undefined, bindingId: item.bindingId as string | undefined, deliveryVersion: Number(item.deliveryVersion) };
  } catch { return null; }
  finally { try { if (readFileSync(file, 'utf8') === raw) unlinkSync(file); } catch { /* another navigation or shutdown won */ } }
}

export function consumeFilmNavigation(root: string, instanceId: string, now = Date.now()): string | null {
  return consumeFilmNavigationRequest(root, instanceId, now)?.url ?? null;
}

export function completeFilmNavigation(root: string, instanceId: string, request: NonNullable<ReturnType<typeof consumeFilmNavigationRequest>>, ok: boolean): void {
  if (!request.requestId) return;
  const directory = join(root, 'storage/run/reassembled-navigation-results');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${request.requestId}.json`);
  writeFileSync(`${destination}.tmp`, JSON.stringify({ ok, requestId: request.requestId, instanceId, bindingId: request.bindingId, deliveryVersion: request.deliveryVersion, url: request.url }), { mode: 0o600 });
  renameSync(`${destination}.tmp`, destination);
}
