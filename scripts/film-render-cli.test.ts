import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSyncHidden } from '../lib/spawn-hidden.ts';

const repo = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-cli-中文 空格-'));
const entry = path.join(repo, 'scripts/film-render.ts');
const invoke = (args: string[], env: Partial<NodeJS.ProcessEnv> = {}) => {
  const result = spawnSyncHidden(process.execPath, [entry, ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  return { status: result.status, data: JSON.parse(result.stdout.trim().split('\n').at(-1)!) };
};
try {
  assert.equal(invoke(['unknown']).status, 2);
  assert.equal(invoke(['render', 'missing.json']).status, 2);
  assert.equal(invoke(['--not-an-option']).status, 2);
  assert.deepEqual(invoke(['templates']).data.map((t: { id: string }) => t.id),
    ['classic', 'overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety']);
  const fake = path.join(root, 'packaging'), env = { CREATIVE_STUDIO_PACKAGING_DIR: fake };
  fs.mkdirSync(fake);
  const missing = invoke(['doctor'], env); assert.equal(missing.status, 3); assert.equal(missing.data.code, 'RUNTIME_MISSING');
  for (const file of ['package.json', 'package-lock.json', 'node_modules/hyperframes/package.json', 'node_modules/hyperframes/bin/hyperframes.mjs', 'win-hide-spawn.cjs']) {
    const dest = path.join(fake, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(repo, 'packaging', file), dest);
  }
  fs.mkdirSync(path.join(fake, 'node_modules/hyperframes/dist'));
  fs.writeFileSync(path.join(fake, 'node_modules/hyperframes/dist/version.js'), 'const CHROME_VERSION="152.0.7977.30";');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(repo, 'scripts/setup-packaging-runtime.mjs'), path.join(root, 'scripts/setup-packaging-runtime.mjs'));
  const chrome = path.join(fake, 'runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  fs.mkdirSync(path.dirname(chrome), { recursive: true }); fs.writeFileSync(chrome, 'fixture');
  for (const file of ['template.json', 'assets/fonts/SourceHanSansCN-VF.ttf', 'assets/scripts/gsap.min.js']) {
    const target = path.join(fake, 'templates/classic/1', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, 'packaging/templates/classic/1', file), target);
  }
  const font = path.join(fake, 'templates/classic/1/assets/fonts/SourceHanSansCN-VF.ttf');
  assert.ok(fs.existsSync(font), 'fixture font copied');
  const packageFile = path.join(fake, 'package.json'), before = fs.readFileSync(packageFile, 'utf8');
  fs.writeFileSync(packageFile, before.replace('0.8.134', '0.8.21'));
  const badVersion = invoke(['doctor'], env); assert.equal(badVersion.status, 3); assert.equal(badVersion.data.code, 'RUNTIME_VERSION');
  fs.writeFileSync(packageFile, before);
  fs.renameSync(font, font + '.saved');
  const missingFont = invoke(['doctor'], env); assert.equal(missingFont.status, 3); assert.equal(missingFont.data.code, 'ASSET_MISSING');
  fs.writeFileSync(font, 'wrong font');
  const badFont = invoke(['doctor'], env); assert.equal(badFont.status, 3); assert.equal(badFont.data.code, 'ASSET_HASH_MISMATCH');
  fs.copyFileSync(font + '.saved', font);
  const brokenChrome = invoke(['doctor'], env); assert.equal(brokenChrome.status, 3); assert.equal(brokenChrome.data.code, 'TOOL_UNAVAILABLE');
  const missingNode = invoke(['doctor'], { CREATIVE_STUDIO_PACKAGING_DIR: path.join(repo, 'packaging'), CREATIVE_STUDIO_PACKAGING_NODE: path.join(root, 'missing-node') });
  assert.equal(missingNode.status, 3); assert.equal(missingNode.data.code, 'TOOL_UNAVAILABLE');
  const fallback = invoke(['doctor'], { CREATIVE_STUDIO_PACKAGING_DIR: path.join(repo, 'packaging'), CREATIVE_STUDIO_FFMPEG: path.join(root, 'missing-ffmpeg') });
  assert.equal(fallback.status, 0, JSON.stringify(fallback.data));
  assert.ok(fallback.data.warnings.some((s: string) => s.includes('回退到')));
  assert.match(fallback.data.versions.node, /^v\d+\./);
  assert.equal(fallback.data.versions.cliNode, process.version);
  console.log('CLI passed: arbitrary cwd, input exit 2, six doctor failures exit 3, actual runtime Node, ffmpeg fallback warning');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
