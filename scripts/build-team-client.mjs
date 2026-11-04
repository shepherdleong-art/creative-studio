import assert from 'node:assert/strict';
import { ZipArchive } from 'archiver';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertExactTopLevel, scanDistributionPayload } from './team-server/distribution.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
const output = path.resolve(option('output') ?? '');
if (!option('output')) throw new Error('--output 必须是新的轻客户端装配目录');
const releaseId = option('release-id') ?? JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(releaseId)) throw new Error('releaseId 无效');
const electronDist = path.resolve(option('electron-dist') ?? path.join(repoRoot, 'node_modules', 'electron', 'dist'));
const serverOrigin = new URL(process.env.CREATIVE_STUDIO_SERVER_ORIGIN ?? '');
const updateBase = new URL(process.env.CREATIVE_STUDIO_CLIENT_UPDATE_BASE_URL ?? '');
if (serverOrigin.protocol !== 'https:' || serverOrigin.origin !== process.env.CREATIVE_STUDIO_SERVER_ORIGIN
  || updateBase.protocol !== 'https:' || updateBase.origin !== serverOrigin.origin) {
  throw new Error('轻客户端服务与更新包必须使用明确的同源 HTTPS 地址');
}
if (!/^\/client-updates\/?$/.test(updateBase.pathname) || updateBase.search || updateBase.hash) {
  throw new Error('更新包地址必须落在服务端受控的 /client-updates/ 静态目录');
}
const privateKey = process.env.CREATIVE_STUDIO_CLIENT_SIGNING_KEY;
const publicKey = process.env.CREATIVE_STUDIO_CLIENT_PUBLIC_KEY;
if (!privateKey || !publicKey || !publicKey.includes('BEGIN PUBLIC KEY')) {
  throw new Error('发布需要受控私钥环境变量及对应验证公钥，未知密钥不得发布');
}
if (!args.includes('--skip-build')) {
  const built = spawnSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'desktop/tsconfig.json'], {
    cwd: repoRoot, stdio: 'inherit',
  });
  if (built.status !== 0) throw new Error('Electron 负载编译失败');
}
if (fs.existsSync(output)) throw new Error('目标已存在，拒绝覆盖');
const staging = path.join(path.dirname(output), `.team-client-staging-${process.pid}-${crypto.randomUUID()}`);
const versionRoot = path.join(staging, 'versions', releaseId);
const { signUpdateManifest, verifyUpdateManifest } = require(path.join(repoRoot, 'dist-desktop', 'client', 'update-package.js'));

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: false, errorOnExist: true });
}
function write(relative, content) {
  const target = path.join(staging, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
}
function zipDirectory(source, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const outputStream = fs.createWriteStream(destination, { flags: 'wx' });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    outputStream.on('close', resolve);
    outputStream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(outputStream);
    archive.directory(source, false);
    void archive.finalize();
  });
}

try {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  copy(path.join(repoRoot, 'dist-desktop'), path.join(versionRoot, 'dist-desktop'));
  copy(electronDist, path.join(versionRoot, 'electron'));
  copy(electronDist, path.join(staging, 'runtime'));
  copy(path.join(repoRoot, 'scripts', 'team-client', 'launcher.mjs'), path.join(staging, 'launcher.mjs'));
  copy(path.join(repoRoot, 'scripts', 'team-client', 'start-client.cmd'), path.join(staging, 'start-client.cmd'));
  for (const file of ['update-helper.js', 'update-coordinator.js', 'atomic-json.js', 'safe-zip.js', 'update-package.js']) {
    copy(path.join(repoRoot, 'dist-desktop', 'client', file), path.join(staging, 'helper', file));
  }
  write('update-public-key.pem', publicKey);
  write('client-config.json', `${JSON.stringify({ schemaVersion: 1, serverOrigin: serverOrigin.origin, connectionMode: args.includes('--direct-connection') ? 'direct' : 'system' }, null, 2)}\n`);
  write(path.join('versions', releaseId, 'package.json'), `${JSON.stringify({
    name: 'creative-studio-team-client', version: packageJson.version, private: true,
    main: 'dist-desktop/main.js', license: 'GPL-3.0-only',
  }, null, 2)}\n`);
  write(path.join('versions', releaseId, 'release.json'), `${JSON.stringify({ releaseId, version: packageJson.version }, null, 2)}\n`);
  write('client-state/state.json', '{"schemaVersion":1}\n');
  write('client-state/run/transfer-gate.json', '{"schemaVersion":1,"blocked":false}\n');
  fs.mkdirSync(path.join(staging, 'client-state', 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'client-state', 'downloads'), { recursive: true });

  const archive = path.join(staging, 'updates', `${releaseId}.zip`);
  await zipDirectory(versionRoot, archive);
  const bytes = fs.readFileSync(archive);
  const manifest = signUpdateManifest({
    schemaVersion: 1,
    releaseId,
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    version: packageJson.version,
    api: { min: 1, max: 1 },
    clientStateSchema: { min: 1, max: 1 },
    packageUrl: new URL(`${releaseId}.zip`, `${updateBase.href.replace(/\/?$/, '/')}`).href,
    entry: 'dist-desktop/main.js',
  }, privateKey);
  assert.equal(verifyUpdateManifest(manifest, publicKey, {
    platform: manifest.platform, arch: manifest.arch, trustedOrigins: [serverOrigin.origin],
  }).releaseId, releaseId, '签名私钥与验证公钥不匹配');
  write(path.join('updates', `${releaseId}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  write('current.json', `${JSON.stringify({
    schemaVersion: 1, releaseId, directory: path.join('versions', releaseId), manifest,
  }, null, 2)}\n`);

  assertExactTopLevel(staging, 'teamClientWhitelistGuard');
  const secretCandidates = [{ label: 'client-signing-key', value: privateKey }];
  scanDistributionPayload(staging, 'teamClient', secretCandidates);
  const forbiddenDirectories = new Set(['.next', 'node_modules', 'data', 'storage', 'outputs', 'docs', 'scripts', 'python-runtime', '.venv-litellm', 'app', 'components', 'lib', '.git']);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(forbiddenDirectories.has(entry.name), false, `轻客户端白名单外目录：${entry.name}`);
      assert.equal(/^(?:\.env|config\.yaml|workbench\.db|ffmpeg\.exe|ffprobe\.exe)/i.test(entry.name), false, `轻客户端禁入文件：${entry.name}`);
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
  };
  walk(staging);
  fs.renameSync(staging, output);
  process.stdout.write(`${JSON.stringify({ output, releaseId, manifest: path.join(output, 'updates', `${releaseId}.manifest.json`) })}\n`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
