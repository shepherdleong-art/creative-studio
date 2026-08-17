import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appPath = path.resolve(process.argv[2] || 'dist/macos/产品素材工作台.app');
const dmgPath = path.resolve(process.argv[3] || 'dist/macos/产品素材工作台-0.3.0.dmg');
const payload = path.join(appPath, 'Contents', 'Resources', 'app');
const standalone = path.join(payload, '.next', 'standalone');
const runtimeNode = path.join(payload, 'runtime', 'bin', 'node');
const ffmpeg = path.join(standalone, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const ffprobe = path.join(standalone, 'node_modules', 'ffprobe-static', 'bin', 'darwin', 'arm64', 'ffprobe');

for (const required of [
  appPath,
  path.join(appPath, 'Contents', 'MacOS', 'CreativeStudio'),
  path.join(payload, 'package.json'),
  path.join(payload, 'dist-desktop', 'main.js'),
  path.join(standalone, 'server.js'),
  path.join(standalone, 'runtime', 'server-entry.js'),
  path.join(payload, '.next', 'static'),
  path.join(payload, 'public'),
  runtimeNode,
  ffmpeg,
  dmgPath,
]) {
  assert.ok(fs.existsSync(required), `missing installer payload path: ${required}`);
}

const payloadPackage = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'));
assert.equal(payloadPackage.main, 'dist-desktop/main.js', 'Electron payload must point at the compiled main entry');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

for (const binary of [path.join(appPath, 'Contents', 'MacOS', 'CreativeStudio'), runtimeNode, ffmpeg]) {
  assert.match(run('file', [binary]), /arm64/, `${binary} must be arm64`);
}
assert.match(run(runtimeNode, ['-p', 'process.version + " " + process.platform + " " + process.arch']), /^v22\..* darwin arm64/m);
run(runtimeNode, ['-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok')"], { cwd: standalone });
run(runtimeNode, ['-e', "require('sharp')({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer().then(()=>console.log('sharp ok'))"], { cwd: standalone });
assert.match(run(ffmpeg, ['-version']), /^ffmpeg version/m);
if (fs.existsSync(ffprobe)) {
  assert.match(run('file', [ffprobe]), /arm64/, 'packaged ffprobe must never be the mislabeled x86_64 binary');
  assert.match(run(ffprobe, ['-version']), /^ffprobe version/m);
}
run('codesign', ['--verify', '--deep', '--strict', appPath]);
run('hdiutil', ['verify', dmgPath]);

// Kept in sync with PRUNE_RELATIVE_PATHS in scripts/build-mac-installer.sh and
// the Windows installer's prune list. Both levels are checked because Next's
// output tracing can copy the project root into .next/standalone.
for (const forbidden of [
  'data', 'storage', 'outputs', 'docs', 'scripts', 'installer', 'desktop',
  '.git', '.claude', '.venv-litellm', 'python-runtime', 'config.yaml', 'litellm-config.yaml',
  'requirements-litellm.txt', '.next/cache', '.next/dev', 'node_modules/.cache',
  'tsconfig.tsbuildinfo', 'package-lock.json', 'eslint.config.mjs',
  'postcss.config.mjs', 'video-panel-mockup.html', 'WINDOWS.md',
]) {
  assert.equal(fs.existsSync(path.join(payload, forbidden)), false, `payload contains forbidden root: ${forbidden}`);
  assert.equal(fs.existsSync(path.join(standalone, forbidden)), false, `standalone contains forbidden root: ${forbidden}`);
}
assert.equal(fs.existsSync(path.join(payload, 'desktop')), false, 'payload contains desktop shell source');
assert.equal(fs.existsSync(path.join(standalone, 'desktop')), false, 'standalone contains desktop shell source');
assert.equal(fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'launcher.sh')), false, 'Electron app still depends on legacy launcher.sh');
assert.equal(fs.existsSync(path.join(payload, 'dist-desktop', 'main.ts')), false, 'payload leaked desktop TypeScript');

const leaked = [];
const stack = [payload];
while (stack.length) {
  const current = stack.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) stack.push(absolute);
    else if (
      entry.name === 'workbench.db'
      || entry.name === '.env'
      || entry.name.startsWith('.env.')
      // Source-run entry points are meaningless in an installed app. The globs
      // used to require a hyphen, so start.command/start.sh/stop.command/stop.sh
      // and the legacy launcher helpers shipped inside the payload.
      || /^(?:start|stop).*\.(?:command|sh|cmd|ps1)$/.test(entry.name)
      || /^launcher\.(?:vbs|html)$/.test(entry.name)
      || entry.name.startsWith('create-desktop-shortcut.')
      || (absolute.includes(`${path.sep}dist-desktop${path.sep}`) && (entry.name.endsWith('.map') || entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
    ) leaked.push(absolute);
  }
}
assert.deepEqual(leaked, [], `payload leaked local data: ${leaked.join(', ')}`);

console.log('macos installer payload tests passed');
