import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { decryptProvisioningPayload, encryptProvisioningPayload } from '../lib/provisioning/crypto.ts';
import { applyProvisioningPayload, importProvisioningPackage, readProvisioningState, readProvisioningStatus } from '../lib/provisioning/service.ts';
import { validateProvisioningPayload } from '../lib/provisioning/schema.ts';
import { checkVideoProviderGatewayReadiness } from '../lib/video-provider-schema-readiness.ts';

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

function readStateFile(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, 'data', 'provisioning', 'state.json'), 'utf8')) as Record<string, unknown>;
}

function assertNoProvisioningTempFiles(root: string): void {
  const pending: string[] = [root];
  const residues: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (/\.(?:tmp|bak)$/.test(entry.name)) residues.push(absolute);
    }
  }
  assert.deepEqual(residues, []);
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
  for (const ttsBaseUrl of [
    'https://evil.example/',
    'https://1.2.3.4/',
    'https://api.openspeech.bytedance.com/',
    'https://openspeech.bytedance.com:8443/',
  ]) {
    const badTts = { ...(payload().tts as Record<string, unknown>), baseUrl: ttsBaseUrl };
    assert.throws(() => validateProvisioningPayload({ ...payload(), tts: badTts }), `non-official TTS URL must be rejected: ${ttsBaseUrl}`);
  }
  assert.equal(
    validateProvisioningPayload({
      ...payload(),
      tts: { ...(payload().tts as Record<string, unknown>), baseUrl: 'https://openspeech.bytedance.com:443/' },
    }).tts.baseUrl,
    'https://openspeech.bytedance.com',
  );
  const responsesScript = { ...(payload().script as Record<string, unknown>), type: 'openai-responses', apiStyle: 'openai-responses' };
  assert.equal((validateProvisioningPayload({ ...payload(), script: responsesScript }).script).apiStyle, 'openai-responses');
  assert.throws(() => validateProvisioningPayload({ ...payload(), image: { ...(payload().image as Record<string, unknown>), id: '../escape' } }));
});

test('schema rejects HTTPS loopback endpoints for all company provider roles', () => {
  const badImage = { ...(payload().image as Record<string, unknown>), baseUrl: 'https://127.0.0.1:4000' };
  const badScript = { ...(payload().script as Record<string, unknown>), baseUrl: 'https://127.0.0.1:4000' };
  const badVideo = { ...(payload().videos as Array<Record<string, unknown>>)[0], baseUrl: 'https://127.0.0.1:4000' };
  assert.throws(() => validateProvisioningPayload({ ...payload(), image: badImage }), 'HTTPS image loopback must be rejected');
  assert.throws(() => validateProvisioningPayload({ ...payload(), script: badScript }), 'HTTPS script loopback must be rejected');
  assert.throws(() => validateProvisioningPayload({ ...payload(), videos: [badVideo] }), 'HTTPS video loopback must be rejected');
});

test('first import, repeated rotation, process env and rollback are safe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-'));
  const db = testDb();
  db.prepare(`INSERT INTO providers (id,name,baseUrl,apiKeyEnv,apiKey,model,type,enabled,defaultCostPerImage) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('user-provider', '用户自定义', 'https://user.example.invalid', '', 'user-key', 'model', 'openai-compatible', 1, 0);
  const first = payload();
  const firstStatus = applyProvisioningPayload(first, { root, db, now: new Date('2026-08-05T00:00:00.000Z') });
  assert.equal(firstStatus.configured, true);
  const firstState = readProvisioningState(root);
  assert.ok(firstState);
  assert.equal(firstState.schemaVersion, 2);
  assert.deepEqual(firstState.managedProviders, {
    image: ['company-image2-medium'],
    script: ['company-gpt5-5'],
    video: ['company-kling-3', 'company-jimeng-2'],
    tts: ['doubao-seed-tts-2'],
  });
  assert.equal(readProvisioningStatus(root).configHashPrefix, firstStatus.configHashPrefix);
  assert.equal(process.env.CREATIVE_STUDIO_GATEWAY_API_KEY, 'gateway-secret-123456');
  assert.equal((db.prepare('SELECT apiKey FROM providers WHERE id=?').get('company-image2-medium') as { apiKey: string }).apiKey, 'gateway-secret-123456');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_providers WHERE id IN (?, ?)').get('company-kling-3', 'company-jimeng-2') as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT apiKey FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { apiKey: string }).apiKey, 'doubao-tts-secret-123456');
  assert.equal((db.prepare('SELECT keyEnv FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { keyEnv: string }).keyEnv, 'DOUBAO_TTS_API_KEY');
  assert.equal(fs.existsSync(path.join(root, 'config.yaml')), true);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'runtime.env')), true);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env'), 'utf8').includes('doubao-tts-secret-123456'), false);

  const stateText = fs.readFileSync(path.join(root, 'data', 'provisioning', 'state.json'), 'utf8');
  assert.equal(stateText.includes('gateway-secret-123456'), false);
  assert.equal(stateText.includes('doubao-tts-secret-123456'), false);
  assert.equal(stateText.includes('cos-secret-id-123'), false);
  assert.equal(stateText.includes('cos-secret-key-456'), false);
  assert.equal(stateText.includes('model_list:'), false);
  assert.equal(stateText.includes('a-long-test-password'), false);

  const validStateBytes = fs.readFileSync(path.join(root, 'data', 'provisioning', 'state.json'));
  const validState = readStateFile(root);
  const invalidStates: Record<string, unknown>[] = [
    { ...validState, schemaVersion: 1 },
    { ...validState, configHash: '0'.repeat(64) },
    {
      ...validState,
      managedProviders: {
        ...(validState.managedProviders as Record<string, unknown>),
        video: ['company-kling-3', 'company-kling-3'],
      },
    },
    {
      ...validState,
      managedProviders: {
        ...(validState.managedProviders as Record<string, unknown>),
        image: 'company-image2-medium',
      },
    },
    {
      ...validState,
      managedProviders: {
        ...(validState.managedProviders as Record<string, unknown>),
        tts: ['other-tts'],
      },
    },
  ];
  for (const invalidState of invalidStates) {
    fs.writeFileSync(path.join(root, 'data', 'provisioning', 'state.json'), `${JSON.stringify(invalidState)}\n`);
    assert.equal(readProvisioningState(root), null);
    assert.deepEqual(readProvisioningStatus(root), {
      configured: false,
      profileName: null,
      importedAt: null,
      configHashPrefix: null,
    });
  }
  fs.writeFileSync(path.join(root, 'data', 'provisioning', 'state.json'), validStateBytes);

  const rotated = payload({
    gatewayApiKey: 'rotated-gateway-secret-987654',
    liteLlmConfigYaml: 'model_list:\n  - model_name: rotated\n',
    videos: [
      {
        id: 'company-video-new', name: '新测试视频', type: 'openai-video', apiStyle: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:4000', model: 'new-video-model', enabled: true,
      },
    ],
  });
  applyProvisioningPayload(rotated, { root, db, now: new Date('2026-08-05T01:00:00.000Z') });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM providers WHERE id=?').get('company-image2-medium') as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM providers WHERE id=?').get('user-provider') as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_providers WHERE id=?').get('company-video-new') as { count: number }).count, 1);
  const rotatedState = readProvisioningState(root);
  assert.ok(rotatedState);
  assert.deepEqual(rotatedState.managedProviders.video, ['company-video-new']);
  assert.equal(rotatedState.managedProviders.video.includes('company-kling-3'), false);
  assert.equal((db.prepare('SELECT apiKey FROM script_providers WHERE id=?').get('company-gpt5-5') as { apiKey: string }).apiKey, 'rotated-gateway-secret-987654');
  assert.equal((db.prepare('SELECT apiKey FROM final_edit_tts_providers WHERE id=?').get('doubao-seed-tts-2') as { apiKey: string }).apiKey, 'doubao-tts-secret-123456');

  const beforeConfig = fs.readFileSync(path.join(root, 'config.yaml'));
  const beforeEnv = fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env'));
  const beforeState = fs.readFileSync(path.join(root, 'data', 'provisioning', 'state.json'));
  db.prepare(`DELETE FROM final_edit_tts_providers WHERE id=?`).run('doubao-seed-tts-2');
  const beforeDb = {
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  };
  assert.throws(() => applyProvisioningPayload(payload({ gatewayApiKey: 'failed-secret-000000' }), { root, db }));
  assert.deepEqual(fs.readFileSync(path.join(root, 'config.yaml')), beforeConfig);
  assert.deepEqual(fs.readFileSync(path.join(root, 'data', 'provisioning', 'runtime.env')), beforeEnv);
  assert.deepEqual(fs.readFileSync(path.join(root, 'data', 'provisioning', 'state.json')), beforeState);
  assert.deepEqual({
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  }, beforeDb);
  assertNoProvisioningTempFiles(root);
  assert.equal(process.env.CREATIVE_STUDIO_GATEWAY_API_KEY, 'rotated-gateway-secret-987654');
  assert.equal(Buffer.from(JSON.stringify(readProvisioningStatus(root))).includes(Buffer.from('rotated-gateway-secret')), false);
  fs.appendFileSync(path.join(root, 'config.yaml'), '# tamper');
  assert.equal(readProvisioningStatus(root).configured, false);
  db.close();
});

test('state fsync failure closes the handle and rolls back every import artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-state-fsync-'));
  const db = testDb();
  const beforeDb = {
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  };
  const originalFsyncSync = fs.fsyncSync;
  const originalCloseSync = fs.closeSync;
  const originalUnlinkSync = fs.unlinkSync;
  let fsyncCount = 0;
  let stateFailureFd: number | null = null;
  const closedFds = new Set<number>();
  fs.fsyncSync = ((fd: number) => {
    fsyncCount += 1;
    if (fsyncCount === 3) {
      stateFailureFd = fd;
      throw new Error('state fsync failed');
    }
    return originalFsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.closeSync = ((fd: number) => {
    closedFds.add(fd);
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;
  fs.unlinkSync = ((target: Parameters<typeof fs.unlinkSync>[0]) => {
    if (stateFailureFd !== null && !closedFds.has(stateFailureFd)
      && typeof target === 'string' && target.endsWith('.tmp')) {
      throw new Error('state temp handle is still open');
    }
    return originalUnlinkSync(target);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(() => applyProvisioningPayload(payload(), { root, db }));
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.closeSync = originalCloseSync;
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(fsyncCount, 3);
  assert.equal(stateFailureFd !== null, true);
  if (stateFailureFd !== null) assert.equal(closedFds.has(stateFailureFd), true);
  assert.equal(fs.existsSync(path.join(root, 'config.yaml')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'runtime.env')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'state.json')), false);
  assert.deepEqual({
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  }, beforeDb);
  assertNoProvisioningTempFiles(root);
  db.close();
});

test('state temp close failure does not retry a potentially reused descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-state-close-'));
  const db = testDb();
  const beforeDb = {
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  };
  const originalFsyncSync = fs.fsyncSync;
  const originalCloseSync = fs.closeSync;
  let fsyncCount = 0;
  let stateTempFd: number | null = null;
  let stateCloseCalls = 0;
  fs.fsyncSync = ((fd: number) => {
    fsyncCount += 1;
    if (fsyncCount === 3) stateTempFd = fd;
    return originalFsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.closeSync = ((fd: number) => {
    if (fd === stateTempFd) {
      stateCloseCalls += 1;
      const result = originalCloseSync(fd);
      if (stateCloseCalls === 1) throw new Error('state close failed after close');
      return result;
    }
    return originalCloseSync(fd);
  }) as typeof fs.closeSync;
  try {
    assert.throws(() => applyProvisioningPayload(payload(), { root, db }));
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.closeSync = originalCloseSync;
  }
  assert.equal(stateTempFd === null, false);
  assert.equal(stateCloseCalls, 1);
  assert.equal(fs.existsSync(path.join(root, 'config.yaml')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'runtime.env')), false);
  assert.equal(fs.existsSync(path.join(root, 'data', 'provisioning', 'state.json')), false);
  assert.deepEqual({
    providers: db.prepare('SELECT * FROM providers ORDER BY id').all(),
    scripts: db.prepare('SELECT * FROM script_providers ORDER BY id').all(),
    videos: db.prepare('SELECT * FROM video_providers ORDER BY id').all(),
    tts: db.prepare('SELECT * FROM final_edit_tts_providers ORDER BY id').all(),
  }, beforeDb);
  assertNoProvisioningTempFiles(root);
  db.close();
});

test('state preserves schema-valid internal profile whitespace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-profile-whitespace-'));
  const db = testDb();
  const profileName = '公司\t统一\n配置\r轮换';
  assert.equal(validateProvisioningPayload(payload({ profileName })).profileName, profileName);
  applyProvisioningPayload(payload({ profileName }), { root, db, now: new Date('2026-08-06T00:00:00.000Z') });
  const state = readProvisioningState(root);
  assert.ok(state);
  assert.equal(state.profileName, profileName);
  assert.equal(readProvisioningStatus(root).profileName, profileName);
  db.close();
});

test('state requires a present and complete runtime credential file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-runtime-state-'));
  const db = testDb();
  applyProvisioningPayload(payload(), { root, db, now: new Date('2026-08-06T00:01:00.000Z') });
  const runtimePath = path.join(root, 'data', 'provisioning', 'runtime.env');
  const validRuntime = fs.readFileSync(runtimePath);
  const validRuntimeText = validRuntime.toString('utf8');
  const requiredKeys = [
    'CREATIVE_STUDIO_GATEWAY_API_KEY',
    'COMPANY_GATEWAY_API_KEY',
    'GATEWAY_API_KEY',
    'CREATIVE_STUDIO_COS_SECRET_ID',
    'CREATIVE_STUDIO_COS_SECRET_KEY',
    'CREATIVE_STUDIO_COS_DOMAIN',
  ];

  fs.unlinkSync(runtimePath);
  assert.equal(readProvisioningState(root), null);
  assert.equal(readProvisioningStatus(root).configured, false);

  fs.writeFileSync(runtimePath, Buffer.alloc(128 * 1024 + 1, 0x41));
  assert.equal(readProvisioningState(root), null);
  assert.equal(readProvisioningStatus(root).configured, false);

  for (const requiredKey of requiredKeys) {
    const withoutKey = validRuntimeText
      .split(/\r?\n/)
      .filter((line) => !line.startsWith(`${requiredKey}=`))
      .join('\n');
    fs.writeFileSync(runtimePath, withoutKey);
    assert.equal(readProvisioningState(root), null);
    assert.equal(readProvisioningStatus(root).configured, false);
  }

  const blankGateway = validRuntimeText.replace(/^CREATIVE_STUDIO_GATEWAY_API_KEY=.*$/m, 'CREATIVE_STUDIO_GATEWAY_API_KEY="');
  fs.writeFileSync(runtimePath, blankGateway);
  assert.equal(readProvisioningState(root), null);
  assert.equal(readProvisioningStatus(root).configured, false);

  fs.writeFileSync(runtimePath, validRuntime);
  assert.ok(readProvisioningState(root));
  assert.equal(readProvisioningStatus(root).configured, true);
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

test('import on a legacy CHECK-constraint database upgrades the video provider schema first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-provisioning-legacy-schema-'));
  const db = new Database(path.join(root, 'workbench.db'));
  db.pragma('foreign_keys = ON');
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
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('kling','jimeng')),
      baseUrlEnv TEXT NOT NULL, apiKeyEnv TEXT NOT NULL, modelEnv TEXT NOT NULL,
      defaultModel TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      defaultDurationSec INTEGER NOT NULL DEFAULT 5, defaultCostPerVideo REAL,
      baseUrl TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
      accessKey TEXT NOT NULL DEFAULT '', secretKey TEXT NOT NULL DEFAULT ''
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
    INSERT INTO video_providers (
      id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel,
      enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey
    ) VALUES ('legacy-kling', '旧可灵', 'kling', '', '', '', 'kling-1.6', 1, 5, '', 'legacy-secret', '', '');
  `);

  // Without the readiness gate the import fails on the legacy CHECK constraint.
  assert.throws(() => applyProvisioningPayload(payload(), { root, db }));

  // The provisioning route runs the safe schema upgrade before applying.
  const readiness = await checkVideoProviderGatewayReadiness({
    db,
    backupRoot: path.join(root, 'data', 'backups', 'schema-upgrades'),
    lockDatabasePath: path.join(root, 'data', 'schema-upgrade.lock.db'),
    auditFilePath: path.join(root, 'storage', 'logs', 'schema-upgrades.jsonl'),
  });
  assert.equal(readiness.available, true);

  const status = applyProvisioningPayload(payload(), { root, db });
  assert.equal(status.configured, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM video_providers WHERE id IN (?, ?)').get('company-kling-3', 'company-jimeng-2') as { count: number }).count, 2);
  assert.equal((db.prepare('SELECT apiKey FROM video_providers WHERE id=?').get('legacy-kling') as { apiKey: string }).apiKey, 'legacy-secret');
  assert.ok((db.prepare(`SELECT sql FROM sqlite_master WHERE name='video_providers'`).get() as { sql: string }).sql.includes('openai-video'));
  db.close();
});
