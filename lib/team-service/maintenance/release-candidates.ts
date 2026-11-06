import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { TeamReleaseIdentity } from './release.ts';
import { assertNoSymlinkPath, assertPathInside, sha256File, writeJsonAtomic } from './paths.ts';
import { extractServerZipSafely } from './safe-zip.ts';
import { assertServerReleaseCompatibility, verifyStagedReleaseManifest, type ServerReleaseManifest } from './distribution.ts';

const sha256Bytes = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const TEAM_RELEASE_CANDIDATE_SCHEMA_VERSION = 1;
export const TEAM_RELEASE_ARCHIVE_LIMIT = 8 * 1024 ** 3;
const MIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface TeamReleaseCompatibilityDeclaration {
  minAppVersion: string;
  maxAppVersion: string;
  dataSchemaMin: number;
  dataSchemaMax: number;
}
export interface TeamReleaseCurrentVersion {
  appVersion: string;
  dataSchemaVersion: number;
}
export interface TeamReleaseChecks {
  manifestComplete: boolean;
  contentHashes: boolean;
  trustedDistribution: boolean;
  runtimeLocks: boolean;
  compatibility: boolean;
  zipSafety: boolean;
  runnablePayload: boolean;
}
export interface TeamReleaseCandidate {
  schemaVersion: 1;
  candidateId: string;
  status: 'ready' | 'rejected';
  requestedBy: string;
  originalName: string;
  archiveSha256: string;
  archiveBytes: number;
  createdAt: string;
  updatedAt: string;
  duplicate?: boolean;
  release: TeamReleaseIdentity;
  current: TeamReleaseCurrentVersion;
  target: { appVersion: string; dataSchemaVersion: number; sourceCommit: string };
  compatibility: { compatible: boolean; message: string; declaration: TeamReleaseCompatibilityDeclaration };
  checks: TeamReleaseChecks;
  failure?: { code: string; message: string };
}
interface CandidateState {
  candidate: TeamReleaseCandidate;
  compatibility: TeamReleaseCompatibilityDeclaration;
  manifest: DistributionManifest;
}
export interface TeamReleaseCandidatePayloadFile {
  path: string;
  size: number;
  sha256: string;
  readContent: () => Buffer;
}
type DistributionManifest = ServerReleaseManifest;
function neutralManifest(payload: string, supplied?: DistributionManifest): DistributionManifest {
  let manifest: DistributionManifest;
  if (supplied) manifest = supplied;
  else {
    const manifestFile = path.join(payload, 'release-manifest.json.upload');
    if (!fs.lstatSync(manifestFile).isFile()) throw new Error('发布包缺少完整发布清单');
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as DistributionManifest;
  }
  assertServerReleaseCompatibility(manifest.compatibility);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('发布清单没有文件证据');
  const read = (relative: string): Buffer => {
    const target = path.join(payload, ...relative.split('/')) + '.upload';
    if (!fs.existsSync(target) || !fs.lstatSync(target).isFile()) throw new Error(`发布文件缺失：${relative}`);
    return fs.readFileSync(target);
  };
  const actualPaths: string[] = [];
  const pending = [payload];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('候选暂存含链接或特殊文件');
      if (entry.isDirectory()) pending.push(absolute);
      else {
        if (!entry.name.endsWith('.upload')) throw new Error('候选暂存包含未登记或非中性文件');
        actualPaths.push(path.relative(payload, absolute).split(path.sep).join('/').slice(0, -'.upload'.length));
      }
    }
  }
  return verifyStagedReleaseManifest(manifest, read, actualPaths.filter((relative) => relative !== 'release-manifest.json'));
}
function neutralVerifier(root: string, options: { allowFixture: boolean }, manifest?: DistributionManifest): DistributionManifest {
  const checked = neutralManifest(root, manifest);
  if (checked.fixture === true && !options.allowFixture) throw new Error('测试包不能用于服务器升级');
  return checked;
}
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function compatible(current: TeamReleaseCurrentVersion, declaration: TeamReleaseCompatibilityDeclaration): boolean {
  if (!MIN_SEMVER.test(current.appVersion) || !Number.isSafeInteger(current.dataSchemaVersion)) return false;
  return compareVersions(current.appVersion, declaration.minAppVersion) >= 0
    && compareVersions(current.appVersion, declaration.maxAppVersion) <= 0
    && current.dataSchemaVersion >= declaration.dataSchemaMin
    && current.dataSchemaVersion <= declaration.dataSchemaMax;
}
function validateCurrent(current: TeamReleaseCurrentVersion): void {
  if (!MIN_SEMVER.test(current.appVersion) || !Number.isSafeInteger(current.dataSchemaVersion)
    || current.dataSchemaVersion < 1) throw new Error('当前应用／数据版本无法验证，拒绝准备升级');
}
function candidatePath(root: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('candidateId 无效');
  return assertPathInside(root, path.join(root, id, 'candidate.json'));
}
async function readState(root: string, id: string): Promise<CandidateState> {
  const state = JSON.parse(await fsPromises.readFile(candidatePath(root, id), 'utf8')) as CandidateState;
  if (state.candidate.schemaVersion !== TEAM_RELEASE_CANDIDATE_SCHEMA_VERSION
    || state.candidate.candidateId !== id || state.candidate.archiveSha256 !== id) throw new Error('候选身份与记录不符');
  assertServerReleaseCompatibility(state.compatibility);
  return state;
}
async function validateCandidate(root: string, state: CandidateState, current: TeamReleaseCurrentVersion,
  allowFixtureForTests = false): Promise<TeamReleaseCandidate> {
  if (state.candidate.status === 'rejected') return {
    ...state.candidate, current: { ...current }, compatibility: {
      ...state.candidate.compatibility,
      compatible: false, message: '候选未通过兼容性检查，不能用于升级。',
    },
    checks: { ...state.candidate.checks, compatibility: false },
  };
  const directory = path.dirname(candidatePath(root, state.candidate.candidateId));
  assertNoSymlinkPath(directory);
  const payloadDirectory = path.join(directory, 'payload');
  const held = path.join(directory, 'release-manifest.json');
  if (fs.existsSync(path.join(payloadDirectory, 'release-manifest.json.upload')) || !fs.lstatSync(held).isFile()) {
    throw new Error('候选清单持有状态无效，拒绝绕过复核执行');
  }
  if (createHash('sha256').update(fs.readFileSync(held)).digest('hex') !== state.candidate.release.packageSha256) {
    throw new Error('候选发布清单哈希被替换');
  }
  const savedManifest = JSON.parse(await fsPromises.readFile(held, 'utf8')) as DistributionManifest;
  const manifest = neutralVerifier(payloadDirectory, { allowFixture: allowFixtureForTests }, savedManifest);
  if (manifest.fixture === true && !allowFixtureForTests) throw new Error('测试包不能用于服务器升级');
  if (manifest.releaseId !== state.candidate.release.releaseId
    || await sha256File(held) !== state.candidate.release.packageSha256) {
    throw new Error('候选发布身份或内容哈希被替换');
  }
  if (await sha256File(path.join(directory, 'package.zip')) !== state.candidate.archiveSha256) {
    throw new Error('候选原始包内容哈希被替换');
  }
  const declaration = manifest.compatibility;
  if (JSON.stringify(declaration) !== JSON.stringify(state.compatibility)) throw new Error('候选兼容声明被替换');
  const ok = compatible(current, declaration);
  return {
    ...state.candidate,
    current: { ...current },
    status: ok ? 'ready' : 'rejected',
    compatibility: {
      compatible: ok, declaration,
      message: ok ? `支持从 ${current.appVersion}／数据结构 ${current.dataSchemaVersion} 准备；执行升级前仍需复核。`
        : '当前应用或数据结构不在目标发布声明的兼容范围内。',
    },
    checks: { ...state.candidate.checks, compatibility: ok },
    failure: ok ? undefined : { code: 'incompatible_release', message: '当前版本与目标发布包不兼容。' },
  };
}
export async function prepareTeamReleaseCandidate(options: {
  candidateRoot: string;
  archivePath: string;
  originalName: string;
  requestedBy: string;
  current: TeamReleaseCurrentVersion;
  allowFixtureForTests?: boolean;
  now?: () => Date;
  availableBytes?: () => Promise<number>;
}): Promise<TeamReleaseCandidate> {
  validateCurrent(options.current);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.requestedBy)) throw new Error('发起人身份无效');
  assertNoSymlinkPath(options.candidateRoot);
  await fsPromises.mkdir(options.candidateRoot, { recursive: true, mode: 0o700 });
  const stat = await fsPromises.lstat(options.archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > TEAM_RELEASE_ARCHIVE_LIMIT) {
    throw new Error('上传包必须是大小受限的普通 ZIP 文件');
  }
  const archiveSha256 = await sha256File(options.archivePath);
  const available = await (options.availableBytes?.() ?? fsPromises.statfs(options.candidateRoot).then((stats) => Number(stats.bavail) * Number(stats.bsize)));
  if (!Number.isSafeInteger(available) || available < stat.size * 2 + 64 * 1024 * 1024) {
    throw new Error('服务器可用空间不足，无法安全保存发布包与受管候选；请清理空间后重试');
  }
  const transferDirectory = await fsPromises.mkdtemp(path.join(options.candidateRoot, '.upload-'));
  const temporaryArchive = path.join(transferDirectory, 'package.zip');
  const work = path.join(transferDirectory, 'work');
  const payload = path.join(work, 'payload');
  try {
    await fsPromises.copyFile(options.archivePath, temporaryArchive, fs.constants.COPYFILE_EXCL);
    if (await sha256File(temporaryArchive) !== archiveSha256) throw new Error('上传内容在读取期间发生变化');
    extractServerZipSafely(temporaryArchive, payload, { neutralStaging: true });
    const manifest = neutralVerifier(payload, { allowFixture: options.allowFixtureForTests === true });
    assertServerReleaseCompatibility(manifest.compatibility);
    const packageSha256 = await sha256File(path.join(payload, 'release-manifest.json.upload'));
    const candidateId = archiveSha256;
    const file = candidatePath(options.candidateRoot, candidateId);
    if (fs.existsSync(file)) {
      const existing = await readState(options.candidateRoot, candidateId);
      if (existing.candidate.release.packageSha256 !== packageSha256
        || existing.candidate.release.releaseId !== manifest.releaseId) throw new Error('候选身份冲突');
      return { ...(await validateCandidate(options.candidateRoot, existing, options.current, options.allowFixtureForTests)), duplicate: true };
    }
    const declaration = { ...manifest.compatibility };
    const ok = compatible(options.current, declaration);
    const now = options.now?.() ?? new Date();
    const candidate: TeamReleaseCandidate = {
      schemaVersion: TEAM_RELEASE_CANDIDATE_SCHEMA_VERSION, candidateId,
      status: ok ? 'ready' : 'rejected', requestedBy: options.requestedBy,
      originalName: path.basename(options.originalName).slice(0, 200) || 'release.zip',
      archiveSha256, archiveBytes: stat.size, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      release: { releaseId: manifest.releaseId, packageSha256 },
      current: { ...options.current },
      target: { appVersion: manifest.appVersion, dataSchemaVersion: declaration.dataSchemaMax, sourceCommit: manifest.sourceCommit },
      compatibility: { compatible: ok, declaration, message: ok ? '兼容范围已核验；执行升级前仍需复核。' : '当前版本与目标发布包不兼容。' },
      checks: { manifestComplete: true, contentHashes: true, trustedDistribution: true, runtimeLocks: true,
        compatibility: ok, zipSafety: true, runnablePayload: true },
      ...(ok ? {} : { failure: { code: 'incompatible_release', message: '当前版本与目标发布包不兼容。' } }),
    };
    await fsPromises.copyFile(path.join(payload, 'release-manifest.json.upload'), path.join(work, 'release-manifest.json'), fs.constants.COPYFILE_EXCL);
    await fsPromises.rename(temporaryArchive, path.join(work, 'package.zip'));
    await fsPromises.rename(path.join(payload, 'release-manifest.json.upload'), path.join(work, 'release-manifest.json'));
    await fsPromises.chmod(path.join(work, 'release-manifest.json'), 0o600);
    await writeJsonAtomic(path.join(work, 'candidate.json'), { candidate, compatibility: declaration, manifest } satisfies CandidateState);
    try {
      await fsPromises.rename(work, path.dirname(file));
      return candidate;
    } catch (error) {
      if (!fs.existsSync(file)) throw error;
      const existing = await readState(options.candidateRoot, candidateId);
      if (existing.candidate.release.packageSha256 !== packageSha256
        || existing.candidate.release.releaseId !== manifest.releaseId) throw new Error('候选身份冲突');
      return { ...(await validateCandidate(options.candidateRoot, existing, options.current, options.allowFixtureForTests)), duplicate: true };
    }
  } finally {
    await fsPromises.rm(transferDirectory, { recursive: true, force: true });
  }
}
export async function readTeamReleaseCandidate(candidateRoot: string, candidateId: string,
  current: TeamReleaseCurrentVersion, allowFixtureForTests = false): Promise<TeamReleaseCandidate> {
  validateCurrent(current);
  return validateCandidate(candidateRoot, await readState(candidateRoot, candidateId), current, allowFixtureForTests);
}
export async function listTeamReleaseCandidates(candidateRoot: string,
  current: TeamReleaseCurrentVersion, allowFixtureForTests = false): Promise<TeamReleaseCandidate[]> {
  validateCurrent(current);
  if (!fs.existsSync(candidateRoot)) return [];
  const result: TeamReleaseCandidate[] = [];
  for (const entry of await fsPromises.readdir(candidateRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    result.push(await readTeamReleaseCandidate(candidateRoot, entry.name, current, allowFixtureForTests));
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Ticket 12 consumption seam. It never changes a release pointer or starts/stops a service. */
export async function getTeamReleaseCandidateForExecution(options: {
  candidateRoot: string; candidateId: string; current: TeamReleaseCurrentVersion; allowFixtureForTests?: boolean;
}): Promise<{ storageFormat: 'neutral-v1'; payloadDirectory: string; manifest: DistributionManifest;
  files: TeamReleaseCandidatePayloadFile[]; release: TeamReleaseIdentity; candidate: TeamReleaseCandidate }> {
  const { candidateRoot, candidateId, current, allowFixtureForTests } = options;
  validateCurrent(current);
  const file = candidatePath(candidateRoot, candidateId);
  assertNoSymlinkPath(path.dirname(file));
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as CandidateState;
  if (state.candidate.candidateId !== candidateId || state.candidate.archiveSha256 !== candidateId
    || state.candidate.status !== 'ready' || !compatible(current, state.compatibility)) {
    throw new Error('候选未通过校验，不能用于升级');
  }
  const directory = path.dirname(file);
  const payloadDirectory = path.join(directory, 'payload');
  const held = path.join(directory, 'release-manifest.json');
  if (fs.existsSync(path.join(payloadDirectory, 'release-manifest.json.upload')) || !fs.lstatSync(held).isFile()) {
    throw new Error('候选清单持有状态无效，拒绝绕过复核执行');
  }
  const savedManifest = JSON.parse(fs.readFileSync(held, 'utf8')) as DistributionManifest;
  const archiveDirectory = path.join(directory, '.execution-review');
  extractServerZipSafely(path.join(directory, 'package.zip'), archiveDirectory, { neutralStaging: true });
  try {
    neutralVerifier(archiveDirectory, { allowFixture: allowFixtureForTests === true }, savedManifest);
  } finally {
    fs.rmSync(archiveDirectory, { recursive: true, force: true });
  }
  const manifest = neutralVerifier(payloadDirectory, { allowFixture: allowFixtureForTests === true }, savedManifest);
  if (manifest.fixture === true && !allowFixtureForTests) throw new Error('测试包不能用于服务器升级');
  if (sha256Bytes(fs.readFileSync(held))
    !== state.candidate.release.packageSha256) throw new Error('候选发布清单哈希被替换');
  if (manifest.releaseId !== state.candidate.release.releaseId
    || JSON.stringify(manifest.compatibility) !== JSON.stringify(state.compatibility)
    || !compatible(current, manifest.compatibility)) throw new Error('候选身份或兼容性已改变，拒绝消费');
  if (sha256Bytes(fs.readFileSync(path.join(directory, 'package.zip')))
    !== candidateId) throw new Error('候选原始包哈希被替换');
  const files = manifest.files.map((entry) => ({
    path: entry.path, size: entry.size, sha256: entry.sha256,
    readContent: () => {
      const content = fs.readFileSync(path.join(payloadDirectory, ...entry.path.split('/')) + '.upload');
      if (content.length !== entry.size || sha256Bytes(content) !== entry.sha256) throw new Error(`候选内容已变化：${entry.path}`);
      return content;
    },
  }));
  return { storageFormat: 'neutral-v1', payloadDirectory, manifest, files,
    release: { ...state.candidate.release }, candidate: { ...state.candidate, status: 'ready' } };
}
