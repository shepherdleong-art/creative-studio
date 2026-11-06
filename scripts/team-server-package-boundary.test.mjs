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
  assert.deepEqual(topLevel, ['START-HERE.md', 'app', 'deployment.example.json', 'release-manifest.json', 'runtime', 'runtimes', 'service', 'tools'].sort());
  for (const required of [
    'START-HERE.md',
    'deployment.example.json',
    'app/runtime/team-server-entry.cjs',
    'app/runtime/start-litellm-proxy.py',
    'app/scripts/team-server/init-admin.mjs',
    'app/scripts/team-server/recover-admin.mjs',
    'app/scripts/team-server/verify-provider-budgets.mjs',
    'app/scripts/team-server/maintenance.mjs',
    'app/scripts/team-server/distribution.mjs',
    'app/scripts/team-server/generate-config.mjs',
    'app/scripts/team-server/service-control.mjs',
    'app/scripts/team-server/configure-pools.mjs',
    'app/scripts/team-server/publish-client-update.mjs',
    'app/scripts/runtime/process-tree.mjs',
    'app/lib/team-service/maintenance/backup.ts',
    'app/lib/team-service/maintenance/restore.ts',
    'app/lib/team-service/maintenance/release.ts',
    'app/lib/team-service/maintenance/jobs.ts',
    'app/lib/team-service/maintenance/worker.ts',
    'app/lib/team-service/maintenance/catalog.ts',
    'runtime/process-tree.mjs',
    'runtimes/node/node.exe',
    'tools/caddy/caddy.exe',
    'tools/winsw/WinSW.exe',
    'service/generate-config.mjs',
    'service/service-control.mjs',
    'service/configure-pools.mjs',
    'service/publish-client-update.mjs',
    'service/install.ps1',
    'service/stop.ps1',
    'service/probe-team-server.mjs',
    'service/backup.ps1',
    'service/restore.ps1',
    'service/release.ps1',
    'service/schedule-backup.ps1',
    'service/admin-cli.ps1',
    'service/distribution-lock.json',
  ]) assert.ok(fs.existsSync(path.join(output, ...required.split('/'))), required);
  const startHere = fs.readFileSync(path.join(output, 'START-HERE.md'), 'utf8');
  assert.match(startHere, /runtimes\\node\\node\.exe/);
  assert.match(startHere, /init-admin/);
  assert.match(startHere, /start-client\.cmd/);
  assert.match(startHere, /preflight\.ps1/);
  assert.match(startHere, /schedule-backup\.ps1/);
  const example = JSON.parse(fs.readFileSync(path.join(output, 'deployment.example.json'), 'utf8'));
  assert.equal(example.schemaVersion, 1);
  assert.match(example.releaseId, /^replace-with-/);
  assert.equal(JSON.stringify(example).includes('PRIVATE KEY'), false);
  for (const name of ['install.ps1', 'preflight.ps1', 'schedule-backup.ps1', 'admin-cli.ps1']) {
    const bytes = fs.readFileSync(path.join(output, 'service', name));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 必须保留 UTF-8 BOM`);
  }
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

test('standalone 已含 lib 时用受控源码目录替换而不重复合并', (t) => {
  const context = fixture(t);
  const stale = path.join(context.standalone, 'lib', 'batch-production', 'stale.ts');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '// traced stale copy\n');
  const output = path.join(context.directory, 'release');
  const result = build(context, output);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(output, 'app', 'lib', 'batch-production', 'stale.ts')), false);
  assert.ok(fs.existsSync(path.join(output, 'app', 'lib', 'team-service', 'maintenance', 'backup.ts')));
});

test('PEM 示例字符串不误报，完整私钥正文仍 fail closed', (t) => {
  const examples = fixture(t);
  const source = path.join(examples.standalone, 'python', 'example.py');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    '_SK_START = b"-----BEGIN OPENSSH PRIVATE KEY-----"',
    'placeholder = "-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----"',
    'documentation = "...-----BEGIN PRIVATE KEY-----... in PEM format"',
  ].join('\n'));
  const exampleResult = build(examples, path.join(examples.directory, 'release'));
  assert.equal(exampleResult.status, 0, exampleResult.stdout + exampleResult.stderr);

  const sensitive = fixture(t);
  const pem = path.join(sensitive.standalone, 'nested', 'private.pem');
  fs.mkdirSync(path.dirname(pem), { recursive: true });
  fs.writeFileSync(pem, `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(32)}\n-----END PRIVATE KEY-----`);
  const sensitiveResult = build(sensitive, path.join(sensitive.directory, 'release'));
  assert.notEqual(sensitiveResult.status, 0);
  assert.equal(fs.existsSync(path.join(sensitive.directory, 'release')), false);
});

test('嵌套环境文件、私钥、数据库和目录链接均在发布前 fail closed', (t) => {
  for (const [relative, content] of [
    ['app/nested/.env.local', 'API_KEY=do-not-package'],
    ['app/nested/private.pem', `-----BEGIN PRIVATE KEY-----\n${'QUJD'.repeat(32)}\n-----END PRIVATE KEY-----`],
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
