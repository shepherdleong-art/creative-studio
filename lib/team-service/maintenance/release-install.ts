import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { TeamReleaseCandidatePayloadFile, TeamReleaseCompatibilityDeclaration } from './release-candidates.ts';
import type { TeamReleaseIdentity } from './release.ts';
import { assertNoSymlinkPath, assertPathInside, assertSafeRelativePath, safeMaintenanceId } from './paths.ts';
import { verifyReleaseManifest } from './distribution.ts';

export interface MaterializedTeamRelease {
  release: TeamReleaseIdentity;
  releaseRoot: string;
  compatibility: TeamReleaseCompatibilityDeclaration;
  alreadyMaterialized: boolean;
}

/** Revalidate and materialize only the managed candidate. Never copy a live data/config directory. */
export async function materializeTeamReleaseCandidate(options: {
  deploymentRoot: string;
  release: TeamReleaseIdentity;
  files: TeamReleaseCandidatePayloadFile[];
  compatibility: TeamReleaseCompatibilityDeclaration;
  manifestContent: Buffer;
  allowFixtureForTests?: boolean;
}): Promise<MaterializedTeamRelease> {
  safeMaintenanceId(options.release.releaseId, 'releaseId');
  const releasesRoot = path.join(options.deploymentRoot, 'releases');
  const destination = assertPathInside(releasesRoot, path.join(releasesRoot, options.release.releaseId));
  const staging = assertPathInside(releasesRoot, path.join(releasesRoot, `.install-${options.release.releaseId}-${process.pid}`));
  assertNoSymlinkPath(options.deploymentRoot);
  if (fs.existsSync(destination)) {
    const manifest = verifyReleaseManifest(destination, { allowFixture: options.allowFixtureForTests === true });
    if (manifest.releaseId !== options.release.releaseId) throw new Error('不可变发布目录身份与候选不符');
    const { sha256File } = await import('./paths.ts');
    if (await sha256File(path.join(destination, 'release-manifest.json')) !== options.release.packageSha256) {
      throw new Error('不可变发布目录清单与候选不符，拒绝覆盖');
    }
    return { release: options.release, releaseRoot: destination, compatibility: options.compatibility, alreadyMaterialized: true };
  }
  if (fs.existsSync(staging)) throw new Error('发布安装暂存目录已存在，需核查，拒绝覆盖');
  await fsPromises.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of options.files) {
      const relative = assertSafeRelativePath(file.path);
      const target = assertPathInside(staging, path.join(staging, ...relative.split('/')));
      await fsPromises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsPromises.writeFile(target, file.readContent(), { flag: 'wx', mode: 0o600 });
    }
    await fsPromises.writeFile(path.join(staging, 'release-manifest.json'), options.manifestContent, { flag: 'wx', mode: 0o600 });
    const manifest = verifyReleaseManifest(staging, { allowFixture: options.allowFixtureForTests === true });
    const { sha256File } = await import('./paths.ts');
    if (manifest.releaseId !== options.release.releaseId
      || await sha256File(path.join(staging, 'release-manifest.json')) !== options.release.packageSha256
      || JSON.stringify(manifest.compatibility) !== JSON.stringify(options.compatibility)) {
      throw new Error('物化发布身份、清单或兼容性发生变化');
    }
    for (const relative of ['runtimes/node/node.exe', 'tools/caddy/caddy.exe', 'tools/winsw/WinSW.exe']) {
      const target = path.join(staging, ...relative.split('/'));
      await fsPromises.chmod(target, 0o700);
    }
    await fsPromises.rename(staging, destination);
    return { release: options.release, releaseRoot: destination, compatibility: options.compatibility, alreadyMaterialized: false };
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true });
  }
}
