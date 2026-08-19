import type Database from 'better-sqlite3';

export interface UsageSchemaMigration {
  readonly version: number;
  readonly sql: string;
}

export interface UsageSchemaReadiness {
  readonly available: boolean;
  readonly version: number | null;
  readonly error: string | null;
}

export const USAGE_SCHEMA_MIGRATIONS: ReadonlyArray<UsageSchemaMigration> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        eventKey TEXT NOT NULL UNIQUE,
        coreModelKey TEXT NOT NULL,
        category TEXT NOT NULL,
        providerId TEXT NOT NULL,
        providerName TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        pricingVersion TEXT NOT NULL,
        callCount INTEGER NOT NULL DEFAULT 1,
        quantity REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL,
        priceScale INTEGER NOT NULL DEFAULT 1,
        unitPriceMicros INTEGER NOT NULL DEFAULT 0,
        costMicros INTEGER NOT NULL DEFAULT 0,
        detailJson TEXT NOT NULL DEFAULT '{}',
        projectId TEXT,
        refType TEXT NOT NULL DEFAULT '',
        refId TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_createdAt
        ON usage_ledger(createdAt);
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_model_createdAt
        ON usage_ledger(coreModelKey, createdAt);
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_category_createdAt
        ON usage_ledger(category, createdAt);

      CREATE TABLE IF NOT EXISTS usage_call_events (
        eventKey TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('started','billable','recorded','uncertain')),
        ownerInstanceId TEXT NOT NULL,
        snapshotJson TEXT NOT NULL,
        usageJson TEXT NOT NULL DEFAULT '{}',
        projectId TEXT,
        refType TEXT NOT NULL DEFAULT '',
        refId TEXT NOT NULL DEFAULT '',
        errorMessage TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_call_events_status
        ON usage_call_events(status, updatedAt);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS usage_backfill_state (
        marker TEXT PRIMARY KEY,
        completedAt TEXT NOT NULL
      );
    `,
  },
];

const DEFAULT_READINESS: UsageSchemaReadiness = {
  available: false,
  version: null,
  error: null,
};

const readinessByDatabase = new WeakMap<object, UsageSchemaReadiness>();
let latestReadiness: UsageSchemaReadiness = DEFAULT_READINESS;

function copyReadiness(readiness: UsageSchemaReadiness): UsageSchemaReadiness {
  return { ...readiness };
}

function safeErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = rawMessage
    .replace(/(api[-_ ]?key|secret[-_ ]?key|authorization|bearer|token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s,;]+/g, '<path>')
    .replace(/\/[^\s,;]+/g, '<path>');
  return `usage schema migration failed${redacted ? `: ${redacted.slice(0, 240)}` : ''}`;
}

function setReadiness(db: Database.Database, readiness: UsageSchemaReadiness): UsageSchemaReadiness {
  const copied = copyReadiness(readiness);
  readinessByDatabase.set(db, copied);
  latestReadiness = copied;
  return copyReadiness(copied);
}

function appliedVersion(db: Database.Database): number | null {
  const row = db.prepare(`SELECT MAX(version) AS version FROM usage_schema_migrations`).get() as { version?: number | null } | undefined;
  return row?.version == null ? null : Number(row.version);
}

/**
 * Mark usage accounting unavailable without making the core database unusable.
 * The diagnostic deliberately contains only a bounded, redacted error string.
 */
export function markUsageSchemaUnavailable(db: Database.Database, error: unknown): UsageSchemaReadiness {
  return setReadiness(db, {
    available: false,
    version: (() => {
      try {
        return appliedVersion(db);
      } catch {
        return null;
      }
    })(),
    error: safeErrorMessage(error),
  });
}

/**
 * Apply usage schema migrations one version at a time. Each migration and its
 * applied marker share one transaction so a failed migration can be retried.
 */
export function initUsageSchema(db: Database.Database): UsageSchemaReadiness {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT NOT NULL
      )
    `);

    for (const migration of USAGE_SCHEMA_MIGRATIONS) {
      const applied = db.prepare(`SELECT 1 FROM usage_schema_migrations WHERE version = ?`).get(migration.version);
      if (applied) continue;

      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(`
          INSERT OR IGNORE INTO usage_schema_migrations (version, appliedAt)
          VALUES (?, ?)
        `).run(migration.version, new Date().toISOString());
      })();
    }

    return setReadiness(db, {
      available: true,
      version: USAGE_SCHEMA_MIGRATIONS.at(-1)?.version ?? null,
      error: null,
    });
  } catch (error) {
    return markUsageSchemaUnavailable(db, error);
  }
}

/** Return the last known readiness, optionally scoped to a database instance. */
export function getUsageSchemaReadiness(db?: Database.Database): UsageSchemaReadiness {
  return copyReadiness(db ? (readinessByDatabase.get(db) ?? DEFAULT_READINESS) : latestReadiness);
}

/** Return the last safe migration diagnostic, if any. */
export function getUsageSchemaError(db?: Database.Database): string | null {
  return getUsageSchemaReadiness(db).error;
}

/** Return whether usage accounting can safely accept writes for this database. */
export function isUsageSchemaReady(db?: Database.Database): boolean {
  return getUsageSchemaReadiness(db).available;
}
