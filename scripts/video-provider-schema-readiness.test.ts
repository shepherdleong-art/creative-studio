import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readSchemaUpgradeAudit } from '../lib/schema-upgrade/audit.ts';
import { checkVideoProviderGatewayReadiness } from '../lib/video-provider-schema-readiness.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-video-schema-ready-'));

try {
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE video_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('kling','jimeng')),
      baseUrlEnv TEXT NOT NULL,
      apiKeyEnv TEXT NOT NULL,
      modelEnv TEXT NOT NULL,
      defaultModel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      defaultDurationSec INTEGER NOT NULL DEFAULT 5,
      defaultCostPerVideo REAL,
      baseUrl TEXT NOT NULL DEFAULT '',
      apiKey TEXT NOT NULL DEFAULT '',
      accessKey TEXT NOT NULL DEFAULT '',
      secretKey TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO video_providers (
      id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel,
      enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey
    ) VALUES ('legacy', '旧供应商', 'kling', '', '', '', 'model', 1, 5, '', 'secret', '', '');
  `);
  const auditFilePath = path.join(root, 'schema-upgrades.jsonl');
  const result = await checkVideoProviderGatewayReadiness({
    db,
    backupRoot: path.join(root, 'backups'),
    lockDatabasePath: path.join(root, 'schema-upgrade.lock.db'),
    auditFilePath,
    now: () => new Date('2026-08-01T13:30:00.000Z'),
  });
  assert.equal(result.available, true);
  assert.equal(result.schemaState, 'ready');
  const audit = await readSchemaUpgradeAudit(auditFilePath);
  assert.deepEqual(audit.map(({ scope, event }) => ({ scope, event })), [
    { scope: 'video-provider-gateway', event: 'started' },
    { scope: 'video-provider-gateway', event: 'backup_completed' },
    { scope: 'video-provider-gateway', event: 'migration_completed' },
    { scope: 'video-provider-gateway', event: 'validation_completed' },
    { scope: 'video-provider-gateway', event: 'finished' },
  ]);
  assert.equal(audit.at(-1)?.result?.backupCreated, true);
  db.close();

  console.log('video provider schema readiness tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
