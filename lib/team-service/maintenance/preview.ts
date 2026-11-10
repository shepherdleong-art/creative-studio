import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { TeamReleaseCurrentVersion, TeamReleaseCandidate } from './release-candidates.ts';
import type { TeamReleaseIdentity } from './release.ts';
import type { TeamBackupListItem } from './catalog.ts';

export type MaintenancePreviewRequest =
  | { kind: 'backups'; backupRoot: string; deploymentId: string; currentRelease: TeamReleaseIdentity }
  | { kind: 'candidates'; candidateRoot: string; current: TeamReleaseCurrentVersion; allowFixtureForTests: boolean };
type PreviewResult = { backups: TeamBackupListItem[] } | TeamReleaseCandidate[];

/** One bounded, read-only child at a time. HTTP requests share work; restore and
 * release execution continue to revalidate independently of this display cache. */
export function createMaintenancePreviewReader(options: { scriptPath?: string; timeoutMs?: number; cacheMs?: number } = {}) {
  const entries = new Map<string, { promise: Promise<PreviewResult>; expiresAt: number }>();
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let stopped = false;
  let child: ChildProcess | undefined;
  // The server packager copies this CLI separately; it is not a Next module.
  const script = options.scriptPath ?? path.join(/* turbopackIgnore: true */ process.env.CREATIVE_STUDIO_APPLICATION_ROOT || process.cwd(), 'scripts', 'team-server', 'preview.mjs');

  function execute(request: MaintenancePreviewRequest): Promise<PreviewResult> {
    if (stopped) return Promise.reject(new Error('维护列表读取已停止'));
    return new Promise((resolve, reject) => {
      const running = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child = running;
      let result: PreviewResult | undefined;
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error('维护列表校验超时，请稍后重试');
        running.kill();
      }, options.timeoutMs ?? 10 * 60_000);
      running.on('message', (message: { ok?: boolean; result?: PreviewResult }) => {
        if (message?.ok === true && message.result) result = message.result;
        else failure = new Error('维护列表校验失败，请核查维护存储');
      });
      running.once('error', () => { failure = new Error('无法启动维护列表校验进程'); });
      running.once('close', (code) => {
        clearTimeout(timer);
        if (child === running) child = undefined;
        if (stopped) reject(new Error('维护列表读取已停止'));
        else if (failure || code !== 0 || result === undefined) reject(failure ?? new Error('维护列表校验进程提前退出'));
        else resolve(result);
      });
      running.send(request, (error) => {
        if (error) { failure = new Error('无法提交维护列表读取'); running.kill(); }
      });
    });
  }

  function read(request: MaintenancePreviewRequest): Promise<PreviewResult> {
    if (stopped) return Promise.reject(new Error('维护列表读取已停止'));
    const key = JSON.stringify(request);
    const cached = entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(entryKey);
    if (pending >= 4) return Promise.reject(new Error('维护列表校验繁忙，请稍后重试'));
    pending += 1;
    const entry = { promise: Promise.resolve(undefined as unknown as PreviewResult), expiresAt: Infinity };
    entry.promise = tail.then(() => execute(request)).then((result) => {
      // Backup refresh must observe a just-completed backup or changed media.
      entry.expiresAt = Date.now() + (options.cacheMs ?? (request.kind === 'backups' ? 0 : 30_000));
      return result;
    }, (error) => {
      entries.delete(key);
      throw error;
    }).finally(() => { pending -= 1; });
    // A failed job must not poison the next queued job.
    tail = entry.promise.catch(() => undefined);
    entries.set(key, entry);
    return entry.promise;
  }
  return {
    read,
    invalidate: () => { for (const [key, entry] of entries) if (entry.expiresAt !== Infinity) entries.delete(key); },
    stop: async () => {
      stopped = true;
      entries.clear();
      child?.kill();
      await tail;
    },
  };
}

const globalState = globalThis as typeof globalThis & { __teamMaintenancePreview?: ReturnType<typeof createMaintenancePreviewReader> };
function reader() { return globalState.__teamMaintenancePreview ??= createMaintenancePreviewReader(); }
export async function readBackupPreview(input: Omit<Extract<MaintenancePreviewRequest, { kind: 'backups' }>, 'kind'>) {
  return await reader().read({ kind: 'backups', ...input }) as { backups: TeamBackupListItem[] };
}
export async function readCandidatePreview(input: Omit<Extract<MaintenancePreviewRequest, { kind: 'candidates' }>, 'kind'>) {
  return await reader().read({ kind: 'candidates', ...input }) as TeamReleaseCandidate[];
}
export function invalidateMaintenancePreviews() { globalState.__teamMaintenancePreview?.invalidate(); }
export async function stopMaintenancePreviews() { await globalState.__teamMaintenancePreview?.stop(); }
