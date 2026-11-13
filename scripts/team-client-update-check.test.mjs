import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkClientUpdate } = require('../dist-desktop/client/update-check.js');
const { signUpdateManifest } = require('../dist-desktop/client/update-package.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-update-check-'));
const origin = 'https://studio.example.test';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const signed = releaseId => signUpdateManifest({ schemaVersion: 1, releaseId,
  platform: process.platform === 'win32' ? 'win32' : 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  version: '0.7.1', size: 10, sha256: 'a'.repeat(64), api: { min: 1, max: 1 }, clientStateSchema: { min: 1, max: 1 },
  entry: 'dist-desktop/main.js', packageUrl: origin + '/client-updates/' + releaseId + '.zip' }, privateKey);
try {
  fs.writeFileSync(path.join(root, 'update-public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  const installed = signed('installed');
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ releaseId: installed.releaseId, manifest: installed }));
  const original = fs.readFileSync(path.join(root, 'current.json'));
  let latest = installed;
  const requests = [];
  const options = { installRoot: root, origin, manifestUrl: origin + '/client-updates/current.manifest.json',
    fetch: async (url, init) => { requests.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); return Response.json(latest); } };
  assert.deepEqual(await checkClientUpdate(options), { upToDate: true, releaseId: 'installed' });
  latest = signed('next-release-same-semver');
  assert.deepEqual(await checkClientUpdate(options), { upToDate: false, releaseId: 'next-release-same-semver' });
  latest = { ...latest, releaseId: 'tampered' };
  await assert.rejects(checkClientUpdate(options), /签名/);
  const count = requests.length;
  await assert.rejects(checkClientUpdate({ ...options, manifestUrl: 'https://other.example.test/client-updates/current.manifest.json' }), /地址/);
  await assert.rejects(checkClientUpdate({ ...options, manifestUrl: origin + '/unmanaged.json' }), /地址/);
  assert.equal(requests.length, count, '拒绝跨源和非受管 URL，不能发送请求');
  await assert.rejects(checkClientUpdate({ ...options, fetch: async () => new Response(null, { status: 503 }) }), /读取失败/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'current.json')), original, '检查更新不改当前指针或本机数据');
  assert.deepEqual(fs.readdirSync(root).sort(), ['current.json', 'update-public-key.pem']);
  assert.ok(requests.every(url => url.endsWith('.manifest.json')), '检查更新不得下载 ZIP');
  console.log('PASS: signed release checks recognize the current release, same-semver updates, invalid signatures and unavailable servers without mutating state');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
