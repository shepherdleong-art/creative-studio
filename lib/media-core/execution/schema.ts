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
  {
    version: 2,
    sql: `
      CREATE TABLE execution_operations (
        id TEXT PRIMARY KEY,
        operationKey TEXT NOT NULL,
        actorId TEXT NOT NULL,
        scopeType TEXT NOT NULL,
        scopeId TEXT NOT NULL,
        module TEXT NOT NULL,
        taskId TEXT NOT NULL,
        step TEXT NOT NULL,
        inputRevision TEXT NOT NULL,
        businessAttemptId TEXT NOT NULL,
        businessAttemptNo INTEGER NOT NULL CHECK(businessAttemptNo > 0),
        inputHash TEXT NOT NULL,
        inputSnapshotJson TEXT NOT NULL,
        continuationKey TEXT NOT NULL,
        providerSnapshotJson TEXT NOT NULL,
        configVersion TEXT,
        credentialVersionRef TEXT,
        requiredPoolsJson TEXT NOT NULL,
        quoteJson TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'deferred', 'admitted', 'maybe_sent', 'accepted',
          'reconciling', 'succeeded', 'failed', 'unknown'
        )),
        readySeq INTEGER NOT NULL UNIQUE,
        waitReason TEXT,
        waitDetail TEXT,
        currentPermitId TEXT,
        currentAttemptId TEXT,
        resultJson TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(actorId, operationKey)
      );
      CREATE INDEX idx_execution_operations_ready ON execution_operations(status, actorId, readySeq);
      CREATE INDEX idx_execution_operations_task ON execution_operations(module, taskId);

      CREATE TABLE execution_attempts (
        id TEXT PRIMARY KEY,
        operationId TEXT NOT NULL,
        permitId TEXT NOT NULL,
        actorId TEXT NOT NULL,
        businessAttemptNo INTEGER NOT NULL CHECK(businessAttemptNo > 0),
        submitRound INTEGER NOT NULL CHECK(submitRound > 0),
        transportSeq INTEGER NOT NULL CHECK(transportSeq > 0),
        requestHash TEXT,
        providerSnapshotJson TEXT NOT NULL,
        pricingSnapshotJson TEXT,
        submissionState TEXT NOT NULL CHECK(submissionState IN ('not_sent', 'maybe_sent', 'accepted', 'terminal')),
        terminalState TEXT CHECK(terminalState IS NULL OR terminalState IN ('succeeded', 'failed', 'not_created')),
        instanceId TEXT NOT NULL,
        fence INTEGER NOT NULL,
        leaseOwner TEXT NOT NULL,
        leaseUntil TEXT NOT NULL,
        remoteId TEXT,
        receiptJson TEXT,
        intentJournalSeq INTEGER,
        receiptJournalSeq INTEGER,
        errorCode TEXT,
        policyVersion INTEGER NOT NULL,
        accountingPeriod TEXT NOT NULL,
        currency TEXT NOT NULL CHECK(currency = 'CNY'),
        reservedMinor INTEGER NOT NULL CHECK(reservedMinor >= 0),
        actualMinor INTEGER CHECK(actualMinor IS NULL OR actualMinor >= 0),
        costState TEXT NOT NULL CHECK(costState IN ('reserved', 'unknown', 'settled', 'released')),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(operationId, transportSeq),
        UNIQUE(permitId, transportSeq),
        FOREIGN KEY (operationId) REFERENCES execution_operations(id)
      );
      CREATE INDEX idx_execution_attempts_inflight ON execution_attempts(submissionState, operationId);
      CREATE INDEX idx_execution_attempts_permit ON execution_attempts(permitId, submissionState);

      CREATE TABLE execution_pools (
        poolKey TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('upload', 'remote', 'download', 'media')),
        capacity INTEGER NOT NULL CHECK(capacity >= 0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        mappingSnapshotJson TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE execution_actor_policies (
        actorId TEXT PRIMARY KEY,
        monthlyLimitMinor INTEGER CHECK(monthlyLimitMinor IS NULL OR monthlyLimitMinor >= 0),
        currency TEXT NOT NULL CHECK(currency = 'CNY'),
        personalConcurrency INTEGER NOT NULL CHECK(personalConcurrency >= 0),
        paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
        timezone TEXT NOT NULL CHECK(timezone = 'Asia/Shanghai'),
        version INTEGER NOT NULL CHECK(version > 0),
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE execution_reservations (
        id TEXT PRIMARY KEY,
        operationId TEXT,
        permitId TEXT NOT NULL,
        attemptId TEXT,
        actorId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('concurrency', 'cost')),
        poolKey TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('held', 'settled', 'released')),
        accountingPeriod TEXT,
        currency TEXT CHECK(currency IS NULL OR currency = 'CNY'),
        reservedMinor INTEGER CHECK(reservedMinor IS NULL OR reservedMinor >= 0),
        actualMinor INTEGER CHECK(actualMinor IS NULL OR actualMinor >= 0),
        costState TEXT CHECK(costState IS NULL OR costState IN ('reserved', 'unknown', 'settled', 'released')),
        policyVersion INTEGER,
        createdAt TEXT NOT NULL,
        settledAt TEXT,
        releasedAt TEXT,
        releaseReason TEXT
      );
      CREATE UNIQUE INDEX idx_execution_concurrency_permit_pool ON execution_reservations(permitId, poolKey)
        WHERE kind = 'concurrency';
      CREATE UNIQUE INDEX idx_execution_cost_attempt ON execution_reservations(attemptId)
        WHERE kind = 'cost' AND attemptId IS NOT NULL;
      CREATE INDEX idx_execution_reservations_held_pool ON execution_reservations(poolKey, state, kind);
      CREATE INDEX idx_execution_reservations_cost ON execution_reservations(actorId, accountingPeriod, state);

      CREATE TABLE execution_admission_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        nextReadySeq INTEGER NOT NULL CHECK(nextReadySeq > 0),
        cursorActorId TEXT
      );
      INSERT INTO execution_admission_state (id, nextReadySeq, cursorActorId)
      VALUES (1, 1, NULL);

      CREATE TABLE execution_reconciliation_orphans (
        attemptId TEXT PRIMARY KEY,
        operationId TEXT NOT NULL,
        permitId TEXT NOT NULL,
        actorId TEXT NOT NULL,
        evidenceJson TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('unknown', 'accepted', 'terminal')),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE execution_operations ADD COLUMN serverReleaseId TEXT;
      ALTER TABLE execution_operations ADD COLUMN clientVersion TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE execution_pool_bindings (
        bindingKey TEXT PRIMARY KEY,
        poolKey TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (poolKey) REFERENCES execution_pools(poolKey)
      );
    `,
  },
  {
    version: 5,
    // null keeps existing accounts unrestricted; [] denies every model.
    sql: `ALTER TABLE execution_actor_policies ADD COLUMN allowedModelsJson TEXT
      CHECK (allowedModelsJson IS NULL OR (json_valid(allowedModelsJson) AND json_type(allowedModelsJson) = 'array'));`,
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
  const schemaVersion = db.prepare('SELECT MAX(version) AS version FROM execution_schema_migrations').pluck().get() as number;
  if (schemaVersion >= 2) {
    for (const table of [
      'execution_operations', 'execution_attempts', 'execution_pools',
      'execution_actor_policies', 'execution_reservations', 'execution_admission_state',
      'execution_reconciliation_orphans',
    ]) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`execution 缺少 ${table} 结构`);
      }
    }
  }
  if (schemaVersion >= 4
    && !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_pool_bindings'").get()) {
    throw new Error('execution 缺少 execution_pool_bindings 结构');
  }
  if (schemaVersion >= 5 && !(db.prepare('PRAGMA table_info(execution_actor_policies)').all() as Array<{ name: string }>).some(column => column.name === 'allowedModelsJson')) {
    throw new Error('execution 缺少模型权限字段');
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
