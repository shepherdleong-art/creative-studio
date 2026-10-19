import type Database from 'better-sqlite3';
import {
  createValidatedSchemaUpgradeBackup,
  SchemaUpgradeBackupError,
  type SchemaUpgradeBackupManifest,
  type SchemaUpgradeDiskSpaceProbe,
} from '../schema-upgrade/backup.ts';

export type BatchSchemaBackupManifest = SchemaUpgradeBackupManifest;
export type BatchSchemaDiskSpaceProbe = SchemaUpgradeDiskSpaceProbe;
export type BatchSchemaBackupFailureCode = SchemaUpgradeBackupError['code'];
export { SchemaUpgradeBackupError as BatchSchemaBackupError };

export function createValidatedBatchSchemaBackup(params: {
  db: Database.Database;
  backupRoot: string;
  sourceVersions: number[];
  targetVersion: number;
  now: Date;
  diskSpaceProbe?: BatchSchemaDiskSpaceProbe;
}): Promise<{ directory: string; manifest: BatchSchemaBackupManifest }> {
  return createValidatedSchemaUpgradeBackup({
    ...params,
    scope: 'batch-production',
  });
}
