import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const childFlag = 'CREATIVE_STUDIO_SCRIPT_PROVIDER_SEED_TEST_CHILD';

if (process.env[childFlag] !== '1') {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-loader',
    pathToFileURL(path.resolve('scripts/typescript-extension-loader.mjs')).href,
    '--experimental-strip-types',
    fileURLToPath(import.meta.url),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, [childFlag]: '1' },
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} else {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-provider-seed-'));
  process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
  let closeDatabase: (() => void) | undefined;

  try {
    const { closeDb, getDb } = await import('../lib/db.ts');
    const { seedScriptProviders } = await import('../lib/seed.ts');
    closeDatabase = closeDb;

    seedScriptProviders();
    const db = getDb();
    db.prepare(`
      UPDATE script_providers
      SET type = ?, apiStyle = ?, model = ?, maxTokens = ?
      WHERE id = 'kimi'
    `).run('anthropic-messages', 'anthropic-messages', 'kimi-k2.6', 8192);

    seedScriptProviders();

    assert.deepEqual(
      db.prepare(`
        SELECT type, apiStyle, model, maxTokens
        FROM script_providers
        WHERE id = 'kimi'
      `).get(),
      {
        type: 'anthropic-messages',
        apiStyle: 'anthropic-messages',
        model: 'kimi-k2.6',
        maxTokens: 8192,
      },
      '内置供应商播种不得覆盖用户保存的协议、模型或最大输出 Token',
    );

  } finally {
    closeDatabase?.();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log('script provider seed tests passed');
}
