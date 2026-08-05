import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { decryptProvisioningPayload, encryptProvisioningPayload } from '../lib/provisioning/crypto.ts';
import { applyProvisioningPayload, importProvisioningPackage, readProvisioningStatus } from '../lib/provisioning/service.ts';
import { validateProvisioningPayload } from '../lib/provisioning/schema.ts';

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    profileName: '内部测试档案',
    gatewayApiKey: 'gateway-secret-123456',
    liteLlmConfigYaml: 'model_list:\n  - model_name: image2-medium\n    litellm_params:\n      model: company/image2-medium\n',
    image: {
      id: 'company-image2-medium', name: '公司图片', type: 'gateway-task-image', apiStyle: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4000', model: 'image2-medium', enabled: true,
    },
    script: {
      id: 'company-gpt5-5', name: '公司脚本', type: 'openai-compatible', apiStyle: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:4000', model: 'gpt-5.5', enabled: true,
      executionScope: 'company', supportsVision: true,
    },
    videos: [
      {
        id: 'company-kling-3', name: '公司可灵 3.0', type: 'openai-video', apiStyle: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:4000', model: 'kling-v3', enabled: true,
      },
      {
        id: 'company-jimeng-2', name: '公司即梦 2.0', type: 'openai-video', apiStyle: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:4000', model: 'doubao-seedance-2-0-260128', enabled: true,
      },
    ],
    tts: {
      id: 'doubao-seed-tts-2', name: '豆包语音', type: 'doubao-http-chunked', apiStyle: 'doubao-http-chunked',
      baseUrl: 'https://openspeech.bytedance.com', model: 'seed-tts-2.0', enabled: true,
      apiKey: 'doubao-tts-secret-123456',
    },
    cos: {
      secretId: 'cos-secret-id-123', secretKey: 'cos-secret-key-456',
      domain: 'bucket.cos.ap-guangzhou.myqcloud.com', prefix: 'ref-images/', ttlSec: 86400,
    },
    ...overrides,
  };
}

function testDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL,
      apiKeyEnv TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'openai-compatible', enabled INTEGER NOT NULL DEFAULT 1,
      defaultCostPerImage REAL
    );
    CREATE TABLE script_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, apiStyle TEXT NOT NULL,
      baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL, model TEXT NOT NULL, keyEnv TEXT NOT NULL,
      baseUrlEnv TEXT NOT NULL, modelEnv TEXT NOT NULL, defaultBaseUrl TEXT NOT NULL,
      defaultModel TEXT NOT NULL, maxTokens INTEGER NOT NULL, enabled INTEGER NOT NULL,
      isBuiltin INTEGER NOT NULL, supportsVision INTEGER NOT NULL, visionCostPerRequest REAL NOT NULL,
      executionScope TEXT NOT NULL
    );
    CREATE TABLE video_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrlEnv TEXT NOT NULL,
      apiKeyEnv TEXT NOT NULL, modelEnv TEXT NOT NULL, defaultModel TEXT NOT NULL, enabled INTEGER NOT NULL,
      defaultDurationSec INTEGER NOT NULL, baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL,
      accessKey TEXT NOT NULL, secretKey TEXT NOT NULL
    );
    CREATE TABLE final_edit_tts_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, baseUrl TEXT NOT NULL,
      apiKey TEXT NOT NULL, keyEnv TEXT NOT NULL, model TEXT NOT NULL, enabled INTEGER NOT NULL,
      isBuiltin INTEGER NOT NULL, costPerThousandCharacters REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
    );
    INSERT INTO final_edit_tts_providers
      (id,name,type,baseUrl,apiKey,keyEnv,model,enabled,isBuiltin,costPerThousandCharacters,createdAt,updatedAt)
      VALUES ('doubao-seed-tts-2','豆包','doubao-http-chunked','https://old.example.invalid','','DOUBAO_TTS_API_KEY','old',1,1,0,'now','now');
  `);
  return db;
}

test('AES-GCM provisioning encryption authenticates and does not expose plaintext', () => {
  const secretPayload = payload();
  assert.throws(() => encryptProvisioningPayload(secretPayload, 'short'));
  const encrypted = encryptProvisioningPayload(secretPayload, 'a-long-test-password');
  assert.ok(encrypted.length > 0);
  assert.equal(encrypted.includes(Buffer.from('gateway-secret-123456')), false);
  assert.deepEqual(decryptProvisioningPayload(encrypted, 'a-long-test-password'), validateProvisioningPayload(secretPayload));
  assert.throws(() => decryptProvisioningPayload(encrypted, 'wrong-password'), /无法解密或认证失败/);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 2] ^= 0x01;
  assert.throws(() => decryptProvisioningPayload(tampered, 'a-long-test-password'), /无法解密或认证失败/);
});

test('schema rejects oversized content, placeholders and non-loopback company URLs', () => {
  assert.throws(() => validateProvisioningPayload({ ...payload(), liteLlmConfigYaml: 'x'.repeat(600_000) }));
  assert.throws(() => validateProvisioningPayload({ ...payload(), gatewayApiKey: 'your-api-key' }));
  const legacyVersion = { ...payload(), version: 1 } as Record<string, unknown>;
  delete legacyVersion.schemaVersion;
  assert.throws(() => validateProvisioningPayload(legacyVersion));
  assert.throws(() => validateProvisioningPayload({ ...payload(), tts: { ...(payload().tts as Record<string, unknown>), apiKey: undefined } }));
  assert.throws(() => validateProvisioningPayload({ ...payload(), gatewayApiKey: 'sk-xxxx' }));
  const badScript = { ...(payload().script as Record<string, unknown>), baseUrl: 'https://company.example.com' };
  assert.throws(() => validateProvisioningPayload({ ...payload(), script: badScript }));
  const responsesScript = { ...(payload().script as Record<string, unknown>), type: 'openai-responses', apiStyle: 'openai-responses' };
  assert.equal((validateProvisioningPayload({ ...payload(), script: responsesScript }).script).apiStyle, 'openai-responses');
  assert.throws(() => validateProvisioningPayload({ ...payload(), image: { ...(payload().image as Record<string, unknown>), id: '../escape' } }));
});

test('first import, repeated rotation, process env and rollback are safe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-'));
  const db = testDb();
  db.prepare(`INSERT INTO providers (id,name,baseUrl,apiKeyEnv,apiKey,model,type,enabled,defaultCostPerImage) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('user-provider', '用户自定义', 'https://user.example.invalid', '', 'user-key', 'model', 'openai-compatible', 1, 0);
  const first = payload();
  const firstStatus = applyProvisioningPayload(first, { root, db, now: new Date('2026-08-05T00:00:00.000Z') });
  assert.equal(firstStatus.configured, true);
  assert.equal(readProvisioningStatus(root).configHashPrefix, firstStatus.configHashPrefix);
  assert.equal(process.env.CREATIVE_STUDIO_GATEWAY_API_KEY, 'gateway-secret-123456');
  assert.equal((db.prepare('SELECT apiKey FROM providers WHERE id=?').get('company-image2-medium') as { apiKey: string }).apiKey, 'gateway-secret-123456');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_providers WHERE id IN (?, ?)').get('company-kling-3', 'company-jimeng-2') as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT apiKey FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { apiKey: string }).apiKey, 'doubao-tts-secret-123456');
  assert.equal((db.prepare('SELECT keyEnv FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { keyEnv: string }).keyEnv, 'DOUBAO_TTS_API_KEY');
  assert.equal(fs.existsSync(path.join(root, 'config.yaml')), true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'runtime.env')), true);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env'), 'utf8').includes('doubao-tts-secret-123456'), false);

  const rotated = payload({
    gatewayApiKey: 'rotated-gateway-secret-987654',
    liteLlmConfigYaml: 'model_list:\n  - model_name: rotated\n',
  });
  applyProvisioningPayload(rotated, { root, db, now: new Date('2026-08-05T01:00:00.000Z') });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM providers WHERE id=?').get('company-image2-medium') as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM providers WHERE id=?').get('user-provider') as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_providers WHERE id IN (?, ?)').get('company-kling-3', 'company-jimeng-2') as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT apiKey FROM script_providers WHERE id=?').get('company-gpt5-5') as { apiKey: string }).apiKey, 'rotated-gateway-secret-987654');
  assert.equal((db.prepare('SELECT apiKey FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { apiKey: string }).apiKey, 'doubao-tts-secret-123456');

  const beforeConfig = fs.readFileSync(path.join(root, 'config.yaml'));
  const beforeEnv = fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env'));
  db.prepare(`DELETE FROM final_edit_tts_providers WHERE id=?`).run('doubao-seed-tts-2');
  assert.throws(() => applyProvisioningPayload(payload({ gatewayApiKey: 'failed-secret-000000' }), { root, db }));
  assert.deepEqual(fs.readFileSync(path.join(root, 'config.yaml')), beforeConfig);
  assert.deepEqual(fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env')), beforeEnv);
  assert.equal(process.env.CREATIVE_STUDIO_GATEWAY_API_KEY, 'rotated-gateway-secret-987654');
  assert.equal(Buffer.from(JSON.stringify(readProvisioningStatus(root))).includes(Buffer.from('rotated-gateway-secret')), false);
  fs.appendFileSync(path.join(root, 'config.yaml'), '# tamper');
  assert.equal(readProvisioningStatus(root).configured, false);
  db.close();
});

test('oversized encrypted files are rejected before decryption', () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41);
  assert.throws(() => importProvisioningPackage(oversized, 'a-long-test-password'), /统一配置导入失败|无法解密/);
  assert.equal(crypto.createHash('sha256').update('x').digest().length, 32);
});

test('admin CLI combines a separate config.yaml without exposing secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provision-cli-'));
  const authoringProfile = payload();
  delete authoringProfile.liteLlmConfigYaml;
  const profilePath = path.join(root, 'company-profile.local.json');
  const configPath = path.join(root, 'config.yaml');
  const outputPath = path.join(root, 'company-profile.provision');
  const configYaml = 'model_list:\n  - model_name: cli-test\n';
  fs.writeFileSync(profilePath, JSON.stringify(authoringProfile));
  fs.writeFileSync(configPath, configYaml);

  const result = spawnSync(process.execPath, [
    path.resolve('scripts/create-provision-package.ts'),
    profilePath,
    configPath,
    outputPath,
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, PROVISION_PASSWORD: 'a-long-cli-password' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('gateway-secret-123456'), false);
  assert.equal(result.stderr.includes('gateway-secret-123456'), false);
  const decrypted = decryptProvisioningPayload(fs.readFileSync(outputPath), 'a-long-cli-password');
  assert.equal(decrypted.liteLlmConfigYaml, configYaml.trim());
  assert.equal(decrypted.gatewayApiKey, 'gateway-secret-123456');
});
