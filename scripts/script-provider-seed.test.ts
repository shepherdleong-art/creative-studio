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

    // 内部部署不再预置第三方脚本供应商（Gemini/Qwen/Kimi/GPT 直连）；
    // 公司 GPT-5.5 由统一配置导入写入。新数据库必须保持为空。
    const count = (db.prepare('SELECT COUNT(*) AS count FROM script_providers').get() as { count: number }).count;
    assert.equal(count, 0, 'script_providers 不得预置任何第三方供应商');

  } finally {
    closeDatabase?.();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }

  console.log('script provider seed tests passed');
}
