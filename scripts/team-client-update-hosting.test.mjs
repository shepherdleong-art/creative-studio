import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { signUpdateManifest, ClientUpdateCoordinator } = require('../dist-desktop/client/index.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publisher = path.join(repoRoot, 'scripts', 'team-server', 'publish-client-update.mjs');
const ORIGIN = 'https://studio.example.test';
const roots = [];
function tempRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `team-client-hosting-${prefix}-`));
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
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(input), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(input.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(crc32(input), 16);
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
function packageFor(releaseId) {
  return zip([
    { name: 'release.json', data: JSON.stringify({ releaseId, version: releaseId === 'old' ? '0.7.0' : '0.7.1' }) },
    { name: 'dist-desktop/main.js', data: `console.log(${JSON.stringify(releaseId)});\n` },
  ]);
}
function manifestFor(releaseId, bytes, overrides = {}) {
  return signUpdateManifest({
    schemaVersion: 1,
    releaseId,
    platform: 'win32',
    arch: 'x64',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    version: releaseId === 'old' ? '0.7.0' : '0.7.1',
    api: { min: 1, max: 1 },
    clientStateSchema: { min: 1, max: 1 },
    packageUrl: `${ORIGIN}/client-updates/${releaseId}.zip`,
    entry: 'dist-desktop/main.js',
    ...overrides,
  }, privateKey);
}
function buildSource(releaseId, { archive, manifest } = {}) {
  const root = tempRoot('source');
  fs.mkdirSync(path.join(root, 'updates'), { recursive: true });
  const bytes = archive ?? packageFor(releaseId);
  const signed = manifest ?? manifestFor(releaseId, bytes);
  fs.writeFileSync(path.join(root, 'updates', `${releaseId}.zip`), bytes);
  fs.writeFileSync(path.join(root, 'updates', `${releaseId}.manifest.json`), `${JSON.stringify(signed, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'update-public-key.pem'), publicPem);
  fs.writeFileSync(path.join(root, 'current.json'), `${JSON.stringify({ schemaVersion: 1, releaseId, directory: `versions/${releaseId}` }, null, 2)}\n`);
  return { root, bytes, manifest: signed };
}
function publish(source, deploymentRoot, overrides = {}) {
  const result = spawnSync(process.execPath, [
    publisher, '--source', source.root, '--deployment-root', deploymentRoot, '--origin', overrides.origin ?? ORIGIN,
    ...(overrides.dryRun ? ['--dry-run'] : []),
  ], { cwd: repoRoot, encoding: 'utf8' });
  return result;
}
function hostedRoot(deploymentRoot) {
  return path.join(deploymentRoot, 'client-updates');
}
function initialInstallation(root, oldManifest) {
  fs.mkdirSync(path.join(root, 'versions', 'old'), { recursive: true });
  fs.mkdirSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client-state', 'state.json'), '{"schemaVersion":1,"owner":"old"}\n');
  fs.writeFileSync(path.join(root, 'client-state', 'accounts', 'a', 'downloads', 'keep.bin'), 'keep');
  fs.writeFileSync(path.join(root, 'current.json'), `${JSON.stringify({ schemaVersion: 1, releaseId: 'old', directory: 'versions/old', manifest: oldManifest }, null, 2)}\n`);
}
function coordinatorFor(root, fetchImpl, events = []) {
  return new ClientUpdateCoordinator({
    rootDir: root,
    publicKey: publicPem,
    platform: 'win32',
    arch: 'x64',
    trustedOrigins: [ORIGIN],
    fetch: fetchImpl,
    processControl: {
      pauseTransfers: async () => { events.push('pause'); },
      resumeTransfers: async () => { events.push('resume'); },
      stopCurrent: async () => {},
      stopVersion: async () => {},
      startVersion: async ({ releaseId, transfersEnabled }) => {
        assert.equal(transfersEnabled, false, '健康确认前不得恢复传输');
        return {
          waitForHealth: async () => ({ healthy: true, stateSchema: 1, apiVersion: 1 }),
          stop: async () => { events.push(`stop-${releaseId}`); },
        };
      },
    },
  });
}
function serveHosting(directory, onRequest) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (onRequest) onRequest(url);
    if (url.pathname === '/client-updates' || url.pathname === '/client-updates/') {
      response.writeHead(404).end();
      return;
    }
    if (!url.pathname.startsWith('/client-updates/')) {
      response.writeHead(404).end();
      return;
    }
    let name;
    try { name = decodeURIComponent(url.pathname.slice('/client-updates/'.length)); }
    catch { response.writeHead(400).end(); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const bytes = fs.readFileSync(file);
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    response.end(bytes);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function httpGet(origin, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(pathname, origin), (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
  });
}

try {
  const deploymentRoot = tempRoot('deploy');
  const first = buildSource('0.7.1');
  const firstPublish = publish(first, deploymentRoot);
  assert.equal(firstPublish.status, 0, firstPublish.stderr);
  assert.deepEqual(fs.readdirSync(hostedRoot(deploymentRoot)).sort(),
    ['0.7.1.manifest.json', '0.7.1.zip', 'current.manifest.json']);
  assert.deepEqual(fs.readFileSync(path.join(hostedRoot(deploymentRoot), '0.7.1.zip')), first.bytes);
  assert.equal(fs.readFileSync(path.join(hostedRoot(deploymentRoot), 'current.manifest.json'), 'utf8'),
    fs.readFileSync(path.join(hostedRoot(deploymentRoot), '0.7.1.manifest.json'), 'utf8'),
    '指针必须与已发布版本 manifest 字节一致');
  assert.equal(fs.existsSync(path.join(hostedRoot(deploymentRoot), 'update-public-key.pem')), false, '托管目录不得暴露公钥以外文件');

  const dryRun = publish(first, deploymentRoot, { dryRun: true });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  assert.equal(JSON.parse(dryRun.stdout).publishOrder.at(-1).name, 'current.manifest.json', '指针必须最后发布');

  const idempotent = publish(first, deploymentRoot);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.deepEqual(fs.readdirSync(hostedRoot(deploymentRoot)).sort(),
    ['0.7.1.manifest.json', '0.7.1.zip', 'current.manifest.json']);

  const tamperedZip = Buffer.from(first.bytes);
  tamperedZip[0] ^= 0xff;
  const tampered = buildSource('0.7.1', { archive: tamperedZip, manifest: first.manifest });
  assert.notEqual(publish(tampered, deploymentRoot).status, 0, '哈希不符必须拒绝发布');
  const wrongOrigin = buildSource('0.7.2', {
    manifest: manifestFor('0.7.2', packageFor('0.7.2'), { packageUrl: 'https://evil.example.test/client-updates/0.7.2.zip' }),
  });
  assert.notEqual(publish(wrongOrigin, deploymentRoot).status, 0, '跨 origin 包地址必须拒绝发布');
  assert.equal(fs.readFileSync(path.join(hostedRoot(deploymentRoot), 'current.manifest.json'), 'utf8'),
    fs.readFileSync(path.join(hostedRoot(deploymentRoot), '0.7.1.manifest.json'), 'utf8'),
    '失败发布不得改变线上指针');

  const second = buildSource('0.7.2');
  const secondPublish = publish(second, deploymentRoot);
  assert.equal(secondPublish.status, 0, secondPublish.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostedRoot(deploymentRoot), 'current.manifest.json'), 'utf8')).releaseId, '0.7.2');
  assert.deepEqual(fs.readdirSync(hostedRoot(deploymentRoot)).sort(),
    ['0.7.1.manifest.json', '0.7.1.zip', '0.7.2.manifest.json', '0.7.2.zip', 'current.manifest.json']);

  const server = await serveHosting(hostedRoot(deploymentRoot));
  const { port } = server.address();
  const localOrigin = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await httpGet(localOrigin, '/client-updates')).status, 404, '托管根目录不得列目录');
    assert.equal((await httpGet(localOrigin, '/client-updates/')).status, 404);
    assert.equal((await httpGet(localOrigin, '/client-updates/%2e%2e/config.yaml')).status, 404, '越界路径必须拒绝');
    assert.equal((await httpGet(localOrigin, '/client-updates/../config.yaml')).status, 404);
    const pointer = await httpGet(localOrigin, '/client-updates/current.manifest.json');
    assert.equal(pointer.status, 200);
    assert.equal(JSON.parse(pointer.body.toString('utf8')).releaseId, '0.7.2');
    const archive = await httpGet(localOrigin, '/client-updates/0.7.2.zip');
    assert.equal(archive.status, 200);
    assert.equal(crypto.createHash('sha256').update(archive.body).digest('hex'), second.manifest.sha256);

    const clientRoot = tempRoot('client');
    initialInstallation(clientRoot, manifestFor('old', Buffer.alloc(0)));
    const events = [];
    const coordinator = coordinatorFor(clientRoot, async (url) => {
      const parsed = new URL(url);
      if (parsed.origin !== ORIGIN) throw new Error(`unexpected_origin:${parsed.origin}`);
      const response = await httpGet(localOrigin, parsed.pathname);
      if (response.status !== 200) return new Response('', { status: response.status });
      return new Response(response.body, { status: 200 });
    }, events);
    const applied = await coordinator.applyFromUrl(`${ORIGIN}/client-updates/current.manifest.json`);
    assert.equal(applied.status, 'committed');
    const pointerAfter = JSON.parse(fs.readFileSync(path.join(clientRoot, 'current.json'), 'utf8'));
    assert.equal(pointerAfter.releaseId, '0.7.2');
    assert.equal(fs.readFileSync(path.join(clientRoot, 'client-state', 'state.json'), 'utf8'), '{"schemaVersion":1,"owner":"old"}\n');
    assert.equal(fs.readFileSync(path.join(clientRoot, 'client-state', 'accounts', 'a', 'downloads', 'keep.bin'), 'utf8'), 'keep');
    assert.equal(events.at(-1), 'resume');

    const foreignRoot = tempRoot('foreign');
    initialInstallation(foreignRoot, manifestFor('old', Buffer.alloc(0)));
    let foreignFetches = 0;
    const foreign = coordinatorFor(foreignRoot, async () => { foreignFetches += 1; throw new Error('must_not_fetch_foreign'); });
    const foreignResult = await foreign.applyFromUrl('https://evil.example.test/client-updates/current.manifest.json');
    assert.equal(foreignResult.status, 'rejected');
    assert.equal(foreignFetches, 0, '跨来源地址必须在下载前拒绝');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('team client update hosting integration passed');
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
