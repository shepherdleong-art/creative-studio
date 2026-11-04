import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const defaultRoot = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = path.resolve(rootFlag >= 0 ? args[rootFlag + 1] : defaultRoot);
const dryRun = args.includes('--dry-run');
const fail = (message) => { console.error(message); process.exit(2); };

let pointer;
let config;
try {
  pointer = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
  config = JSON.parse(fs.readFileSync(path.join(root, 'client-config.json'), 'utf8'));
  const origin = new URL(config.serverOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.serverOrigin) throw new Error('invalid origin');
  if (config.connectionMode !== undefined && !['direct', 'system'].includes(config.connectionMode)) throw new Error('invalid connection mode');
  const expectedDirectory = path.join('versions', pointer.releaseId);
  if (pointer.schemaVersion !== 1 || pointer.directory !== expectedDirectory
    || path.resolve(root, pointer.directory) !== path.join(root, 'versions', pointer.releaseId)) {
    throw new Error('invalid pointer');
  }
  const { verifyUpdateManifest } = require(path.join(root, 'helper', 'update-package.js'));
  verifyUpdateManifest(pointer.manifest, fs.readFileSync(path.join(root, 'update-public-key.pem'), 'utf8'), {
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    trustedOrigins: [origin.origin],
  });
  if (pointer.manifest.releaseId !== pointer.releaseId) throw new Error('release mismatch');
  const journalPath = path.join(root, 'updates', `${pointer.releaseId}.json`);
  if (fs.existsSync(journalPath)) {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (journal.committed !== true) throw new Error('update is not health-committed; use the controlled repair flow');
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, pointer.directory, 'release.json'), 'utf8'));
  if (metadata.releaseId !== pointer.releaseId || metadata.version !== pointer.manifest.version) {
    throw new Error('package metadata mismatch');
  }
} catch (error) {
  fail(`轻客户端当前版本验签失败：${error instanceof Error ? error.message : String(error)}`);
}

const versionRoot = path.join(root, pointer.directory);
const executable = process.platform === 'win32'
  ? path.join(versionRoot, 'electron', 'electron.exe')
  : path.join(versionRoot, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron');
const launchArguments = [...(config.connectionMode === 'direct' ? ['--no-proxy-server'] : []), versionRoot];
if (dryRun) {
  process.stdout.write(`${JSON.stringify({ releaseId: pointer.releaseId, versionRoot, executable, launchArguments })}\n`);
} else {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, {
    CREATIVE_STUDIO_CLIENT_MODE: 'remote',
    CREATIVE_STUDIO_SERVER_ORIGIN: config.serverOrigin,
    CREATIVE_STUDIO_CLIENT_INSTALL_ROOT: root,
    CREATIVE_STUDIO_CLIENT_STATE_ROOT: path.join(root, 'client-state'),
    CREATIVE_STUDIO_CLIENT_RELEASE_ID: pointer.releaseId,
  });
  const child = spawn(executable, launchArguments, { env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => fail(`轻客户端启动失败：${error.message}`));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
