import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appPath = path.resolve(process.argv[2] || 'dist/macos/产品素材工作台.app');
const dmgPath = path.resolve(process.argv[3] || 'dist/macos/产品素材工作台-0.3.0.dmg');
const payload = path.join(appPath, 'Contents', 'Resources', 'app');
const runtimeNode = path.join(payload, 'runtime', 'bin', 'node');
const ffmpeg = path.join(payload, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const ffprobe = path.join(payload, 'node_modules', 'ffprobe-static', 'bin', 'darwin', 'arm64', 'ffprobe');

for (const required of [
  appPath,
  path.join(appPath, 'Contents', 'MacOS', 'CreativeStudio'),
  path.join(payload, 'server.js'),
  path.join(payload, '.next', 'static'),
  path.join(payload, 'public'),
  runtimeNode,
  ffmpeg,
  dmgPath,
]) {
  assert.ok(fs.existsSync(required), `missing installer payload path: ${required}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

for (const binary of [path.join(appPath, 'Contents', 'MacOS', 'CreativeStudio'), runtimeNode, ffmpeg]) {
  assert.match(run('file', [binary]), /arm64/, `${binary} must be arm64`);
}
assert.match(run(runtimeNode, ['-p', 'process.version + " " + process.platform + " " + process.arch']), /^v22\..* darwin arm64/m);
run(runtimeNode, ['-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close(); console.log('better-sqlite3 ok')"], { cwd: payload });
run(runtimeNode, ['-e', "require('sharp')({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer().then(()=>console.log('sharp ok'))"], { cwd: payload });
assert.match(run(ffmpeg, ['-version']), /^ffmpeg version/m);
if (fs.existsSync(ffprobe)) {
  assert.match(run('file', [ffprobe]), /arm64/, 'packaged ffprobe must never be the mislabeled x86_64 binary');
  assert.match(run(ffprobe, ['-version']), /^ffprobe version/m);
}
run('codesign', ['--verify', '--deep', '--strict', appPath]);
run('hdiutil', ['verify', dmgPath]);

for (const forbidden of ['data', 'storage', 'outputs', 'docs', 'scripts', 'installer', '.git', '.claude']) {
  assert.equal(fs.existsSync(path.join(payload, forbidden)), false, `payload contains forbidden root: ${forbidden}`);
}

const leaked = [];
const stack = [payload];
while (stack.length) {
  const current = stack.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) stack.push(absolute);
    else if (entry.name === 'workbench.db' || entry.name === '.env' || entry.name.startsWith('.env.')) leaked.push(absolute);
  }
}
assert.deepEqual(leaked, [], `payload leaked local data: ${leaked.join(', ')}`);

console.log('macos installer payload tests passed');
