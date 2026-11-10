import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-current-version-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = path.join(root, 'data-root');
process.env.CREATIVE_STUDIO_SERVICE_ROOT = path.join(root, 'service');
process.env.CREATIVE_STUDIO_RELEASE_ROOT = path.join(root, 'release');
const releaseRoot = process.env.CREATIVE_STUDIO_RELEASE_ROOT;
const manifestPath = path.join(releaseRoot, 'release-manifest.json');
const pointerPath = path.join(process.env.CREATIVE_STUDIO_SERVICE_ROOT, 'current-release.json');
const originalRead = fs.readFileSync;
let close: (() => void) | undefined;
try {
  const { getDb, closeDb } = await import('../lib/db.ts');
  close = closeDb;
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS team_schema_migrations (version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO team_schema_migrations VALUES (16)');
  const { readCurrentTeamReleaseVersion } = await import('../lib/team-service/release-candidates.ts');
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  for (const file of ['app/server.js', 'app/runtime/team-server-entry.cjs', 'app/scripts/team-server/maintenance.mjs',
    'runtimes/node/node.exe', 'tools/caddy/caddy.exe', 'tools/winsw/WinSW.exe']) {
    const target = path.join(releaseRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture payload');
  }
  const manifest = {
    schemaVersion: 1, mode: 'windows-team-server-v1', releaseId: 'installed-1', appVersion: '0.7.1',
    builtAt: new Date().toISOString(), sourceCommit: 'test', fixture: false,
    compatibility: { minAppVersion: '0.7.1', maxAppVersion: '0.7.1', dataSchemaMin: 1, dataSchemaMax: 16 },
    dependencyLockSha256: 'a'.repeat(64),
    files: [{ path: 'app/server.js', size: 15, sha256: createHash('sha256').update('fixture payload').digest('hex') }],
  };
  const writeManifest = (value: object, releaseId = 'installed-1') => {
    const bytes = JSON.stringify(value);
    fs.writeFileSync(manifestPath, bytes);
    fs.writeFileSync(pointerPath, JSON.stringify({ schemaVersion: 1, releaseId,
      packageSha256: createHash('sha256').update(bytes).digest('hex'), switchedAt: new Date().toISOString() }));
  };
  writeManifest(manifest);
  // A version lookup must work without opening any production payload file.
  // Full installation/upgrade verification remains a separate operation.
  fs.readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
    const resolved = path.resolve(String(file));
    assert.ok(!resolved.startsWith(releaseRoot + path.sep) || resolved === manifestPath,
      '版本展示不应同步读取完整发布负载，阻塞其他请求');
    return Reflect.apply(originalRead, fs, [file, ...args]);
  }) as typeof fs.readFileSync;
  assert.deepEqual(await readCurrentTeamReleaseVersion(), { releaseId: 'installed-1', appVersion: '0.7.1', dataSchemaVersion: 16 });
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, appVersion: '9.9.9' }));
  await assert.rejects(readCurrentTeamReleaseVersion, /哈希|指针/);
  writeManifest(manifest, 'different-release');
  await assert.rejects(readCurrentTeamReleaseVersion, /身份|指针/);
  writeManifest({ ...manifest, fixture: true });
  await assert.rejects(readCurrentTeamReleaseVersion, /正式|清单/);
  writeManifest({ ...manifest, appVersion: 'invalid' });
  await assert.rejects(readCurrentTeamReleaseVersion, /版本|清单|manifest/);
  console.log('PASS: current-version lookup reads only pointer-bound metadata; tampering, wrong identity and invalid metadata fail closed');
} finally {
  fs.readFileSync = originalRead;
  close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
