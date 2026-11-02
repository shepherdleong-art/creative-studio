import assert from 'node:assert/strict';
import { ZipArchive } from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  console.log('team client native update process tests skipped (not Windows)');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { createNativeUpdateProcessControl } = require('../dist-desktop/client/update-helper.js');
const { ClientUpdateCoordinator } = require('../dist-desktop/client/update-coordinator.js');
const { signUpdateManifest } = require('../dist-desktop/client/update-package.js');
const ORIGIN = 'https://studio.example.test';
const roots = [];
const children = new Set();
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-native-update-'));
  roots.push(value);
  return value;
}
function zipDirectory(source, destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    void archive.finalize();
  });
}
function writeVersion(installRoot, releaseId, healthy) {
  const directory = path.join(installRoot, 'versions', releaseId);
  fs.mkdirSync(path.join(directory, 'electron'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(directory, 'electron', 'electron.exe'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"main":"app.js"}\n');
  fs.writeFileSync(path.join(directory, 'app.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const health = {
      releaseId: process.env.CREATIVE_STUDIO_CLIENT_RELEASE_ID,
      pid: process.pid,
      healthy: ${healthy},
      stateSchema: 1,
      apiVersion: 1,
    };
    const target = path.join(process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT, 'run', 'client-health.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(health));
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({ releaseId, version: '0.7.1' }));
  return directory;
}
function manifestFor(releaseId, bytes) {
  return signUpdateManifest({
    schemaVersion: 1, releaseId, platform: 'win32', arch: 'x64', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), version: '0.7.1',
    api: { min: 1, max: 1 }, clientStateSchema: { min: 1, max: 1 },
    packageUrl: `${ORIGIN}/${releaseId}.zip`, entry: 'app.js',
  }, privateKey);
}
async function fixture({ healthy = true, allowOldExit = true } = {}) {
  const installRoot = root();
  const oldDirectory = writeVersion(installRoot, 'old', true);
  const newDirectory = writeVersion(installRoot, 'new', healthy);
  const stateRoot = path.join(installRoot, 'client-state');
  fs.mkdirSync(path.join(stateRoot, 'downloads'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'state.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(stateRoot, 'downloads', 'keep'), 'keep');
  const archive = path.join(installRoot, 'new.zip');
  await zipDirectory(newDirectory, archive);
  fs.rmSync(newDirectory, { recursive: true, force: true });
  const bytes = fs.readFileSync(archive);
  const newManifest = manifestFor('new', bytes);
  const oldManifest = manifestFor('old', Buffer.alloc(0));
  fs.writeFileSync(path.join(installRoot, 'current.json'), JSON.stringify({
    schemaVersion: 1, releaseId: 'old', directory: 'versions/old', manifest: oldManifest,
  }));
  const old = spawn(path.join(oldDirectory, 'electron', 'electron.exe'), [oldDirectory], {
    env: { ...process.env, CREATIVE_STUDIO_CLIENT_STATE_ROOT: stateRoot, CREATIVE_STUDIO_CLIENT_RELEASE_ID: 'old' },
    stdio: 'ignore', windowsHide: true,
  });
  children.add(old);
  old.once('exit', () => children.delete(old));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const job = {
    schemaVersion: 1, jobId: crypto.randomUUID(), installRoot,
    manifestUrl: `${ORIGIN}/stable.json`, serverOrigin: ORIGIN,
    currentPid: old.pid, platform: 'win32', arch: 'x64',
  };
  const paths = path.join(installRoot, 'updates', 'jobs');
  const monitor = setInterval(() => {
    if (fs.existsSync(path.join(paths, `${job.jobId}.pause-request`))) {
      fs.writeFileSync(path.join(paths, `${job.jobId}.pause-ack`), '{}');
    }
    if (allowOldExit && fs.existsSync(path.join(paths, `${job.jobId}.stop-request`)) && old.exitCode === null) {
      old.kill();
    }
  }, 25);
  const coordinator = new ClientUpdateCoordinator({
    rootDir: installRoot, publicKey: publicPem, platform: 'win32', arch: 'x64', trustedOrigins: [ORIGIN],
    spaceProbe: () => {},
    fetch: async (url) => url === job.manifestUrl ? Response.json(newManifest) : new Response(bytes),
    processControl: createNativeUpdateProcessControl(job, { stopCurrentTimeoutMs: 500, healthTimeoutMs: 4000 }),
  });
  return { installRoot, old, coordinator, monitor, job, stateRoot };
}
async function cleanupChild(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch { /* already exited */ }
}

try {
  {
    const { installRoot, old, coordinator, monitor, stateRoot } = await fixture();
    const result = await coordinator.applyFromUrl(`${ORIGIN}/stable.json`);
    clearInterval(monitor);
    assert.equal(result.status, 'committed');
    assert.equal(old.exitCode !== null || old.signalCode !== null, true, '旧进程在新版健康前退出');
    const health = JSON.parse(fs.readFileSync(path.join(stateRoot, 'run', 'client-health.json'), 'utf8'));
    assert.equal(health.releaseId, 'new');
    children.add({ pid: health.pid });
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, 'run', 'transfer-gate.json'), 'utf8')).blocked, false);
    assert.equal(fs.readFileSync(path.join(stateRoot, 'downloads', 'keep'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(installRoot, 'versions', 'old')), true, '旧占用目录不原地覆盖或强删');
    await cleanupChild(health.pid);
  }
  {
    const { installRoot, old, coordinator, monitor } = await fixture({ allowOldExit: false });
    const result = await coordinator.applyFromUrl(`${ORIGIN}/stable.json`);
    clearInterval(monitor);
    assert.equal(result.status, 'rejected');
    assert.match(result.message, /超时/);
    assert.equal(old.exitCode, null, '占用测试旧进程仍未退出');
    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, 'current.json'), 'utf8')).releaseId, 'old');
    old.kill();
  }
  {
    const { coordinator, monitor, stateRoot } = await fixture({ healthy: false });
    const result = await coordinator.applyFromUrl(`${ORIGIN}/stable.json`);
    clearInterval(monitor);
    assert.equal(result.status, 'rolled_back');
    const health = JSON.parse(fs.readFileSync(path.join(stateRoot, 'run', 'client-health.json'), 'utf8'));
    assert.equal(health.releaseId, 'old');
    children.add({ pid: health.pid });
    await cleanupChild(health.pid);
  }
  console.log('team client native Windows update process tests passed');
} finally {
  for (const child of children) await cleanupChild(child.pid);
  for (const directory of roots) fs.rmSync(directory, { recursive: true, force: true });
}
