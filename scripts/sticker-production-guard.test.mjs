import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-source-guard-'));
const production = path.join(source, 'production');
const data = path.join(source, 'data');
fs.mkdirSync(production);
fs.mkdirSync(data);
fs.writeFileSync(path.join(source, 'package.json'), '{}');
fs.writeFileSync(path.join(production, 'resource.txt'), 'production');
try {
  const probe = spawnSync(process.execPath, ['--require', path.resolve('scripts/team-server/sticker-production-guard.cjs'), '-e', `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const file = path.join(process.env.STICKER_TEST_SOURCE_ROOT, 'package.json');
    (async () => {
      assert.throws(() => fs.readFileSync(file), { code: 'ENOENT' });
      await assert.rejects(fs.promises.readFile(file), { code: 'ENOENT' });
      await new Promise(resolve => fs.readFile(file, error => { assert.equal(error.code, 'ENOENT'); resolve(); }));
      await new Promise(resolve => fs.open(file, 'r', error => { assert.equal(error.code, 'ENOENT'); resolve(); }));
      assert.throws(() => fs.createReadStream(file), { code: 'ENOENT' });
      const copy = path.join(process.env.CREATIVE_STUDIO_DATA_ROOT, 'copy.json');
      assert.throws(() => fs.copyFileSync(file, copy), { code: 'ENOENT' });
      assert.throws(() => fs.cpSync(file, copy), { code: 'ENOENT' });
      await assert.rejects(fs.promises.copyFile(file, copy), { code: 'ENOENT' });
      await assert.rejects(fs.promises.cp(file, copy), { code: 'ENOENT' });
      assert.equal(fs.existsSync(copy), false);
      assert.throws(() => require(file), { code: 'ENOENT' });
      assert.equal(fs.existsSync(file), false);
      await new Promise(resolve => fs.exists(file, exists => { assert.equal(exists, false); resolve(); }));
      const allowed = path.join(process.env.STICKER_TEST_STANDALONE, 'resource.txt');
      assert.equal(await fs.promises.readFile(allowed, 'utf8'), 'production');
      let bytes = ''; for await (const chunk of fs.createReadStream(allowed)) bytes += chunk;
      assert.equal(bytes, 'production');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', windowsHide: true, env: {
    ...process.env, STICKER_TEST_SOURCE_ROOT: source, STICKER_TEST_STANDALONE: production, CREATIVE_STUDIO_DATA_ROOT: data,
  } });
  assert.equal(probe.status, 0, probe.stderr);
  console.log('production source guard: sync, promise, callback, stream and require all blocked; production resource readable');
} finally { fs.rmSync(source, { recursive: true, force: true }); }
