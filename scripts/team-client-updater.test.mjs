import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const {
  signUpdateManifest,
  verifyUpdateManifest,
  extractZipSafely,
  ClientUpdateCoordinator,
} = require('../dist-desktop/client/index.js');

const ORIGIN = 'https://studio.example.test';
const roots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-updater-'));
  roots.push(root);
  return root;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const input = Buffer.from(entry.data ?? '');
    const data = entry.deflate ? zlib.deflateRawSync(input) : input;
    const method = entry.deflate ? 8 : 0;
    const checksum = crc32(input);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(input.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(input.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
function manifest(releaseId, packageBytes, overrides = {}) {
  return signUpdateManifest({
    schemaVersion: 1,
    releaseId,
    platform: 'win32',
    arch: 'x64',
    size: packageBytes.length,
    sha256: crypto.createHash('sha256').update(packageBytes).digest('hex'),
    version: releaseId === 'old' ? '0.7.0' : '0.7.1',
    api: { min: 1, max: 1 },
    clientStateSchema: { min: 1, max: 1 },
    packageUrl: `${ORIGIN}/client-updates/${releaseId}.zip`,
    entry: 'dist-desktop/main.js',
    ...overrides,
  }, privateKey);
}
function packageFor(releaseId, extra = []) {
  return zip([
    { name: 'release.json', data: JSON.stringify({ releaseId, version: releaseId === 'old' ? '0.7.0' : '0.7.1' }) },
    { name: 'dist-desktop/main.js', data: `console.log(${JSON.stringify(releaseId)});\n` },
    ...extra,
  ]);
}
function initialInstallation(root, oldManifest = manifest('old', Buffer.alloc(0))) {
  fs.mkdirSync(path.join(root, 'versions', 'old'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client-state', 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client-state', 'state.json'), '{"schemaVersion":1,"owner":"old"}\n');
  fs.writeFileSync(path.join(root, 'client-state', 'accounts', 'a', 'transfers.json'), '{"records":[{"id":"old"}]}\n');
  fs.writeFileSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads', 'keep.bin'), 'account-keep');
  fs.writeFileSync(path.join(root, 'client-state', 'downloads', 'keep.bin'), 'keep');
  fs.writeFileSync(path.join(root, 'current.json'), `${JSON.stringify({ schemaVersion: 1, releaseId: 'old', directory: 'versions/old', manifest: oldManifest }, null, 2)}\n`);
  return oldManifest;
}
function runtime(root, options = {}) {
  const events = [];
  const packageByUrl = new Map(options.packages ?? []);
  const manifestByUrl = new Map(options.manifests ?? []);
  const coordinator = new ClientUpdateCoordinator({
    rootDir: root,
    publicKey: publicPem,
    platform: 'win32',
    arch: 'x64',
    trustedOrigins: [ORIGIN],
    spaceProbe: options.spaceProbe ?? (() => {}),
    fetch: options.fetch ?? (async (url) => {
      if (manifestByUrl.has(url)) return Response.json(manifestByUrl.get(url));
      if (packageByUrl.has(url)) {
        const value = packageByUrl.get(url);
        if (value instanceof Error) throw value;
        return new Response(value);
      }
      throw new Error('network_offline');
    }),
    processControl: {
      pauseTransfers: async () => { events.push('pause'); },
      resumeTransfers: async () => { events.push('resume'); },
      stopCurrent: async () => { events.push('stop-old'); if (options.stopOldError) throw options.stopOldError; },
      startVersion: async ({ releaseId, transfersEnabled }) => {
        events.push(`start-${releaseId}`);
        if (options.startError && releaseId !== 'old') throw options.startError;
        assert.equal(transfersEnabled, false, '健康确认前不得恢复传输');
        return {
          waitForHealth: async () => {
            events.push(`health-${releaseId}`);
            if (options.healthError && releaseId !== 'old') throw options.healthError;
            if (releaseId !== 'old' && options.health) return options.health;
            return { healthy: true, stateSchema: 1, apiVersion: 1 };
          },
          stop: async () => { events.push(`stop-${releaseId}`); },
        };
      },
    },
  });
  return { coordinator, events };
}
function current(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
}

try {
  const goodPackage = packageFor('new');
  const good = manifest('new', goodPackage);
  assert.equal(verifyUpdateManifest(good, publicPem, {
    platform: 'win32', arch: 'x64', trustedOrigins: [ORIGIN],
  }).releaseId, 'new');
  const badSignature = { ...good, version: '9.9.9' };
  assert.throws(() => verifyUpdateManifest(badSignature, publicPem, {
    platform: 'win32', arch: 'x64', trustedOrigins: [ORIGIN],
  }), /签名|signature/i);
  const unknownUrl = manifest('unknown', goodPackage, { packageUrl: 'https://unknown.example/new.zip' });
  assert.throws(() => verifyUpdateManifest(unknownUrl, publicPem, {
    platform: 'win32', arch: 'x64', trustedOrigins: [ORIGIN],
  }), /URL|来源|受控/i);

  for (const [name, entry] of [
    ['traversal', { name: '../escape.txt', data: 'bad' }],
    ['absolute', { name: '/escape.txt', data: 'bad' }],
    ['ads', { name: 'dist-desktop/main.js:evil', data: 'bad' }],
  ]) {
    const root = tempRoot();
    const archive = path.join(root, `${name}.zip`);
    fs.writeFileSync(archive, zip([entry]));
    assert.throws(() => extractZipSafely(archive, path.join(root, 'output')), /路径|名称|ZIP/i, name);
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  }
  {
    const root = tempRoot();
    const archive = path.join(root, 'bomb.zip');
    fs.writeFileSync(archive, zip([{ name: 'bomb.bin', data: Buffer.alloc(8192), deflate: true }]));
    assert.throws(() => extractZipSafely(archive, path.join(root, 'output'), { maxTotalBytes: 1024 }), /大小|炸弹|上限|空间/i);
  }

  async function rejectedCase(name, setup) {
    const root = tempRoot();
    initialInstallation(root);
    const fixture = setup(root);
    const { coordinator, events } = runtime(root, fixture);
    const result = await coordinator.applyFromUrl(`${ORIGIN}/client-updates/stable.json`);
    assert.equal(result.status, 'rejected', name);
    assert.equal(current(root).releaseId, 'old', name);
    assert.equal(fs.readFileSync(path.join(root, 'client-state', 'state.json'), 'utf8'), '{"schemaVersion":1,"owner":"old"}\n');
    assert.equal(events.includes('resume'), fixture.resume ?? false);
    return { root, result, events };
  }
  await rejectedCase('bad signature', () => ({
    manifests: [[`${ORIGIN}/client-updates/stable.json`, { ...good, version: '9.9.9' }]],
  }));
  await rejectedCase('bad hash', () => ({
    manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
    packages: [[good.packageUrl, packageFor('tampered')]],
  }));
  await rejectedCase('offline', () => ({
    manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
    packages: [[good.packageUrl, new Error('network_offline')]],
  }));
  await rejectedCase('disk full', () => ({
    manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
    spaceProbe: () => { throw new Error('insufficient_disk'); },
  }));
  await rejectedCase('old process occupied', () => ({
    manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
    packages: [[good.packageUrl, goodPackage]],
    stopOldError: new Error('EBUSY'), resume: true,
  }));

  async function rollbackCase(name, health, expectedStatus) {
    const root = tempRoot();
    initialInstallation(root);
    const { coordinator, events } = runtime(root, {
      manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
      packages: [[good.packageUrl, goodPackage]], health,
    });
    const result = await coordinator.applyFromUrl(`${ORIGIN}/client-updates/stable.json`);
    assert.equal(result.status, expectedStatus, name);
    assert.equal(current(root).releaseId, 'old', name);
    assert.ok(events.indexOf(`stop-new`) > events.indexOf('health-new'), '失败必须先停新版再回滚');
    assert.equal(fs.readFileSync(path.join(root, 'client-state', 'downloads', 'keep.bin'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads', 'keep.bin'), 'utf8'), 'account-keep');
    assert.equal(fs.existsSync(path.join(root, 'updates', 'snapshots', 'new', 'accounts', 'a', 'downloads')), false, '账号下载不得进入状态快照');
    if (expectedStatus === 'rolled_back') {
      assert.equal(fs.readFileSync(path.join(root, 'client-state', 'state.json'), 'utf8'), '{"schemaVersion":1,"owner":"old"}\n');
      assert.equal(events.at(-1), 'resume');
    } else {
      assert.equal(events.includes('resume'), false, '状态/API 不兼容时不得恢复业务传输');
    }
  }
  await rollbackCase('startup failure compatible', { healthy: false, stateSchema: 1, apiVersion: 1 }, 'rolled_back');
  await rollbackCase('state migration incompatible', { healthy: false, stateSchema: 2, apiVersion: 1 }, 'recovery_required');
  await rollbackCase('api incompatible', { healthy: false, stateSchema: 1, apiVersion: 2 }, 'recovery_required');

  for (const [name, failure] of [['health throw', 'healthError'], ['spawn throw', 'startError']]) {
    const root = tempRoot();
    initialInstallation(root);
    const { coordinator, events } = runtime(root, {
      manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
      packages: [[good.packageUrl, goodPackage]],
      [failure]: new Error(`${name} fixture`),
    });
    const result = await coordinator.applyFromUrl(`${ORIGIN}/client-updates/stable.json`);
    assert.equal(result.status, 'rolled_back', name);
    assert.equal(current(root).releaseId, 'old', name);
    assert.equal(events.at(-1), 'resume', name);
  }

  {
    const root = tempRoot();
    initialInstallation(root);
    const { coordinator, events } = runtime(root, {
      manifests: [[`${ORIGIN}/client-updates/stable.json`, good]],
      packages: [[good.packageUrl, goodPackage]],
    });
    const result = await coordinator.applyFromUrl(`${ORIGIN}/client-updates/stable.json`);
    assert.equal(result.status, 'committed');
    assert.equal(current(root).releaseId, 'new');
    assert.ok(events.indexOf('stop-old') > events.indexOf('pause'));
    assert.ok(events.indexOf('health-new') > events.indexOf('start-new'));
    assert.equal(events.at(-1), 'resume');
    assert.equal(fs.existsSync(path.join(root, 'versions', 'old')), true, '保留最近可用版本，占用目录延后清理');
    assert.equal(fs.readFileSync(path.join(root, 'client-state', 'downloads', 'keep.bin'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads', 'keep.bin'), 'utf8'), 'account-keep');
    assert.equal(fs.existsSync(path.join(root, 'updates', 'snapshots', 'new', 'accounts', 'a', 'downloads')), false);
    assert.equal(fs.existsSync(path.join(root, 'updates', 'snapshots')), true);
  }
  console.log('team client updater fault matrix passed');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
