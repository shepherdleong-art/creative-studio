import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { materializeTeamReleaseCandidate } from '../lib/team-service/maintenance/release-install.ts';
import { getTeamReleaseCandidateForExecution } from '../lib/team-service/maintenance/release-candidates.ts';
import { verifyReleaseManifest, writeReleaseManifest } from './team-server/distribution.mjs';
import JSZip from 'jszip';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-install-'));
try {
  const packageRoot = path.join(root, 'package');
  const write = (relative: string, content: string) => {
    const file = path.join(packageRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  write('app/server.js', 'new application');
  write('app/runtime/team-server-entry.cjs', 'new entry');
  write('app/scripts/team-server/maintenance.mjs', 'new worker');
  write('runtime/process-tree.mjs', 'deployment helper');
  const node = write('runtimes/node/node.exe', 'new node');
  const caddy = write('tools/caddy/caddy.exe', 'new caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'new winsw');
  const lock = JSON.parse(fs.readFileSync('scripts/team-server/distribution-lock.json', 'utf8'));
  const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  lock.fixture = true; lock.media = [];
  lock.node.binarySha256 = hash(node); lock.caddy.binarySha256 = hash(caddy); lock.winsw.sha256 = hash(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync('scripts/packaging/forbidden-paths.json', 'utf8'));
  write('START-HERE.md', 'fixture'); write('deployment.example.json', '{"schemaVersion":1}');
  writeReleaseManifest(packageRoot, { releaseId: 'new-isolated', appVersion: '0.8.0', sourceCommit: 'fixture', fixture: true,
    compatibility: { minAppVersion: '0.7.0', maxAppVersion: '0.8.0', dataSchemaMin: 1, dataSchemaMax: 8 } });
  const zip = new JSZip();
  for (const relative of ['app/server.js', 'app/runtime/team-server-entry.cjs', 'app/scripts/team-server/maintenance.mjs', 'runtime/process-tree.mjs', 'runtimes/node/node.exe', 'tools/caddy/caddy.exe', 'tools/winsw/WinSW.exe', 'service/distribution-lock.json', 'service/packaging/forbidden-paths.json', 'START-HERE.md', 'deployment.example.json', 'release-manifest.json']) zip.file(relative, fs.readFileSync(path.join(packageRoot, ...relative.split('/'))));
  const archive = path.join(root, 'release.zip'); fs.writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const candidateRoot = path.join(root, 'data', 'storage', 'maintenance', 'release-candidates');
  const { prepareTeamReleaseCandidate } = await import('../lib/team-service/maintenance/release-candidates.ts');
  const candidate = await prepareTeamReleaseCandidate({ candidateRoot, archivePath: archive, originalName: 'new.zip', requestedBy: 'admin', current: { appVersion: '0.7.1', dataSchemaVersion: 7 }, allowFixtureForTests: true });
  const execution = await getTeamReleaseCandidateForExecution({ candidateRoot, candidateId: candidate.candidateId, current: { appVersion: '0.7.1', dataSchemaVersion: 7 }, allowFixtureForTests: true });
  const deploymentRoot = path.join(root, 'deployment');
  const materialized = await materializeTeamReleaseCandidate({ deploymentRoot, release: execution.release, files: execution.files, compatibility: execution.manifest.compatibility, manifestContent: fs.readFileSync(path.join(candidateRoot, candidate.candidateId, 'release-manifest.json')), allowFixtureForTests: true });
  assert.equal(verifyReleaseManifest(materialized.releaseRoot, { allowFixture: true }).releaseId, 'new-isolated');
  const repeated = await materializeTeamReleaseCandidate({ deploymentRoot, release: execution.release, files: execution.files, compatibility: execution.manifest.compatibility, manifestContent: fs.readFileSync(path.join(candidateRoot, candidate.candidateId, 'release-manifest.json')), allowFixtureForTests: true });
  assert.equal(repeated.alreadyMaterialized, true);
  const config = path.join(deploymentRoot, 'config', 'deployment.json');
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, 'external-secret');
  assert.equal(fs.readFileSync(config, 'utf8'), 'external-secret');
  assert.equal(fs.existsSync(path.join(materialized.releaseRoot, 'data')), false);
  assert.equal(fs.existsSync(path.join(materialized.releaseRoot, '.env.local')), false);
  fs.writeFileSync(path.join(materialized.releaseRoot, 'app', 'server.js'), 'tampered');
  await assert.rejects(() => materializeTeamReleaseCandidate({ deploymentRoot, release: execution.release, files: execution.files, compatibility: execution.manifest.compatibility, manifestContent: fs.readFileSync(path.join(candidateRoot, candidate.candidateId, 'release-manifest.json')), allowFixtureForTests: true }));
  console.log('team release immutable installation and config isolation passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
