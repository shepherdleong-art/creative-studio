import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (process.platform !== 'win32') {
  console.log('Windows packaging probe shim: skipped on this platform');
} else if (process.argv[2] === '--child') {
  const cp = require('node:child_process');
  const probe = require('ffprobe-static').path;
  const args = ['-v', 'error', '-show_streams', '-of', 'json', process.argv[3]];
  for (let i = 0; i < 8; i++) {
    const sync = cp.spawnSync(probe, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    assert.equal(sync.status, 0, sync.error?.message || sync.stderr);
    assert.equal(JSON.parse(sync.stdout).streams[0].sample_rate, '48000');
    await new Promise((resolve, reject) => {
      const child = cp.spawn(probe, args, { windowsHide: true });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Async probe timed out')); }, 5_000);
      child.stdout.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer);
        try { assert.equal(code, 0); assert.equal(JSON.parse(output).streams[0].sample_rate, '48000'); resolve(); }
        catch (error) { reject(error); }
      });
    });
  }
  const invalid = cp.spawnSync(probe, ['-v', 'error', process.argv[3] + '.missing'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  assert.notEqual(invalid.status, 0, 'Shim must not hide real media failures');
  assert.ok(invalid.stderr.length > 0);
  console.log('16 nested sync/async ffprobe calls passed; errors preserved');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-probe-'));
  try {
    const wave = Buffer.alloc(44 + 96000);
    wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(96000, 28); wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(96000, 40);
    const source = path.join(root, '探针 测试.wav'); fs.writeFileSync(source, wave);
    const result = spawnSync(process.execPath, ['--require', path.resolve('packaging/win-hide-spawn.cjs'), path.resolve('scripts/packaging-probe.test.mjs'), '--child', source], {
      env: { ...process.env, CREATIVE_STUDIO_DATA_ROOT: root }, encoding: 'utf8', windowsHide: true, timeout: 100_000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    console.log(result.stdout.trim());
    assert.deepEqual(fs.readdirSync(path.join(root, 'storage/packaging/renders')), [], 'Probe scratch must be removed');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
