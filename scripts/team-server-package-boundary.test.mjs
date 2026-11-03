import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(root, 'scripts', 'build-team-server.mjs');
const controlledLock = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'team-server', 'distribution-lock.json'), 'utf8'));
const forbidden = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const standalone = path.join(directory, 'standalone');
  for (const [relative, content] of Object.entries({
    'server.js': 'require("./runtime/team-server-entry.cjs");\n',
    'runtime/server-entry.js': '// local entry\n',
    'runtime/team-server-entry.cjs': '// fixed loopback entry\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'fixture native',
    'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll': 'fixture vips',
    'node_modules/ffmpeg-static/ffmpeg.exe': 'fixture ffmpeg',
    'node_modules/@ffprobe-installer/win32-x64/ffprobe.exe': 'fixture ffprobe',
    'packaging/fonts/default.ttf': 'fixture font',
  })) {
    const target = path.join(standalone, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const nodeRuntime = path.join(directory, 'node');
  fs.mkdirSync(nodeRuntime);
  fs.writeFileSync(path.join(nodeRuntime, 'node.exe'), 'fixture node');
  const npmDocs = path.join(nodeRuntime, 'node_modules', 'npm', 'docs');
  fs.mkdirSync(npmDocs, { recursive: true });
  fs.writeFileSync(path.join(npmDocs, 'private-key-example.md'), '-----BEGIN PRIVATE KEY-----\ndocumentation only\n-----END PRIVATE KEY-----');
  const caddy = path.join(directory, 'caddy.exe');
  const winsw = path.join(directory, 'WinSW-x64.exe');
  fs.writeFileSync(caddy, 'fixture caddy');
  fs.writeFileSync(winsw, 'fixture winsw');
  const lock = structuredClone(controlledLock);
  lock.fixture = true;
  lock.media = [];
  lock.node.binarySha256 = sha256(fs.readFileSync(path.join(nodeRuntime, 'node.exe')));
  lock.caddy.binarySha256 = sha256(fs.readFileSync(caddy));
  lock.winsw.sha256 = sha256(fs.readFileSync(winsw));
  const lockPath = path.join(directory, 'fixture-lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  return { directory, standalone, nodeRuntime, caddy, winsw, lockPath };
}

function build(context, output, extra = []) {
  return spawnSync(process.execPath, [
    buildScript,
    '--output', output,
    '--release-id', 'test-release',
    '--standalone', context.standalone,
    '--node-runtime', context.nodeRuntime,
    '--caddy-exe', context.caddy,
    '--winsw-exe', context.winsw,
    '--lock', context.lockPath,
    '--without-litellm', '--skip-build', '--fixture',
    ...extra,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
}

test('server 独立白名单装配、受控 manifest 与精确敏感边界', (t) => {
  const context = fixture(t);
  const output = path.join(context.directory, 'release');
  const result = build(context, output);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const topLevel = fs.readdirSync(output).sort();
  assert.deepEqual(topLevel, ['app', 'release-manifest.json', 'runtime', 'runtimes', 'service', 'tools'].sort());
  for (const required of [
    'app/runtime/team-server-entry.cjs',
    'app/runtime/start-litellm-proxy.py',
    'app/scripts/team-server/init-admin.mjs',
    'app/scripts/team-server/recover-admin.mjs',
    'app/scripts/team-server/verify-provider-budgets.mjs',
    'runtime/process-tree.mjs',
    'runtimes/node/node.exe',
    'tools/caddy/caddy.exe',
    'tools/winsw/WinSW.exe',
    'service/generate-config.mjs',
    'service/service-control.mjs',
    'service/install.ps1',
    'service/stop.ps1',
    'service/probe-team-server.mjs',
    'service/distribution-lock.json',
  ]) assert.ok(fs.existsSync(path.join(output, ...required.split('/'))), required);
  for (const name of forbidden.consumers.serverReleaseGuard.forbidden) {
    assert.equal(fs.existsSync(path.join(output, name)), false, `server 包含禁入 ${name}`);
  }
  const bytes = fs.readFileSync(path.join(output, 'release-manifest.json'));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(fs.existsSync(path.join(output, 'runtimes', 'node', 'node_modules')), false, 'server 只携带锁定 Node 可执行文件与许可证，不夹带 npm 开发工具');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.mode, 'windows-team-server-v1');
  assert.equal(manifest.fixture, true);
  assert.equal(manifest.releaseId, 'test-release');
  assert.ok(manifest.files.length > 10);
  for (const entry of manifest.files) {
    assert.ok(!path.isAbsolute(entry.path) && !entry.path.includes('..'));
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    const content = fs.readFileSync(path.join(output, ...entry.path.split('/')));
    assert.equal(sha256(content), entry.sha256, entry.path);
    assert.equal(content.length, entry.size, entry.path);
  }
  assert.doesNotMatch(JSON.stringify(manifest), /[A-Za-z]:\\|12089/);
  const second = build(context, output);
  assert.notEqual(second.status, 0, '不得覆盖既有 release');
});

test('嵌套环境文件、私钥、数据库和目录链接均在发布前 fail closed', (t) => {
  for (const [relative, content] of [
    ['app/nested/.env.local', 'API_KEY=do-not-package'],
    ['app/nested/private.pem', '-----BEGIN PRIVATE KEY-----\ninvalid-fixture\n-----END PRIVATE KEY-----'],
    ['app/data/workbench.db', 'not-a-real-database'],
  ]) {
    const context = fixture(t);
    const target = path.join(context.standalone, ...relative.slice(4).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const output = path.join(context.directory, 'release');
    const result = build(context, output);
    assert.notEqual(result.status, 0, relative);
    assert.equal(fs.existsSync(output), false, `${relative} 不得留下发布目录`);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-package|invalid-fixture/);
  }
});

test('package 脚本与轻客户端禁入继续使用共享 JSON，旧 portable 断言保留', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts['build:team-server'] ?? '', /build-team-server\.mjs/);
  assert.match(packageJson.scripts['build:team-client'] ?? '', /build-team-client\.mjs/);
  for (const entry of ['data', 'storage', 'outputs', 'docs', 'scripts', '.git', '.env', '.env.*', 'config.yaml', '.venv-litellm', 'python-runtime']) {
    assert.ok(forbidden.core.includes(entry), `旧 core 禁入缺失 ${entry}`);
  }
  for (const name of ['.next', 'node_modules', 'app', 'components', 'lib', 'python-runtime']) {
    assert.ok(forbidden.consumers.teamClientWhitelistGuard.forbidden.includes(name), `轻客户端禁入缺失 ${name}`);
  }
});
