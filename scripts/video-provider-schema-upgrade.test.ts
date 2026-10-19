import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureVideoProviderGatewaySchemaReady } from '../lib/video-provider-schema.ts';

function createLegacyDatabase(root: string): Database.Database {
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
    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      providerId TEXT NOT NULL,
      FOREIGN KEY(providerId) REFERENCES video_providers(id)
    );
    INSERT INTO video_providers (
      id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel,
      enabled, defaultDurationSec, defaultCostPerVideo, baseUrl, apiKey, accessKey, secretKey
    ) VALUES (
      'provider-1', '旧供应商', 'kling', '', '', '', 'legacy-model',
      1, 5, 1.25, 'https://legacy.invalid', 'secret-preserve', 'access-preserve', 'key-preserve'
    );
    INSERT INTO video_jobs (id, providerId) VALUES ('job-1', 'provider-1');
  `);
  return db;
}

function providerSnapshot(db: Database.Database): unknown[] {
  return db.prepare(`SELECT * FROM video_providers ORDER BY id`).all();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-video-provider-schema-'));

try {
  const legacyRoot = path.join(root, 'legacy');
  fs.mkdirSync(legacyRoot, { recursive: true });
  const legacyDb = createLegacyDatabase(legacyRoot);
  const before = providerSnapshot(legacyDb);
  const backupRoot = path.join(legacyRoot, 'backups');
  const upgraded = await ensureVideoProviderGatewaySchemaReady({
    db: legacyDb,
    backupRoot,
    now: () => new Date('2026-08-01T13:00:00.000Z'),
  });
  assert.equal(upgraded.state, 'ready');
  assert.deepEqual(providerSnapshot(legacyDb), before, '供应商配置和密钥必须原样保留');
  assert.deepEqual(legacyDb.prepare(`SELECT * FROM video_jobs`).all(), [{ id: 'job-1', providerId: 'provider-1' }]);
  const tableSql = (legacyDb.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='video_providers'`,
  ).get() as { sql: string }).sql;
  assert.match(tableSql, /openai-video/);
  assert.doesNotThrow(() => legacyDb.prepare(`
    INSERT INTO video_providers (
      id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel,
      enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey
    ) VALUES ('gateway-1', '公司网关', 'openai-video', '', '', '', 'model', 0, 5, '', '', '', '')
  `).run());

  const publishedBackups = fs.readdirSync(backupRoot).filter((name) => !name.startsWith('.'));
  assert.equal(publishedBackups.length, 1);
  const backupDirectory = path.join(backupRoot, publishedBackups[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, 'manifest.json'), 'utf8')) as {
    scope: string;
  };
  assert.equal(manifest.scope, 'video-provider-gateway');
  const backupDb = new Database(path.join(backupDirectory, 'workbench.db'), { readonly: true });
  const backupTableSql = (backupDb.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='video_providers'`,
  ).get() as { sql: string }).sql;
  assert.doesNotMatch(backupTableSql, /openai-video/);
  assert.deepEqual(providerSnapshot(backupDb), before);
  backupDb.close();

  const current = await ensureVideoProviderGatewaySchemaReady({
    db: legacyDb,
    backupRoot,
    now: () => new Date('2026-08-01T13:01:00.000Z'),
  });
  assert.equal(current.state, 'current');
  assert.equal(fs.readdirSync(backupRoot).filter((name) => !name.startsWith('.')).length, 1);
  legacyDb.close();

  const invalidRoot = path.join(root, 'invalid');
  fs.mkdirSync(invalidRoot, { recursive: true });
  const invalidDb = createLegacyDatabase(invalidRoot);
  invalidDb.pragma('foreign_keys = OFF');
  invalidDb.prepare(`INSERT INTO video_jobs (id, providerId) VALUES ('bad-job', 'missing-provider')`).run();
  invalidDb.pragma('foreign_keys = ON');
  const rejected = await ensureVideoProviderGatewaySchemaReady({
    db: invalidDb,
    backupRoot: path.join(invalidRoot, 'backups'),
  });
  assert.equal(rejected.state, 'compatibility_only');
  const invalidSql = (invalidDb.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='video_providers'`,
  ).get() as { sql: string }).sql;
  assert.doesNotMatch(invalidSql, /openai-video/, '备份校验失败时不得重建旧表');
  invalidDb.close();

  console.log('video provider schema upgrade tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
