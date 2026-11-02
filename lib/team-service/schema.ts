import type Database from 'better-sqlite3';
import {
  ensureVersionedSchemaReady,
  type VersionedSchemaMigration,
  type VersionedSchemaReadiness,
  type VersionedSchemaFailureCode,
} from '../schema-upgrade/versioned.ts';
import type { SchemaUpgradeDiskSpaceProbe } from '../schema-upgrade/backup.ts';

export const TEAM_SERVICE_MIGRATIONS: ReadonlyArray<VersionedSchemaMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS team_service_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        maintenance INTEGER NOT NULL DEFAULT 0 CHECK(maintenance IN (0, 1)),
        reason TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );
      INSERT INTO team_service_state (id, maintenance, reason, updatedAt)
      SELECT 1, 0, '', datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM team_service_state WHERE id = 1);
    `,
  },
];

export type TeamServiceSchemaReadiness = VersionedSchemaReadiness;
export type TeamServiceSchemaFailureCode = VersionedSchemaFailureCode;

function validateTeamServiceSchema(db: Database.Database): void {
  const row = db.prepare('SELECT id, maintenance FROM team_service_state WHERE id = 1').get() as
    | { id: number; maintenance: number }
    | undefined;
  if (!row || ![0, 1].includes(row.maintenance)) {
    throw new Error('team-service schema 结构检查未通过');
  }
}

export function ensureTeamServiceSchemaReady(options: {
  db: Database.Database;
  backupRoot: string;
  now?: () => Date;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
}): Promise<TeamServiceSchemaReadiness> {
  return ensureVersionedSchemaReady({
    ...options,
    scope: 'team-service',
    migrations: TEAM_SERVICE_MIGRATIONS,
    migrationTable: 'team_schema_migrations',
    validate: validateTeamServiceSchema,
  });
}
