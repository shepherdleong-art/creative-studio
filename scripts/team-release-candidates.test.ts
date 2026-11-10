import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeReleaseManifest } from './team-server/distribution.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-release-candidates-'));
const candidateRoot = path.join(root, 'isolated-data', 'storage', 'maintenance', 'release-candidates');
const current = { appVersion: '0.7.1', dataSchemaVersion: 1 } as const;

function fixtureZip(releaseId = 'candidate-1', corrupt?: (root: string, manifest: Record<string, unknown>) => void): string {
  const directory = fs.mkdtempSync(path.join(root, 'package-'));
  const write = (relative: string, data: string) => {
    const target = path.join(directory, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  write('app/server.js', '// isolated server fixture\n');
  write('app/runtime/team-server-entry.cjs', '// isolated server entry\n');
  write('app/scripts/team-server/maintenance.mjs', '// isolated maintenance entry\n');
  const node = write('runtimes/node/node.exe', 'fixture node');
  const caddy = write('tools/caddy/caddy.exe', 'fixture caddy');
  const winsw = write('tools/winsw/WinSW.exe', 'fixture winsw');
  const lock = JSON.parse(fs.readFileSync(path.resolve('scripts/team-server/distribution-lock.json'), 'utf8')) as {
    fixture: boolean; media: unknown[];
    node: { binarySha256: string }; caddy: { binarySha256: string }; winsw: { sha256: string };
  };
  const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  lock.fixture = true;
  lock.media = [];
  lock.node.binarySha256 = sha256(node);
  lock.caddy.binarySha256 = sha256(caddy);
  lock.winsw.sha256 = sha256(winsw);
  write('service/distribution-lock.json', JSON.stringify(lock));
  write('service/packaging/forbidden-paths.json', fs.readFileSync(path.resolve('scripts/packaging/forbidden-paths.json'), 'utf8'));
  write('START-HERE.md', '# isolated server fixture\n');
  write('deployment.example.json', '{"schemaVersion":1}\n');
  const manifest = writeReleaseManifest(directory, {
    releaseId, appVersion: '0.7.1', sourceCommit: 'isolated-fixture', fixture: true,
    compatibility: { minAppVersion: '0.7.1', maxAppVersion: '0.7.1', dataSchemaMin: 1, dataSchemaMax: 1 },
  }) as unknown as Record<string, unknown>;
  manifest.compatibility = {
    minAppVersion: '0.7.1', maxAppVersion: '0.7.1', dataSchemaMin: 1, dataSchemaMax: 1,
  };
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  corrupt?.(directory, manifest);
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

async function zipDirectory(directory: string, destination: string): Promise<void> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  const pending = [directory];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const absolute = path.join(parent, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) pending.push(absolute);
      else zip.file(relative, fs.readFileSync(absolute));
    }
  }
  fs.writeFileSync(destination, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

try {
  const {
    prepareTeamReleaseCandidate,
    getTeamReleaseCandidateForExecution,
    readTeamReleaseCandidate,
  } = await import('../lib/team-service/maintenance/release-candidates.ts');
  await assert.rejects(() => getTeamReleaseCandidateForExecution({
    candidateRoot, candidateId: '../outside', current, allowFixtureForTests: true,
  }), /candidateId/);
  const source = fixtureZip();
  const archive = path.join(root, 'release.zip');
  await zipDirectory(source, archive);
  const concurrentRoot = path.join(root, 'concurrent-prepare');
  const concurrentUploads = await Promise.all(Array.from({ length: 2 }, () => prepareTeamReleaseCandidate({
    candidateRoot: concurrentRoot, archivePath: archive, originalName: 'server-release.zip',
    requestedBy: 'admin-test', current, allowFixtureForTests: true,
  })));
  assert.equal(concurrentUploads[0].candidateId, concurrentUploads[1].candidateId);
  assert.equal((await fs.promises.readdir(concurrentRoot)).filter((entry) => /^[a-f0-9]{64}$/.test(entry)).length, 1);
  const prepared = await prepareTeamReleaseCandidate({
    candidateRoot, archivePath: archive, originalName: 'server-release.zip',
    requestedBy: 'admin-test', current, allowFixtureForTests: true,
  });
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.release.releaseId, 'candidate-1');
  assert.equal(prepared.target.appVersion, '0.7.1');
  assert.equal(prepared.current.appVersion, '0.7.1');
  assert.equal(prepared.checks.manifestComplete, true);
  assert.equal(prepared.checks.contentHashes, true);
  assert.equal(prepared.checks.trustedDistribution, true);
  assert.equal(prepared.checks.compatibility, true);
  assert.equal(prepared.compatibility.compatible, true);
  assert.match(prepared.candidateId, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(path.join(candidateRoot, prepared.candidateId, 'release-manifest.json')), true,
    '完整发布清单必须在受管候选中持久化');
  assert.equal(fs.existsSync(path.join(candidateRoot, prepared.candidateId, 'payload', 'release-manifest.json')), false,
    '未复核使用目录不得直接当成完整发布目录');
  const duplicate = await prepareTeamReleaseCandidate({
    candidateRoot, archivePath: archive, originalName: 'renamed.zip',
    requestedBy: 'admin-test', current, allowFixtureForTests: true,
  });
  assert.equal(duplicate.candidateId, prepared.candidateId);
  assert.equal(duplicate.duplicate, true);
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => readTeamReleaseCandidate(
    candidateRoot, prepared.candidateId, current, true,
  )));
  assert.ok(concurrent.every((item) => item.status === 'ready'));
  const listed = await readTeamReleaseCandidate(candidateRoot, prepared.candidateId, current, true);
  assert.equal(listed.status, 'ready');
  assert.equal(listed.archiveSha256, prepared.archiveSha256);
  const consumer = await getTeamReleaseCandidateForExecution({
    candidateRoot, candidateId: prepared.candidateId, current, allowFixtureForTests: true,
  });
  assert.equal(consumer.release.packageSha256, prepared.release.packageSha256);
  assert.equal(fs.existsSync(consumer.payloadDirectory), true);
  assert.equal(consumer.payloadDirectory.startsWith(path.resolve(candidateRoot)), true);
  const { createMaintenancePreviewReader } = await import('../lib/team-service/maintenance/preview.ts');
  const preview = createMaintenancePreviewReader({ cacheMs: 0 });
  const previewRequest = { kind: 'candidates' as const, candidateRoot, current, allowFixtureForTests: true };
  try {
    const candidates = await preview.read(previewRequest) as Array<{ candidateId: string }>;
    assert.equal(candidates[0]?.candidateId, prepared.candidateId);
  } finally { await preview.stop(); }
  fs.appendFileSync(path.join(consumer.payloadDirectory, 'app', 'server.js.upload'), '// tampered\n');
  const invalidPreview = createMaintenancePreviewReader({ cacheMs: 0 });
  try { await assert.rejects(invalidPreview.read(previewRequest), /校验/); }
  finally { await invalidPreview.stop(); }
  await assert.rejects(() => readTeamReleaseCandidate(candidateRoot, prepared.candidateId, current, true),
    /哈希|manifest|内容/);
  await assert.rejects(() => getTeamReleaseCandidateForExecution({
    candidateRoot, candidateId: prepared.candidateId, current, allowFixtureForTests: true,
  }), /哈希|manifest|内容/);
  const badArchive = path.join(root, 'bad-release.zip');
  await zipDirectory(fixtureZip('corrupt-1', (directory) => {
    fs.appendFileSync(path.join(directory, 'app', 'server.js'), 'corrupted');
  }), badArchive);
  await assert.rejects(() => prepareTeamReleaseCandidate({
    candidateRoot, archivePath: badArchive, originalName: 'bad.zip', requestedBy: 'admin-test', current,
    allowFixtureForTests: true,
  }), /哈希/);
  const fsPromises = fs.promises;
  assert.equal((await fsPromises.readdir(candidateRoot)).filter((name) => name.startsWith('.upload-')).length, 0,
    '损坏包不得留下半截暂存');
  const incompatibleArchive = path.join(root, 'incompatible-release.zip');
  await zipDirectory(fixtureZip('incompatible-1', (_directory, manifest) => {
    manifest.compatibility = { minAppVersion: '0.8.0', maxAppVersion: '0.9.0', dataSchemaMin: 2, dataSchemaMax: 2 };
  }), incompatibleArchive);
  const incompatible = await prepareTeamReleaseCandidate({
    candidateRoot, archivePath: incompatibleArchive, originalName: 'incompatible.zip', requestedBy: 'admin-test', current,
    allowFixtureForTests: true,
  });
  assert.equal(incompatible.status, 'rejected');
  assert.equal(incompatible.failure?.code, 'incompatible_release');
  await assert.rejects(() => getTeamReleaseCandidateForExecution({
    candidateRoot, candidateId: incompatible.candidateId, current, allowFixtureForTests: true,
  }), /不能用于升级/);
  const validRoot = path.join(root, 'valid-consumption');
  await prepareTeamReleaseCandidate({
    candidateRoot: validRoot, archivePath: archive, originalName: 'valid.zip', requestedBy: 'admin-test', current,
    allowFixtureForTests: true,
  });
  const validConsumption = await getTeamReleaseCandidateForExecution({
    candidateRoot: validRoot, candidateId: duplicate.candidateId, current, allowFixtureForTests: true,
  });
  assert.equal(validConsumption.storageFormat, 'neutral-v1');
  assert.equal(validConsumption.manifest.files.length, validConsumption.files.length);
  for (const entry of validConsumption.files) {
    assert.equal(createHash('sha256').update(entry.readContent()).digest('hex'), entry.sha256);
  }
  assert.equal(fs.existsSync(path.join(consumer.payloadDirectory, 'app', 'server.js')), false,
    '中性候选不是可直接运行的发布目录');
  const lowSpaceRoot = path.join(root, 'low-space');
  await assert.rejects(() => prepareTeamReleaseCandidate({
    candidateRoot: lowSpaceRoot, archivePath: archive, originalName: 'no-space.zip', requestedBy: 'admin-test', current,
    allowFixtureForTests: true, availableBytes: async () => 1,
  }), /空间不足/);
  assert.deepEqual(await fs.promises.readdir(lowSpaceRoot), []);
  const forcedErrorRoot = path.join(root, 'write-failure');
  const originalCopy = fs.promises.copyFile;
  Object.defineProperty(fs.promises, 'copyFile', {
    configurable: true,
    value: async () => {
      const error = new Error('模拟磁盘已满') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    },
  });
  try {
    await assert.rejects(() => prepareTeamReleaseCandidate({
      candidateRoot: forcedErrorRoot, archivePath: archive, originalName: 'full.zip', requestedBy: 'admin-test', current,
      allowFixtureForTests: true, availableBytes: async () => Number.MAX_SAFE_INTEGER,
    }), /模拟磁盘已满/);
  } finally {
    Object.defineProperty(fs.promises, 'copyFile', { configurable: true, value: originalCopy });
  }
  assert.equal((await fs.promises.readdir(forcedErrorRoot)).some((name) => name.startsWith('.upload-')), false);
  for (const [name, corrupt] of [
    ['environment', (directory: string) => { fs.writeFileSync(path.join(directory, 'app', '.env.local'), 'SECRET=do-not-package'); }],
    ['extra', (directory: string) => { fs.writeFileSync(path.join(directory, 'app', 'unregistered.js'), 'extra'); }],
  ] as const) {
    const rejectedRoot = path.join(root, `rejected-${name}`);
    const rejectedZip = path.join(root, `${name}.zip`);
    await zipDirectory(fixtureZip(`${name}-release`, corrupt), rejectedZip);
    await assert.rejects(() => prepareTeamReleaseCandidate({
      candidateRoot: rejectedRoot, archivePath: rejectedZip, originalName: `${name}.zip`,
      requestedBy: 'admin-test', current, allowFixtureForTests: true,
    }));
    assert.equal((await fs.promises.readdir(rejectedRoot)).some((entry) => /^[a-f0-9]{64}$/.test(entry)), false);
  }
  await assert.rejects(() => prepareTeamReleaseCandidate({
    candidateRoot: path.join(root, 'production-trust'), archivePath: archive, originalName: 'fixture.zip',
    requestedBy: 'admin-test', current, allowFixtureForTests: false,
  }), /正式|测试包/);
  console.log('team release candidate persistence slice passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
