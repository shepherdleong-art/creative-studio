import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './paths.ts';

export interface TeamRestoreHold {
  schemaVersion: 1;
  kind: 'team-restore-hold';
  backupId: string;
  createdAt: string;
  scheduling: false;
  automaticRetries: false;
  reason: 'restore_reconciliation_required';
}

export function teamRestoreHoldPath(dataRoot: string): string {
  return path.join(dataRoot, 'storage', 'maintenance', 'restore-hold.json');
}

export function hasTeamRestoreHold(dataRoot: string): boolean {
  const filePath = teamRestoreHoldPath(dataRoot);
  if (!fs.existsSync(filePath)) return false;
  const hold = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TeamRestoreHold>;
  if (hold.schemaVersion !== 1 || hold.kind !== 'team-restore-hold'
    || hold.scheduling !== false || hold.automaticRetries !== false) {
    throw new Error('restore hold 无效，保持禁调度');
  }
  return true;
}

export async function writeTeamRestoreHold(dataRoot: string, backupId: string, now: Date): Promise<TeamRestoreHold> {
  const hold: TeamRestoreHold = {
    schemaVersion: 1,
    kind: 'team-restore-hold',
    backupId,
    createdAt: now.toISOString(),
    scheduling: false,
    automaticRetries: false,
    reason: 'restore_reconciliation_required',
  };
  await writeJsonAtomic(teamRestoreHoldPath(dataRoot), hold);
  return hold;
}

export async function readTeamRestoreHold(dataRoot: string): Promise<TeamRestoreHold> {
  const hold = await readJsonFile<TeamRestoreHold>(teamRestoreHoldPath(dataRoot));
  if (hold.schemaVersion !== 1 || hold.kind !== 'team-restore-hold'
    || hold.scheduling !== false || hold.automaticRetries !== false) throw new Error('restore hold 无效');
  return hold;
}
