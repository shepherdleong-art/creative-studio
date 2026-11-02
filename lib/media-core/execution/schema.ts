import type Database from 'better-sqlite3';
import {
  ensureVersionedSchemaReady,
  type VersionedSchemaMigration,
  type VersionedSchemaReadiness,
  type VersionedSchemaFailureCode,
} from '../../schema-upgrade/versioned.ts';
import type { SchemaUpgradeDiskSpaceProbe } from '../../schema-upgrade/backup.ts';
import type { ExecutionInstanceIdentity } from './contracts.ts';

export const EXECUTION_MIGRATIONS: ReadonlyArray<VersionedSchemaMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS execution_instances (
        instanceId TEXT PRIMARY KEY,
        fence INTEGER NOT NULL UNIQUE CHECK(fence > 0),
        deploymentId TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        stoppedAt TEXT
      );
    `,
  },
];

export type ExecutionSchemaReadiness = VersionedSchemaReadiness;
export type ExecutionSchemaFailureCode = VersionedSchemaFailureCode;

function validateExecutionSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(execution_instances)').all() as Array<{
    name: string;
    notnull: number;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    byName.get('instanceId')?.pk !== 1
    || byName.get('fence')?.notnull !== 1
    || byName.get('deploymentId')?.notnull !== 1
    || byName.get('startedAt')?.notnull !== 1
  ) {
    throw new Error('execution schema 结构检查未通过');
  }
}

export function ensureExecutionSchemaReady(options: {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<ExecutionSchemaReadiness> {
  return ensureVersionedSchemaReady({
    ...options,
    scope: 'execution',
    migrations: EXECUTION_MIGRATIONS,
    migrationTable: 'execution_schema_migrations',
    validate: validateExecutionSchema,
  });
}

export function registerExecutionInstance(
  db: Database.Database,
  identity: ExecutionInstanceIdentity & { deploymentId: string },
): void {
  db.prepare(`
    INSERT INTO execution_instances (instanceId, fence, deploymentId, startedAt)
    VALUES (?, ?, ?, ?)
  `).run(identity.instanceId, identity.fence, identity.deploymentId, new Date().toISOString());
}
