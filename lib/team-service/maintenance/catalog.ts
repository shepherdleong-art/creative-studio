import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyTeamBackup, TEAM_BACKUP_TYPES, type TeamBackupManifest, type TeamBackupSuccess } from './backup.ts';
import { assertPathInside, safeMaintenanceId } from './paths.ts';

export interface TeamBackupListItem {
  id: string;
  type: TeamBackupManifest['type'];
  createdAt: string;
  totalBytes: number;
  verification: 'verified' | 'invalid' | 'pending';
  verifiedAt: string | null;
  restorable: boolean;
}

export function backupDirectory(backupRoot: string, type: TeamBackupManifest['type'], id: string): string {
  if (!TEAM_BACKUP_TYPES.includes(type)) throw new Error('备份类型无效');
  safeMaintenanceId(id, 'backupId');
  const root = path.resolve(backupRoot, type);
  return assertPathInside(root, path.join(root, id));
}

export async function listTeamBackups(backupRoot: string, deploymentId: string): Promise<{ backups: TeamBackupListItem[] }> {
  const backups: TeamBackupListItem[] = [];
  for (const type of TEAM_BACKUP_TYPES) {
    const typeRoot = path.join(backupRoot, type);
    if (!fs.existsSync(typeRoot)) continue;
    for (const entry of await fsPromises.readdir(typeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try { safeMaintenanceId(entry.name, 'backupId'); } catch { continue; }
      const directory = backupDirectory(backupRoot, type, entry.name);
      try {
        const verification = await verifyTeamBackup(directory);
        if (!verification.verified) {
          backups.push({ id: entry.name, type, createdAt: '', totalBytes: 0, verification: 'invalid', verifiedAt: null, restorable: false });
          continue;
        }
        const manifest = verification.manifest;
        const success = JSON.parse(await fsPromises.readFile(path.join(directory, 'success.json'), 'utf8')) as TeamBackupSuccess;
        if (manifest.deploymentId !== deploymentId || typeof success.verifiedAt !== 'string'
          || !Number.isSafeInteger(success.totalBytes) || success.totalBytes < 0) {
          backups.push({ id: entry.name, type, createdAt: manifest.createdAt, totalBytes: 0, verification: 'invalid', verifiedAt: null, restorable: false });
          continue;
        }
        const backupDb = new Database(path.join(directory, 'data', 'workbench.db'), { readonly: true, fileMustExist: true });
        try {
          if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('integrity');
        } finally { backupDb.close(); }
        backups.push({
          id: entry.name, type, createdAt: manifest.createdAt, totalBytes: success.totalBytes,
          verification: 'verified', verifiedAt: success.verifiedAt, restorable: true,
        });
      } catch {
        backups.push({ id: entry.name, type, createdAt: '', totalBytes: 0, verification: 'invalid', verifiedAt: null, restorable: false });
      }
    }
  }
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return { backups };
}
