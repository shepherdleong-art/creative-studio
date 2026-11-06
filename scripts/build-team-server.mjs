import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertExactTopLevel,
  scanDistributionPayload,
  sha256File,
  verifyReleaseManifest,
  writeReleaseManifest,
} from './team-server/distribution.mjs';
import { TEAM_SERVICE_MIGRATIONS } from '../lib/team-service/schema.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`缺少 --${name}`);
  return path.resolve(value);
}
function copy(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`缺少装配输入：${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}
function resolveInstalledPackage(packageDirectory, dependency) {
  let current = packageDirectory;
  while (true) {
    const candidate = path.join(current, 'node_modules', dependency);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`无法解析运行依赖：${dependency}`);
    current = parent;
  }
}
function copyRuntimePackageClosure(source, destination, ancestors = new Set()) {
  if (ancestors.has(source)) return;
  const nextAncestors = new Set(ancestors).add(source);
  fs.rmSync(destination, { recursive: true, force: true });
  copy(source, destination);
  const packageJson = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    const dependencySource = resolveInstalledPackage(source, dependency);
    copyRuntimePackageClosure(dependencySource, path.join(destination, 'node_modules', dependency), nextAncestors);
  }
}
function publishDirectory(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (fs.existsSync(destination)) throw new Error('目标已存在，拒绝覆盖');
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
function assertNoDirectoryLinks(target) {
  let current = path.resolve(target);
  while (true) {
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== current)) {
      throw new Error('发布路径不得包含目录链接');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

const output = requiredOption('output');
const releaseId = option('release-id') ?? JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) throw new Error('releaseId 无效');
if (fs.existsSync(output) || path.parse(output).root.toLowerCase() === output.toLowerCase()) throw new Error('目标已存在或为磁盘根，拒绝覆盖');
assertNoDirectoryLinks(path.dirname(output));
const fixture = args.includes('--fixture');
const lockPath = path.resolve(option('lock') ?? path.join(repoRoot, 'scripts', 'team-server', 'distribution-lock.json'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (fixture !== (lock.fixture === true)) throw new Error('fixture 锁与 --fixture 必须同时显式使用；正式构建不得绕过受控锁');
if (!args.includes('--skip-build')) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-production.mjs')], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Next standalone 构建失败');
}
const standalone = path.resolve(option('standalone') ?? path.join(repoRoot, '.next', 'standalone'));
const toolCache = path.resolve(option('tool-cache') ?? path.join(repoRoot, '.cache', 'team-server-tools'));
const nodeRuntime = path.resolve(option('node-runtime') ?? path.join(toolCache, 'node'));
const caddyExe = path.resolve(option('caddy-exe') ?? path.join(toolCache, 'caddy', 'caddy.exe'));
const winswExe = path.resolve(option('winsw-exe') ?? path.join(toolCache, 'winsw', 'WinSW-x64.exe'));
const pythonRuntime = path.resolve(option('python-runtime') ?? path.join(repoRoot, 'python-runtime'));
for (const [file, expected] of [
  [path.join(nodeRuntime, 'node.exe'), lock.node.binarySha256],
  [caddyExe, lock.caddy.binarySha256],
  [winswExe, lock.winsw.sha256],
]) {
  if (!fs.existsSync(file) || sha256File(file) !== expected) throw new Error('Node/Caddy/WinSW 与受控版本或 SHA-256 不符');
}
if (!args.includes('--without-litellm')) {
  const manifestPath = path.join(pythonRuntime, 'runtime-manifest.json');
  if (!fs.existsSync(path.join(pythonRuntime, 'python.exe')) || !fs.existsSync(manifestPath)) throw new Error('缺少已验收 Python/LiteLLM 运行时');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.pythonVersion !== lock.python.version || manifest.litellmVersion !== lock.python.litellmVersion
    || manifest.archiveSha256 !== lock.python.sha256) throw new Error('Python/LiteLLM 与受控锁不符');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const staging = path.join(path.dirname(output), `.team-server-staging-${process.pid}-${crypto.randomUUID()}`);
try {
  copy(standalone, path.join(staging, 'app'));
  if (!fixture) {
    copyRuntimePackageClosure(
      path.join(repoRoot, 'node_modules', 'exceljs'),
      path.join(staging, 'app', 'node_modules', 'exceljs'),
    );
  }
  copy(path.join(nodeRuntime, 'node.exe'), path.join(staging, 'runtimes', 'node', 'node.exe'));
  for (const licenseName of ['LICENSE', 'ThirdPartyNotices.txt']) {
    const licensePath = path.join(nodeRuntime, licenseName);
    if (fs.existsSync(licensePath)) copy(licensePath, path.join(staging, 'runtimes', 'node', licenseName));
  }
  if (!args.includes('--without-litellm')) copy(pythonRuntime, path.join(staging, 'runtimes', 'python'));
  fs.mkdirSync(path.join(staging, 'tools', 'caddy'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'tools', 'winsw'), { recursive: true });
  copy(caddyExe, path.join(staging, 'tools', 'caddy', 'caddy.exe'));
  copy(winswExe, path.join(staging, 'tools', 'winsw', 'WinSW.exe'));
  copy(path.join(repoRoot, 'scripts', 'team-server', 'package', 'START-HERE.md'), path.join(staging, 'START-HERE.md'));
  copy(path.join(repoRoot, 'scripts', 'team-server', 'package', 'deployment.example.json'), path.join(staging, 'deployment.example.json'));
  copy(path.join(repoRoot, 'scripts', 'start-litellm-proxy.py'), path.join(staging, 'app', 'runtime', 'start-litellm-proxy.py'));
  // Next 可能把部分 lib 追踪进 standalone；运维 CLI 需要完整且一致的源码副本。
  fs.rmSync(path.join(staging, 'app', 'lib'), { recursive: true, force: true });
  copy(path.join(repoRoot, 'lib'), path.join(staging, 'app', 'lib'));
  for (const name of [
    'init-admin.mjs', 'recover-admin.mjs', 'verify-provider-budgets.mjs', 'maintenance.mjs',
    'distribution.mjs', 'generate-config.mjs', 'service-control.mjs', 'configure-pools.mjs', 'publish-client-update.mjs',
  ]) {
    copy(path.join(repoRoot, 'scripts', 'team-server', name), path.join(staging, 'app', 'scripts', 'team-server', name));
  }
  copy(path.join(repoRoot, 'scripts', 'runtime', 'process-tree.mjs'), path.join(staging, 'app', 'scripts', 'runtime', 'process-tree.mjs'));
  copy(path.join(repoRoot, 'scripts', 'packaging', 'forbidden-paths.json'), path.join(staging, 'app', 'scripts', 'packaging', 'forbidden-paths.json'));
  copy(path.join(repoRoot, 'scripts', 'runtime', 'process-tree.mjs'), path.join(staging, 'runtime', 'process-tree.mjs'));
  copy(lockPath, path.join(staging, 'service', 'distribution-lock.json'));
  copy(path.join(repoRoot, 'scripts', 'packaging', 'forbidden-paths.json'), path.join(staging, 'service', 'packaging', 'forbidden-paths.json'));
  for (const name of [
    'distribution.mjs', 'generate-config.mjs', 'service-control.mjs', 'probe-team-server.mjs', 'configure-pools.mjs',
    'publish-client-update.mjs',
    'common.ps1', 'generate-config.ps1', 'install.ps1', 'status.ps1', 'stop.ps1', 'preflight.ps1',
    'backup.ps1', 'restore.ps1', 'release.ps1', 'schedule-backup.ps1', 'admin-cli.ps1',
  ]) copy(path.join(repoRoot, 'scripts', 'team-server', name), path.join(staging, 'service', name));
  // service/ is one level below the release root, unlike app/scripts/team-server/.
  // Keep its adapter pointed at the packaged implementation, never the source tree.
  fs.writeFileSync(path.join(staging, 'service', 'distribution.mjs'),
    "export * from '../app/scripts/team-server/distribution.mjs';\n", 'utf8');

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const sourceCommit = commit.status === 0 ? commit.stdout.trim() : 'unknown';
  const manifest = writeReleaseManifest(staging, {
    releaseId, appVersion: packageJson.version, sourceCommit, fixture,
    compatibility: {
      minAppVersion: packageJson.version, maxAppVersion: packageJson.version,
      dataSchemaMin: TEAM_SERVICE_MIGRATIONS.at(-1)?.version,
      dataSchemaMax: TEAM_SERVICE_MIGRATIONS.at(-1)?.version,
    },
  });
  assertExactTopLevel(staging, 'serverReleaseGuard');
  scanDistributionPayload(staging, 'server');
  verifyReleaseManifest(staging, { allowFixture: fixture });
  if (!fixture) {
    const probe = spawnSync(path.join(staging, 'runtimes', 'node', 'node.exe'), [
      path.join(staging, 'service', 'probe-team-server.mjs'), '--release', staging,
    ], { cwd: staging, stdio: 'inherit', windowsHide: true, timeout: 180_000 });
    if (probe.status !== 0) throw new Error('原生模块或媒体探针未通过，拒绝发布');
  }
  publishDirectory(staging, output);
  process.stdout.write(`${JSON.stringify({ output, releaseId, fixture, files: manifest.files.length, nativeProbe: fixture ? 'not_run_fixture' : 'passed' })}\n`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
