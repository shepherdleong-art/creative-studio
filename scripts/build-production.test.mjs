import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareBuildInputs, materializeBuildLinks, publishBuild } from './build-production.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-isolated-build-test-'));
const stage = path.join(root, '.cache', 'stage');
const write = (name, text = 'fixture') => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
try {
  write('app/page.tsx');
  write('package.json', '{}');
  write('node_modules/example/index.js');
  for (const name of ['storage/movie.mp4', 'data/workbench.db', 'outputs/film.mp4', '.env.local', '.venv-litellm/runtime.py', 'python-runtime/python.exe', '.next/old.txt']) write(name);
  fs.mkdirSync(stage, { recursive: true });
  prepareBuildInputs(root, stage);
  assert.equal(fs.readFileSync(path.join(stage, 'app/page.tsx'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(stage, 'node_modules/example/index.js'), 'utf8'), 'fixture');
  for (const name of ['storage', 'data', 'outputs', '.env.local', '.venv-litellm', 'python-runtime', '.next']) {
    assert.equal(fs.existsSync(path.join(stage, name)), false, `${name} must not enter build inputs`);
  }
  assert.throws(() => publishBuild(root, stage, () => {}), /未生成/);
  assert.ok(fs.existsSync(path.join(root, '.next/old.txt')));
  write('.cache/stage/.next/standalone/server.js', 'new build');
  const alias = path.join(stage, '.next/standalone/.next/node_modules/example-hashed');
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(path.join(stage, 'node_modules/example'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  materializeBuildLinks(stage);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), false);
  assert.throws(() => publishBuild(root, stage, () => { throw new Error('asset sync failed'); }), /asset sync failed/);
  assert.ok(fs.existsSync(path.join(root, '.next/old.txt')), 'sync failure must restore previous output');
  publishBuild(root, stage, () => {});
  assert.equal(fs.readFileSync(path.join(root, '.next/standalone/server.js'), 'utf8'), 'new build');
  assert.equal(fs.existsSync(path.join(root, '.next/old.txt')), false);
  fs.rmSync(stage, { recursive: true, force: true });
  assert.equal(fs.readFileSync(path.join(root, '.next/standalone/.next/node_modules/example-hashed/index.js'), 'utf8'), 'fixture', 'external package must survive deletion of the build stage');
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/example/index.js'), 'utf8'), 'fixture', 'stage cleanup must preserve original dependencies');
  assert.ok(fs.existsSync(path.join(root, 'storage/movie.mp4')));
  console.log('isolated production build tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
