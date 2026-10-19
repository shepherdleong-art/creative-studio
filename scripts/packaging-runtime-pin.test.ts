import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeInfo } from '../lib/film-render/runtime-info.ts';
const real = path.resolve('packaging');
assert.equal(runtimeInfo(real).hyperframesVersion, '0.8.134');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-runtime-'));
try {
  for (const file of ['package.json', 'package-lock.json', 'film-runtime.json', 'node_modules/hyperframes/package.json', 'node_modules/hyperframes/bin/hyperframes.mjs', 'win-hide-spawn.cjs']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(real, file), target);
  }
  fs.mkdirSync(path.join(root, 'runtime/chrome-headless-shell'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime/chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'), 'fixture');
  fs.mkdirSync(path.join(root, 'node_modules/hyperframes/dist'));
  fs.writeFileSync(path.join(root, 'node_modules/hyperframes/dist/version.js'), 'const CHROME_VERSION = "152.0.7977.30";');
  fs.cpSync(path.join(real, 'templates'), path.join(root, 'templates'), { recursive: true });
  assert.equal(runtimeInfo(root).chromeVersion, '152.0.7977.30', 'portable runtime needs no sibling setup script');
  const contractFile = path.join(root, 'film-runtime.json');
  const contract = fs.readFileSync(contractFile, 'utf8');
  for (const invalid of [{ schemaVersion: 2, hyperframesVersion: '0.8.134', chromeVersion: '152.0.7977.30' },
    { schemaVersion: 1, hyperframesVersion: '0.8.134', chromeVersion: 'wrong' }]) {
    fs.writeFileSync(contractFile, JSON.stringify(invalid));
    assert.throws(() => runtimeInfo(root), /契约版本不一致/);
  }
  fs.rmSync(contractFile);
  assert.throws(() => runtimeInfo(root), /缺少运行资源/);
  fs.writeFileSync(contractFile, contract);
  for (const file of ['package.json', 'package-lock.json', 'node_modules/hyperframes/package.json']) {
    const target = path.join(root, file), before = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, before.replaceAll('0.8.134', '0.8.21'));
    assert.throws(() => runtimeInfo(root), /版本不一致/); fs.writeFileSync(target, before);
  }
  fs.writeFileSync(path.join(root, 'node_modules/hyperframes/dist/version.js'), 'const CHROME_VERSION = "wrong";');
  assert.throws(() => runtimeInfo(root), /Chrome 版本不一致/);
  assert.throws(() => runtimeInfo(path.join(root, 'missing')), /缺少运行资源/);
  console.log('Runtime pins passed: declared, lock, installed and Chrome versions; missing runtime');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
