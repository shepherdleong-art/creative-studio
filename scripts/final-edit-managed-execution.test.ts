import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
register(pathToFileURL(path.join(repoRoot, 'scripts', 'typescript-extension-loader.mjs')).href, {
  parentURL: import.meta.url,
});

const { ProviderExecutionGateError } = await import('../lib/provider-execution-gate.ts');
const {
  assertFinalEditAnalysisExecutionAvailable,
  assertFinalEditRenderExecutionAvailable,
  assertFinalEditTtsExecutionAvailable,
} = await import('../lib/final-edit/runtime.ts');

const managedEnv = { CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' } as unknown as NodeJS.ProcessEnv;
const readyRuntime = {
  status: 'ready' as const,
  reason: 'ready',
  proxyAvailable: true,
  cosConfigured: false,
  startedAt: null,
};
const allowlist = {
  image: ['fixture-image'],
  script: ['fixture-script'],
  video: ['fixture-video'],
  tts: ['doubao-seed-tts-2'] as ['doubao-seed-tts-2'],
};

function createTtsDb(input: {
  id?: string;
  type?: string;
  baseUrl?: string;
  keyEnv?: string;
} = {}): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE final_edit_tts_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
      baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      isBuiltin INTEGER NOT NULL DEFAULT 1, costPerThousandCharacters REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE final_edit_groups (id TEXT PRIMARY KEY, narrationConfigJson TEXT NOT NULL);
  `);
  db.prepare(`
    INSERT INTO final_edit_tts_providers
      (id, type, baseUrl, apiKey, keyEnv, model, enabled)
    VALUES (?, ?, ?, 'fixture-key', ?, 'seed-tts-2.0', 1)
  `).run(
    input.id ?? 'doubao-seed-tts-2',
    input.type ?? 'doubao-http-chunked',
    input.baseUrl ?? 'https://openspeech.bytedance.com',
    input.keyEnv ?? 'DOUBAO_TTS_API_KEY',
  );
  return db;
}

{
  const db = createTtsDb({
    id: 'vapi-qwen3-tts',
    type: 'vapi-qwen-json-url',
    baseUrl: 'https://api.v3.cm',
    keyEnv: 'VAPI_TTS_API_KEY',
  });
  try {
    await assert.rejects(
      assertFinalEditTtsExecutionAvailable('vapi-qwen3-tts', {
        db, env: managedEnv, allowlist, companyRuntime: readyRuntime,
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_provider_not_allowed',
    );
  } finally {
    db.close();
  }
}

{
  const db = createTtsDb();
  try {
    const authorized = await assertFinalEditTtsExecutionAvailable('doubao-seed-tts-2', {
      db, env: managedEnv, allowlist, companyRuntime: readyRuntime,
    });
    assert.equal(authorized.provider.baseUrl, 'https://openspeech.bytedance.com');
    assert.doesNotMatch(authorized.provider.baseUrl, /127\.0\.0\.1|localhost|:4000/);
  } finally {
    db.close();
  }
}

{
  const db = createTtsDb();
  let inspections = 0;
  try {
    await assert.rejects(
      assertFinalEditTtsExecutionAvailable('doubao-seed-tts-2', {
        db,
        env: managedEnv,
        allowlist,
        inspectRuntime: async () => {
          inspections += 1;
          if (inspections === 2) {
            db.prepare(`UPDATE final_edit_tts_providers SET apiKey=? WHERE id=?`)
              .run('rotated-during-final-gate', 'doubao-seed-tts-2');
          }
          return readyRuntime;
        },
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_provider_not_allowed',
      '最后一次异步 runtime 检查期间换 Key 也必须 fail closed',
    );
    assert.equal(inspections, 2);
  } finally {
    db.close();
  }
}

{
  const db = createTtsDb();
  db.prepare(`INSERT INTO final_edit_groups (id, narrationConfigJson) VALUES (?, '{}')`)
    .run('render-with-default-tts');
  try {
    await assert.rejects(
      assertFinalEditRenderExecutionAvailable(db, 'render-with-default-tts', {
        env: managedEnv,
        allowlist,
        companyRuntime: { ...readyRuntime, status: 'unavailable', proxyAvailable: false },
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'managed_workbench_locked',
      '无显式 provider 的恢复 render 也必须固定豆包并受 LiteLLM 总门禁',
    );
  } finally {
    db.close();
  }
}

{
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE script_providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
    apiStyle TEXT NOT NULL DEFAULT '', baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', keyEnv TEXT NOT NULL DEFAULT '', baseUrlEnv TEXT NOT NULL DEFAULT '',
    modelEnv TEXT NOT NULL DEFAULT '', defaultBaseUrl TEXT NOT NULL DEFAULT '', defaultModel TEXT NOT NULL DEFAULT '',
    maxTokens INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    supportsVision INTEGER NOT NULL DEFAULT 0, visionCostPerRequest REAL NOT NULL DEFAULT 0,
    executionScope TEXT NOT NULL DEFAULT 'company'
  )`);
  db.prepare(`INSERT INTO script_providers
    (id, name, type, apiStyle, baseUrl, apiKey, model, enabled, supportsVision, executionScope)
    VALUES ('fixture-script', 'Fixture Vision', 'openai-compatible', 'openai-compatible',
      'http://127.0.0.1:4000', 'fixture-key', 'vision-model', 1, 1, 'company')`).run();
  try {
    await assert.rejects(
      assertFinalEditAnalysisExecutionAvailable('fixture-script', {
        db, env: managedEnv, allowlist, companyRuntime: readyRuntime,
      }),
      (error: unknown) => error instanceof ProviderExecutionGateError
        && error.code === 'transport_unavailable',
      '没有正式任务级 MediaTransport 时视觉分析必须 fail closed',
    );
  } finally {
    db.close();
  }
}

{
  const workerSource = fs.readFileSync(path.join(repoRoot, 'lib', 'final-edit', 'worker.ts'), 'utf8');
  const gateIndex = workerSource.indexOf('await assertFinalEditRenderExecutionAvailable');
  const parseIndex = workerSource.indexOf('JSON.parse(job.inputSnapshotJson)');
  const renderIndex = workerSource.indexOf('renderFinalEditSnapshot({');
  assert.ok(gateIndex >= 0 && gateIndex < parseIndex && gateIndex < renderIndex);

  const previewSource = fs.readFileSync(path.join(repoRoot, 'app', 'api', 'providers', 'tts', '[id]', 'preview', 'route.ts'), 'utf8');
  const previewBody = previewSource.slice(previewSource.indexOf('export async function POST'));
  assert.ok(previewBody.indexOf('assertFinalEditTtsExecutionAvailable') < previewBody.indexOf('getFinalEditTtsAdapter'));
  assert.ok(previewBody.lastIndexOf('assertFinalEditTtsExecutionAvailable') < previewBody.indexOf('adapter.synthesizePreview'));

  const bootstrapSource = fs.readFileSync(path.join(repoRoot, 'app', 'api', 'projects', '[id]', 'final-edit', 'bootstrap', 'route.ts'), 'utf8');
  assert.match(bootstrapSource, /filterManagedProviders\('tts'/);
  assert.match(bootstrapSource, /loadManagedProviderAllowlist\(\)/);
}

console.log('final-edit managed execution tests passed');
