import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-client-package-'));
const output = path.join(root, 'installed');
const electronDist = path.join(root, 'electron');
fs.mkdirSync(electronDist, { recursive: true });
fs.writeFileSync(path.join(electronDist, 'electron.exe'), 'fixture electron');
fs.writeFileSync(path.join(electronDist, 'resources.pak'), 'fixture resources');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.match(packageJson.scripts['build:team-client'] ?? '', /build-team-client\.mjs/);

try {
  const built = spawnSync(process.execPath, [
    'scripts/build-team-client.mjs',
    '--output', output,
    '--release-id', 'test-release',
    '--electron-dist', electronDist,
    '--skip-build',
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      CREATIVE_STUDIO_SERVER_ORIGIN: 'https://studio.example.test',
      CREATIVE_STUDIO_CLIENT_UPDATE_BASE_URL: 'https://studio.example.test/client-updates',
      CREATIVE_STUDIO_CLIENT_SIGNING_KEY: privatePem,
      CREATIVE_STUDIO_CLIENT_PUBLIC_KEY: publicPem,
    },
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  for (const required of [
    'start-client.cmd', 'launcher.mjs', 'update-public-key.pem', 'current.json',
    'helper/update-helper.js', 'runtime/electron.exe',
    'versions/test-release/electron/electron.exe',
    'versions/test-release/package.json',
    'versions/test-release/dist-desktop/main.js',
    'versions/test-release/release.json',
    'updates/test-release.zip', 'updates/test-release.manifest.json',
  ]) assert.equal(fs.existsSync(path.join(output, required)), true, required);

  const forbiddenDirectories = new Set([
    '.next', 'node_modules', 'data', 'storage', 'outputs', 'docs', 'scripts',
    'python-runtime', '.venv-litellm', 'app', 'components', 'lib', '.git',
  ]);
  const forbiddenFiles = new Set(['ffmpeg.exe', 'ffprobe.exe', 'workbench.db', 'config.yaml', '.env', '.env.local']);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(forbiddenDirectories.has(entry.name), false, `轻客户端夹带目录 ${entry.name}`);
      assert.equal(forbiddenFiles.has(entry.name), false, `轻客户端夹带文件 ${entry.name}`);
      assert.equal(/private|secret|credential/i.test(entry.name), false, `轻客户端夹带敏感名称 ${entry.name}`);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && /\.(?:js|json|pem|cmd|mjs)$/i.test(entry.name)) {
        const content = fs.readFileSync(absolute, 'utf8');
        assert.equal(content.includes(privatePem), false, '私钥不得进入包');
        assert.doesNotMatch(content, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, '私钥不得进入文本负载');
      }
    }
  };
  walk(output);

  const signed = JSON.parse(fs.readFileSync(path.join(output, 'updates', 'test-release.manifest.json'), 'utf8'));
  const { verifyUpdateManifest } = await import('../dist-desktop/client/update-package.js');
  assert.equal(verifyUpdateManifest(signed, publicPem, {
    platform: 'win32', arch: 'x64', trustedOrigins: ['https://studio.example.test'],
  }).releaseId, 'test-release');

  const dryRun = spawnSync(process.execPath, [path.join(output, 'launcher.mjs'), '--root', output, '--dry-run'], { encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).releaseId, 'test-release');
  const pointerPath = path.join(output, 'current.json');
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  pointer.manifest.version = '9.9.9';
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));
  const tampered = spawnSync(process.execPath, [path.join(output, 'launcher.mjs'), '--root', output, '--dry-run'], { encoding: 'utf8' });
  assert.notEqual(tampered.status, 0, 'launcher 必须拒绝签名被篡改的当前指针');
  pointer.manifest = signed;
  fs.writeFileSync(pointerPath, JSON.stringify(pointer));
  fs.writeFileSync(path.join(output, 'updates', 'test-release.json'), '{"schemaVersion":1,"phase":"health_pending","committed":false}');
  const uncommitted = spawnSync(process.execPath, [path.join(output, 'launcher.mjs'), '--root', output, '--dry-run'], { encoding: 'utf8' });
  assert.notEqual(uncommitted.status, 0, '健康提交前的版本不得恢复业务运行');
  console.log('team client package boundary tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
