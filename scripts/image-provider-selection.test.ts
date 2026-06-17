import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveImageJobProvider } from '../lib/image-provider-selection.ts';

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    baseUrl TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL DEFAULT '',
    apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT 'gpt-image-2',
    type TEXT NOT NULL DEFAULT 'openai-compatible',
    enabled INTEGER NOT NULL DEFAULT 1
  );
`);

const insert = db.prepare(`
  INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES (?, ?, 'https://example.com', ?, ?, ?, ?, ?)
`);

insert.run('primary', 'Primary', '', 'dummy-primary-key', 'gpt-image-2', 'openai-compatible', 1);
insert.run('backup', 'Backup', '', 'dummy-backup-key', 'gemini-3.1-flash-image-preview', 'packy-gemini-image', 1);
insert.run('disabled', 'Disabled', '', 'dummy-disabled-key', 'gpt-image-2', 'openai-compatible', 0);
insert.run('missing-key', 'Missing Key', '', '', 'gpt-image-2', 'openai-compatible', 1);

assert.deepEqual(
  resolveImageJobProvider(db, undefined, { providerId: 'primary', model: 'project-model' }),
  { providerId: 'primary', model: 'gpt-image-2' }
);

assert.deepEqual(
  resolveImageJobProvider(db, 'backup', { providerId: 'primary', model: 'project-model' }),
  { providerId: 'backup', model: 'gemini-3.1-flash-image-preview' }
);

assert.throws(
  () => resolveImageJobProvider(db, 'disabled', { providerId: 'primary', model: 'project-model' }),
  /供应商已禁用/
);

assert.throws(
  () => resolveImageJobProvider(db, 'missing-key', { providerId: 'primary', model: 'project-model' }),
  /供应商 API Key 未配置/
);

assert.throws(
  () => resolveImageJobProvider(db, 'nope', { providerId: 'primary', model: 'project-model' }),
  /供应商不存在/
);

db.close();
console.log('image-provider-selection tests passed');
