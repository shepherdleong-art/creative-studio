import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVICE_STATE_FILENAME = 'electron-service.json';

export interface PersistedServiceState {
  version: 1;
  origin: string;
  instanceId: string;
}

export function serviceStatePath(dataRoot: string): string {
  return join(dataRoot, 'storage', 'run', SERVICE_STATE_FILENAME);
}

export function persistServiceState(filePath: string, state: PersistedServiceState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${state.instanceId}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporaryPath, filePath);
  } catch {
    // Windows cannot replace an existing file with rename. The target is the
    // exact controlled state path and is removed only for this atomic update.
    try { unlinkSync(filePath); } catch { /* stale state may already be gone */ }
    renameSync(temporaryPath, filePath);
  }
}

export function clearServiceState(filePath: string, instanceId: string): void {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedServiceState>;
    if (parsed.instanceId === instanceId) unlinkSync(filePath);
  } catch {
    // Stale or already-removed state must not prevent process shutdown.
  }
}
