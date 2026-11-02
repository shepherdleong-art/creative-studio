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
  {
    version: 3,
    sql: `
      CREATE TABLE team_resource_scopes (
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        ownerUserId TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'public')),
        parentType TEXT,
        parentId TEXT,
        rootType TEXT NOT NULL,
        rootId TEXT NOT NULL,
        deletedAt TEXT,
        deletedBy TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (resourceType, resourceId),
        FOREIGN KEY (ownerUserId) REFERENCES team_users(id),
        FOREIGN KEY (deletedBy) REFERENCES team_users(id),
        FOREIGN KEY (parentType, parentId) REFERENCES team_resource_scopes(resourceType, resourceId),
        FOREIGN KEY (rootType, rootId) REFERENCES team_resource_scopes(resourceType, resourceId),
        CHECK ((parentType IS NULL) = (parentId IS NULL))
      );
      CREATE INDEX idx_team_scopes_owner ON team_resource_scopes(ownerUserId, resourceType, deletedAt);
      CREATE INDEX idx_team_scopes_parent ON team_resource_scopes(parentType, parentId);
      CREATE INDEX idx_team_scopes_root ON team_resource_scopes(rootType, rootId);

      CREATE TABLE team_task_principals (
        module TEXT NOT NULL,
        taskId TEXT NOT NULL,
        actorUserId TEXT NOT NULL,
        scopeType TEXT NOT NULL,
        scopeId TEXT NOT NULL,
        creationSnapshot TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (module, taskId),
        FOREIGN KEY (actorUserId) REFERENCES team_users(id),
        FOREIGN KEY (scopeType, scopeId) REFERENCES team_resource_scopes(resourceType, resourceId)
      );
      CREATE INDEX idx_team_task_actor ON team_task_principals(actorUserId, createdAt);
      CREATE INDEX idx_team_task_scope ON team_task_principals(scopeType, scopeId);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE team_font_favorites (
        userId TEXT NOT NULL,
        identity TEXT NOT NULL,
        family TEXT NOT NULL,
        favorite INTEGER NOT NULL CHECK(favorite IN (0, 1)),
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, identity),
        FOREIGN KEY (userId) REFERENCES team_users(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_team_font_favorites_user ON team_font_favorites(userId, favorite, updatedAt);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE team_files (
        id TEXT PRIMARY KEY,
        seriesId TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        ownerUserId TEXT NOT NULL,
        relativePath TEXT NOT NULL UNIQUE,
        mimeType TEXT NOT NULL,
        byteSize INTEGER NOT NULL CHECK(byteSize >= 0),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        state TEXT NOT NULL CHECK(state IN ('staged', 'ready', 'purge_pending')),
        derivedFromFileId TEXT,
        readySeq INTEGER UNIQUE,
        createdAt TEXT NOT NULL,
        readyAt TEXT,
        FOREIGN KEY (ownerUserId) REFERENCES team_users(id),
        FOREIGN KEY (derivedFromFileId) REFERENCES team_files(id),
        UNIQUE(seriesId, version),
        CHECK ((state = 'ready') = (readySeq IS NOT NULL)),
        CHECK ((state = 'ready') = (readyAt IS NOT NULL))
      );
      CREATE INDEX idx_team_files_series ON team_files(seriesId, version DESC);
      CREATE INDEX idx_team_files_ready ON team_files(readySeq) WHERE state = 'ready';
      CREATE INDEX idx_team_files_derived ON team_files(derivedFromFileId);

      CREATE TABLE team_file_references (
        fileId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('input', 'output', 'derivative', 'export', 'delivery', 'backup')),
        pinKind TEXT NOT NULL CHECK(pinKind IN ('entity', 'accepted_task', 'export', 'backup')),
        createdAt TEXT NOT NULL,
        releasedAt TEXT,
        FOREIGN KEY (fileId) REFERENCES team_files(id) ON DELETE CASCADE,
        FOREIGN KEY (resourceType, resourceId) REFERENCES team_resource_scopes(resourceType, resourceId)
      );
      CREATE UNIQUE INDEX idx_team_file_reference_active
        ON team_file_references(fileId, resourceType, resourceId, role, pinKind)
        WHERE releasedAt IS NULL;
      CREATE INDEX idx_team_file_reference_resource
        ON team_file_references(resourceType, resourceId, releasedAt);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE team_lifecycle_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('delete', 'restore')),
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        actorUserId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (actorUserId) REFERENCES team_users(id)
      );
      CREATE INDEX idx_team_lifecycle_event_resource
        ON team_lifecycle_events(resourceType, resourceId, action, createdAt);

      CREATE TABLE team_lifecycle_event_scopes (
        eventId TEXT NOT NULL,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        PRIMARY KEY (eventId, resourceType, resourceId),
        FOREIGN KEY (eventId) REFERENCES team_lifecycle_events(id) ON DELETE CASCADE
      );

      CREATE TABLE team_lifecycle_barriers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('backup', 'release', 'config')),
        ownerUserId TEXT NOT NULL,
        metadataJson TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        releasedAt TEXT,
        FOREIGN KEY (ownerUserId) REFERENCES team_users(id)
      );
      CREATE INDEX idx_team_lifecycle_barriers_active
        ON team_lifecycle_barriers(kind, releasedAt);

      CREATE TABLE team_backup_pins (
        id TEXT PRIMARY KEY,
        ownerUserId TEXT NOT NULL,
        releaseId TEXT NOT NULL,
        configVersion TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        releasedAt TEXT,
        FOREIGN KEY (ownerUserId) REFERENCES team_users(id)
      );
      CREATE INDEX idx_team_backup_pins_active ON team_backup_pins(releasedAt);

      CREATE TABLE team_cleanup_jobs (
        id TEXT PRIMARY KEY,
        resourceType TEXT NOT NULL,
        resourceId TEXT NOT NULL,
        requestedBy TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'deferred', 'completed', 'failed')),
        phase TEXT NOT NULL CHECK(phase IN ('plan', 'database', 'files', 'done')),
        blockersJson TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (requestedBy) REFERENCES team_users(id)
      );
      CREATE INDEX idx_team_cleanup_jobs_resource
        ON team_cleanup_jobs(resourceType, resourceId, status);

      CREATE TABLE team_cleanup_files (
        jobId TEXT NOT NULL,
        fileId TEXT NOT NULL,
        relativePath TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'unlinked', 'missing', 'verified')),
        error TEXT,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (jobId, fileId),
        FOREIGN KEY (jobId) REFERENCES team_cleanup_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (fileId) REFERENCES team_files(id)
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE team_uploads (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        deviceId TEXT,
        targetResourceType TEXT NOT NULL,
        targetResourceId TEXT NOT NULL,
        usage TEXT NOT NULL,
        relativeName TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        expectedSize INTEGER NOT NULL CHECK(expectedSize > 0),
        expectedSha256 TEXT NOT NULL CHECK(length(expectedSha256) = 64),
        sourceFingerprint TEXT NOT NULL,
        partSize INTEGER NOT NULL CHECK(partSize > 0),
        idempotencyKey TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('receiving', 'validating', 'staged', 'ready', 'cancelled', 'failed')),
        fileId TEXT NOT NULL UNIQUE,
        resultResourceType TEXT,
        resultResourceId TEXT,
        errorCode TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT,
        FOREIGN KEY (userId) REFERENCES team_users(id),
        FOREIGN KEY (targetResourceType, targetResourceId) REFERENCES team_resource_scopes(resourceType, resourceId),
        UNIQUE(userId, idempotencyKey)
      );
      CREATE INDEX idx_team_uploads_user_state ON team_uploads(userId, state, updatedAt);
      CREATE INDEX idx_team_uploads_target ON team_uploads(targetResourceType, targetResourceId);

      CREATE TABLE team_upload_parts (
        uploadId TEXT NOT NULL,
        partNumber INTEGER NOT NULL CHECK(partNumber > 0),
        byteSize INTEGER NOT NULL CHECK(byteSize > 0),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        state TEXT NOT NULL CHECK(state IN ('ready')),
        createdAt TEXT NOT NULL,
        PRIMARY KEY (uploadId, partNumber),
        FOREIGN KEY (uploadId) REFERENCES team_uploads(id) ON DELETE CASCADE
      );

      CREATE TABLE team_devices (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        deploymentId TEXT NOT NULL,
        clientDeviceId TEXT NOT NULL,
        displayName TEXT NOT NULL,
        platform TEXT NOT NULL,
        subscriptionCursor INTEGER NOT NULL CHECK(subscriptionCursor >= 0),
        createdAt TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        revokedAt TEXT,
        FOREIGN KEY (userId) REFERENCES team_users(id) ON DELETE CASCADE,
        UNIQUE(deploymentId, userId, clientDeviceId)
      );
      CREATE INDEX idx_team_devices_user ON team_devices(userId, revokedAt, lastSeenAt);

      CREATE TABLE team_download_receipts (
        userId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        fileId TEXT NOT NULL,
        artifactVersion INTEGER NOT NULL CHECK(artifactVersion > 0),
        state TEXT NOT NULL CHECK(state IN ('pending', 'downloading', 'completed', 'failed', 'suppressed')),
        etag TEXT,
        verifiedSha256 TEXT,
        failureCode TEXT,
        attemptCount INTEGER NOT NULL DEFAULT 0 CHECK(attemptCount >= 0),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        completedAt TEXT,
        PRIMARY KEY (userId, deviceId, fileId),
        FOREIGN KEY (userId) REFERENCES team_users(id) ON DELETE CASCADE,
        FOREIGN KEY (deviceId) REFERENCES team_devices(id) ON DELETE CASCADE,
        FOREIGN KEY (fileId) REFERENCES team_files(id)
      );
      CREATE INDEX idx_team_download_receipts_device ON team_download_receipts(deviceId, state, updatedAt);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE team_uploads ADD COLUMN targetKind TEXT;
      CREATE INDEX idx_team_uploads_target_kind ON team_uploads(targetKind, state);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE team_error_records (
        id TEXT PRIMARY KEY,
        actorUserId TEXT NOT NULL,
        module TEXT NOT NULL,
        taskId TEXT,
        operationId TEXT,
        attemptId TEXT,
        scopeType TEXT,
        scopeId TEXT,
        stage TEXT NOT NULL CHECK(stage IN (
          'upload', 'remote_submit', 'remote_poll', 'download', 'local_media',
          'client_update', 'server_release', 'server_config'
        )),
        code TEXT NOT NULL,
        statusCode INTEGER,
        safeMessage TEXT NOT NULL,
        clientVersion TEXT,
        serverReleaseId TEXT,
        configVersion TEXT,
        clientEventId TEXT,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (actorUserId) REFERENCES team_users(id)
      );
      CREATE UNIQUE INDEX idx_team_error_client_event
        ON team_error_records(actorUserId, clientEventId) WHERE clientEventId IS NOT NULL;
      CREATE INDEX idx_team_error_actor_created ON team_error_records(actorUserId, createdAt DESC);
      CREATE INDEX idx_team_error_attempt ON team_error_records(attemptId);
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
  for (const table of [
    'team_resource_scopes', 'team_task_principals', 'team_font_favorites', 'team_files', 'team_file_references',
    'team_lifecycle_events', 'team_lifecycle_event_scopes', 'team_lifecycle_barriers',
    'team_backup_pins', 'team_cleanup_jobs', 'team_cleanup_files',
    'team_uploads', 'team_upload_parts', 'team_devices', 'team_download_receipts', 'team_error_records',
  ]) {
    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) {
      throw new Error(`team-service 缺少 ${table} 结构`);
    }
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
