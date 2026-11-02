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
  {
    version: 2,
    sql: `
      CREATE TABLE team_users (
        id TEXT PRIMARY KEY,
        employeeId TEXT NOT NULL UNIQUE,
        displayName TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('employee', 'admin')),
        status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        passwordHash TEXT NOT NULL,
        mustChangePassword INTEGER NOT NULL DEFAULT 1 CHECK(mustChangePassword IN (0, 1)),
        credentialExpiresAt TEXT,
        sessionVersion INTEGER NOT NULL DEFAULT 1 CHECK(sessionVersion > 0),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE team_sessions (
        id TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL UNIQUE,
        userId TEXT NOT NULL,
        sessionVersion INTEGER NOT NULL CHECK(sessionVersion > 0),
        createdAt TEXT NOT NULL,
        absoluteExpiresAt TEXT NOT NULL,
        revokedAt TEXT,
        FOREIGN KEY (userId) REFERENCES team_users(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_team_sessions_user ON team_sessions(userId);
      CREATE INDEX idx_team_sessions_expiry ON team_sessions(absoluteExpiresAt);
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
  const employeeId = db.prepare(`
    SELECT type, "notnull" FROM pragma_table_info('team_users') WHERE name = 'employeeId'
  `).get() as { type: string; notnull: number } | undefined;
  const tokenHash = db.prepare(`
    SELECT type, "notnull" FROM pragma_table_info('team_sessions') WHERE name = 'tokenHash'
  `).get() as { type: string; notnull: number } | undefined;
  if (employeeId?.type.toUpperCase() !== 'TEXT' || employeeId.notnull !== 1
    || tokenHash?.type.toUpperCase() !== 'TEXT' || tokenHash.notnull !== 1) {
    throw new Error('team-service 身份结构检查未通过');
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
