import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { CORE_DB_MIGRATIONS } from '../lib/db-migrations.ts';

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

  CREATE TABLE video_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    baseUrlEnv TEXT NOT NULL,
    apiKeyEnv TEXT NOT NULL,
    modelEnv TEXT NOT NULL,
    defaultModel TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    defaultDurationSec INTEGER NOT NULL DEFAULT 5
  );

  CREATE TABLE script_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE narration_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'qwen-tts',
    apiKey TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    isBuiltin INTEGER NOT NULL DEFAULT 1
  );

  INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES ('image-provider', 'Image Provider', 'https://old.image', 'IMAGE_API_KEY', '', 'gpt-image-2', 'openai-compatible', 1);

  INSERT INTO narration_providers (id, name, type, apiKey, enabled, isBuiltin)
  VALUES ('qwen-tts', 'Qwen TTS', 'qwen-tts', 'sk-existing-narration-key', 1, 1);

  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec)
  VALUES ('video-provider', 'Video Provider', 'jimeng', 'VIDEO_BASE_URL', 'VIDEO_API_KEY', 'VIDEO_MODEL', 'jimeng-2', 1, 5);

  INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec)
  VALUES ('jimeng-2', '即梦 1.5 (Seedance)', 'jimeng', 'JIMENG_VIDEO_BASE_URL', 'JIMENG_VIDEO_API_KEY', 'JIMENG_VIDEO_MODEL', 'doubao-seedance-1-5', 1, 5);

  INSERT INTO script_providers (id, name)
  VALUES ('script-provider', 'Script Provider');
`);

for (const sql of CORE_DB_MIGRATIONS) {
  try {
    db.exec(sql);
  } catch {
    // Match production migration behavior for columns/tables that do not exist in this old schema.
  }
}

const columns = db.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>;
assert.ok(
  columns.some((column) => column.name === 'defaultCostPerImage'),
  'providers.defaultCostPerImage should be added when migrating older installed databases',
);

db.prepare(`
  UPDATE providers
  SET name = ?, baseUrl = ?, apiKey = ?, model = ?, type = ?, enabled = ?, defaultCostPerImage = ?
  WHERE id = ?
`).run('Image Provider', 'https://new.image', 'db-image-key', 'gpt-image-2', 'openai-compatible', 1, 0.25, 'image-provider');

db.prepare(`
  UPDATE video_providers
  SET name = ?, type = ?, baseUrl = ?, defaultModel = ?, enabled = ?, defaultDurationSec = ?, apiKey = ?, accessKey = ?, secretKey = ?
  WHERE id = ?
`).run('Video Provider', 'jimeng', 'https://new.video', 'jimeng-2', 1, 5, 'db-video-key', '', '', 'video-provider');

assert.deepEqual(
  db.prepare(`SELECT name, defaultModel FROM video_providers WHERE id = 'jimeng-2'`).get(),
  { name: '即梦 1.5 Pro (Seedance)', defaultModel: 'doubao-seedance-1-5-pro-251215' },
);

db.prepare(`
  UPDATE script_providers
  SET name = ?, type = ?, apiStyle = ?, baseUrl = ?, model = ?, enabled = ?, maxTokens = ?, apiKey = ?
  WHERE id = ?
`).run('Script Provider', 'openai-compatible', 'openai-compatible', 'https://new.script', 'script-model', 1, 8192, 'db-script-key', 'script-provider');

const narrationColumns = db.prepare(`PRAGMA table_info(narration_providers)`).all() as Array<{ name: string }>;
assert.ok(
  narrationColumns.some((column) => column.name === 'baseUrl'),
  'narration_providers.baseUrl should be added when migrating older installed databases',
);
assert.ok(
  narrationColumns.some((column) => column.name === 'model'),
  'narration_providers.model should be added when migrating older installed databases',
);
assert.ok(
  narrationColumns.some((column) => column.name === 'voices'),
  'narration_providers.voices should be added when migrating older installed databases',
);

const narrationRow = db.prepare(`SELECT apiKey, baseUrl, model, voices FROM narration_providers WHERE id = 'qwen-tts'`).get();
assert.deepEqual(
  narrationRow,
  { apiKey: 'sk-existing-narration-key', baseUrl: '', model: '', voices: '' },
  'existing narration apiKey must survive the migration; new columns (including voices) default to empty string',
);

db.prepare(`
  UPDATE narration_providers
  SET name = ?, type = ?, apiKey = ?, baseUrl = ?, model = ?, voices = ?
  WHERE id = ?
`).run('Qwen TTS（阿里云 DashScope）', 'qwen-tts', 'db-narration-key', '', 'qwen-tts', 'Cherry,Serena,Ethan,Chelsie', 'qwen-tts');

const narrationRowAfterUpdate = db.prepare(`SELECT voices FROM narration_providers WHERE id = 'qwen-tts'`).get();
assert.deepEqual(
  narrationRowAfterUpdate,
  { voices: 'Cherry,Serena,Ethan,Chelsie' },
  'voices column should accept and persist a user-configured comma-separated voice list',
);

db.close();
console.log('db-migrations tests passed');
